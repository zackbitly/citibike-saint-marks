"""
Turn a personal Citibike/Lyft ride-history export into the small JSON the
rides map reads (data/my_rides.json).

There is no live/public API for *personal* rides — the GBFS feed is system-wide
only. So your own ride history has to come from your account export (the
website no longer has a one-click CSV export; this parses whatever CSV you can
obtain, e.g. a Lyft "download my data" archive).

This script is tolerant of the different export schemas: it auto-detects the
station-name, time, and (optional) lat/lng columns by inspecting the header.
Station coordinates that aren't already in the file are resolved from the GBFS
station_information feed — the same data source family the live page uses
(app.js fetches .../gbfs/en/station_status.json; the sibling
.../gbfs/en/station_information.json carries names + lat/lng for every station).

Real data only: a ride whose stations can't be located (renamed/retired station
not in GBFS, no coords in the file) is dropped and its station name is reported
under "unmatched_stations" — never guessed.

Usage:
  python3 build/build_rides.py build/my_rides_raw.csv
  python3 build/build_rides.py path/to/export.csv --out data/my_rides.json
"""

import csv
import json
import os
import sys
import urllib.request
from collections import Counter
from datetime import datetime

HERE = os.path.dirname(__file__)
DEFAULT_OUT = os.path.join(HERE, "..", "data", "my_rides.json")
STATION_INFO = "https://gbfs.citibikenyc.com/gbfs/en/station_information.json"


def load_gbfs_coords():
    """name -> (lat, lng) for every current Citibike station."""
    req = urllib.request.Request(
        STATION_INFO, headers={"User-Agent": "citibike-saint-marks/1.0 (build_rides)"}
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.load(r)
    coords = {}
    for s in data["data"]["stations"]:
        name = (s.get("name") or "").strip()
        if name and "lat" in s and "lon" in s:
            coords[name] = (float(s["lat"]), float(s["lon"]))
    return coords


def find_col(fieldnames, *must_contain_groups):
    """Return the first header that, lowercased, contains every token in any
    one of the supplied groups. e.g. find_col(fn, ("start","station","name"))."""
    low = {fn: fn.lower() for fn in fieldnames}
    for group in must_contain_groups:
        for fn, l in low.items():
            if all(tok in l for tok in group):
                return fn
    return None


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# Common start-time shapes across Lyft/Citibike exports. Tried in order after
# datetime.fromisoformat. (Python may be 3.9 here, so don't rely on 3.11 ISO
# parsing — explicit strptime formats keep it portable.)
DT_FORMATS = (
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M",
    "%Y-%m-%d", "%m/%d/%Y",
)


def parse_started(raw):
    """Parse an export's start-time cell into a datetime, or None.

    Times are interpreted as-is (assumed already local) — no timezone
    conversion. build/my_rides_raw.csv is written in America/New_York, so the
    weekday/hour derived from this are correct for NYC.
    """
    s = (raw or "").strip()
    if not s:
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        pass
    for fmt in DT_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    src = args[0]
    out_path = DEFAULT_OUT
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    if not os.path.exists(src):
        print(f"ERROR: CSV not found: {src}")
        sys.exit(1)

    with open(src, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames or []

        c_sname = find_col(fields, ("start", "station", "name"), ("start", "station"))
        c_ename = find_col(fields, ("end", "station", "name"), ("end", "station"))
        c_stime = find_col(fields, ("start", "time"), ("start", "date"), ("started",))
        c_slat = find_col(fields, ("start", "lat"))
        c_slng = find_col(fields, ("start", "lng"), ("start", "lon"))
        c_elat = find_col(fields, ("end", "lat"))
        c_elng = find_col(fields, ("end", "lng"), ("end", "lon"))
        c_dur = find_col(fields, ("duration",), ("trip", "minutes"))

        if not c_sname or not c_stime:
            print(f"ERROR: couldn't find start-station-name / start-time columns.")
            print(f"  headers seen: {fields}")
            sys.exit(1)
        print(f"Columns: start='{c_sname}' end='{c_ename}' time='{c_stime}'"
              + (f" coords=yes" if c_slat else " coords=no"))

        rows = list(reader)

    coords = load_gbfs_coords()
    print(f"GBFS: {len(coords)} stations with coordinates")

    rides = []
    unmatched = Counter()

    def locate(name, lat_col, lng_col, row):
        # Prefer coords present in the export; fall back to GBFS by name.
        if lat_col and lng_col:
            lat, lng = to_float(row.get(lat_col)), to_float(row.get(lng_col))
            if lat is not None and lng is not None and (lat or lng):
                return lat, lng
        if name in coords:
            return coords[name]
        if name:
            unmatched[name] += 1
        return None

    for row in rows:
        sname = (row.get(c_sname) or "").strip()
        ename = (row.get(c_ename) or "").strip() if c_ename else ""
        spt = locate(sname, c_slat, c_slng, row)
        if spt is None:
            continue
        # Missing end -> treat as a round trip back to start.
        ept = locate(ename, c_elat, c_elng, row) if ename else spt
        if ept is None:
            continue
        raw_time = (row.get(c_stime) or "").strip()
        dt = parse_started(raw_time)
        # A ":" in the source means a real time was present (not a bare date).
        has_time = dt is not None and ":" in raw_time
        if dt is not None:
            date = dt.strftime("%Y-%m-%d")
        else:
            date = raw_time[:10]  # "YYYY-MM-DD..." or "MM/DD/YYYY"
            if "/" in date:  # normalize US-style MM/DD/YYYY
                try:
                    m, d, y = date.split("/")
                    date = f"{y}-{int(m):02d}-{int(d):02d}"
                except ValueError:
                    pass
        started = dt.strftime("%Y-%m-%d %H:%M:%S") if has_time else None
        hour = dt.hour if has_time else None
        dow = dt.weekday() if has_time else None  # 0=Mon .. 6=Sun
        minutes = to_float(row.get(c_dur)) if c_dur else None
        rides.append({
            "date": date,
            "started": started,
            "hour": hour,
            "dow": dow,
            "start": {"name": sname or "(unknown)", "lat": spt[0], "lng": spt[1]},
            "end": {"name": ename or sname or "(unknown)", "lat": ept[0], "lng": ept[1]},
            "minutes": round(minutes, 1) if minutes is not None else None,
        })

    rides.sort(key=lambda r: r["date"])
    out = {
        "source": "Personal Citibike/Lyft ride-history export",
        "generated_from": os.path.basename(src),
        "count": len(rides),
        "unmatched_stations": [n for n, _ in unmatched.most_common()],
        "rides": rides,
    }
    out_abs = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    with open(out_abs, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {len(rides)} ride(s) -> {out_abs}")
    if unmatched:
        total = sum(unmatched.values())
        print(f"  skipped {total} ride-endpoint(s) at {len(unmatched)} station(s) "
              f"not found in GBFS (no coords): {', '.join(list(unmatched)[:8])}"
              + (" ..." if len(unmatched) > 8 else ""))


if __name__ == "__main__":
    main()
