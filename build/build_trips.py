"""
Aggregate daily Citibike trip counts (departures and arrivals) for the
in-radius stations, from Citibike's official monthly trip-history files.

Source: Citibike System Data — https://s3.amazonaws.com/tripdata/
Each monthly zip (YYYYMM-citibike-tripdata.zip) holds one row per trip with
start/end station names and timestamps. We count, per station per calendar
day: trips STARTING there ("out") and trips ENDING there ("in").

This is real published trip data — no estimating or inferring. (Differencing
live bike-count snapshots is NOT used: count changes also reflect rebalancing
trucks, so they are not trips.)

Note: trip files are published ~1-3 weeks after a month ends, so this data is
historical, not live. Files are large (~150 MB zipped / ~750 MB each) and are
downloaded to a temp dir; only the small aggregate JSON is committed.

Usage:
  python3 build/build_trips.py 202604 202603        # rebuild these months
  python3 build/build_trips.py --latest             # previous calendar month
"""

import csv
import glob
import io
import json
import os
import sys
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date

HERE = os.path.dirname(__file__)
STATIONS_PATH = os.path.join(HERE, "..", "data", "stations.json")
OUT_PATH = os.path.join(HERE, "..", "data", "trips_daily.json")
BASE = "https://s3.amazonaws.com/tripdata/{ym}-citibike-tripdata.zip"
WORKDIR = os.path.join(tempfile.gettempdir(), "citibike_trips")


def prev_month_ym():
    t = date.today()
    y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
    return f"{y}{m:02d}"


def download(ym):
    os.makedirs(WORKDIR, exist_ok=True)
    zpath = os.path.join(WORKDIR, f"{ym}.zip")
    if not os.path.exists(zpath):
        url = BASE.format(ym=ym)
        print(f"  downloading {url} ...")
        req = urllib.request.Request(url, headers={"User-Agent": "citibike-saint-marks/1.0 (build_trips)"})
        with urllib.request.urlopen(req, timeout=600) as r, open(zpath, "wb") as f:
            f.write(r.read())
    with zipfile.ZipFile(zpath) as z:
        z.extractall(WORKDIR)
    # Inner CSVs are named "<ym>-citibike-tripdata_1.csv" (older) or
    # "<ym>-citibike-tripdata-part1.csv" (newer); the glob covers both.
    return zpath, sorted(glob.glob(os.path.join(WORKDIR, f"{ym}-citibike-tripdata*.csv")))


def aggregate_month(ym, names, keep_files=False):
    # records[date][station] = {"out": n, "in": n}
    recs = defaultdict(lambda: defaultdict(lambda: {"out": 0, "in": 0}))
    rows = 0
    zpath, csvs = download(ym)
    for fn in csvs:
        with open(fn, newline="") as f:
            reader = csv.reader(f)
            header = next(reader)
            ix = {c: i for i, c in enumerate(header)}
            i_ss, i_es = ix["start_station_name"], ix["end_station_name"]
            i_st, i_et = ix["started_at"], ix["ended_at"]
            for row in reader:
                rows += 1
                if row[i_ss] in names:
                    recs[row[i_st][:10]][row[i_ss]]["out"] += 1
                if row[i_es] in names:
                    recs[row[i_et][:10]][row[i_es]]["in"] += 1
    if not keep_files:
        # Bound disk usage when building many months: drop the extracted CSVs
        # and the zip once aggregated (re-downloaded on demand if needed).
        for fn in csvs:
            os.remove(fn)
        if os.path.exists(zpath):
            os.remove(zpath)
    print(f"  {ym}: scanned {rows:,} trips; {len(recs)} day(s) touched our stations")
    return recs


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    months = [prev_month_ym()] if args == ["--latest"] else args

    stations = json.load(open(os.path.abspath(STATIONS_PATH)))["stations"]
    names = {s["name"] for s in stations}

    # Load existing aggregate (so we can merge / refresh specific months).
    existing = {"daily": []}
    if os.path.exists(os.path.abspath(OUT_PATH)):
        existing = json.load(open(os.path.abspath(OUT_PATH)))
    # Keep records whose month is NOT being rebuilt.
    rebuild = set(months)
    kept = [d for d in existing.get("daily", []) if d["date"][:7].replace("-", "") not in rebuild]

    # Merge all processed months into one record per (date, station). This
    # correctly combines midnight-crossing arrivals: e.g. a trip that starts
    # 2026-03-31 and ends 2026-04-01 is in the March file but dated 04-01.
    combined = defaultdict(lambda: {"out": 0, "in": 0})
    for ym in months:
        for d, sts in aggregate_month(ym, names).items():
            for st, c in sts.items():
                combined[(d, st)]["out"] += c["out"]
                combined[(d, st)]["in"] += c["in"]

    # Only keep dates that fall inside a scanned month (drops the stray
    # 1st-of-next-month spillover, which would otherwise be a partial day).
    wanted_ym = {f"{m[:4]}-{m[4:]}" for m in months}
    new_records = [
        {"date": d, "station": st, "out": c["out"], "in": c["in"]}
        for (d, st), c in combined.items()
        if d[:7] in wanted_ym
    ]

    daily = sorted(kept + new_records, key=lambda x: (x["date"], x["station"]))
    months_included = sorted({d["date"][:7] for d in daily})

    out = {
        "source": "Citibike System Data — official monthly trip history (https://s3.amazonaws.com/tripdata/)",
        "note": "Real published trip counts (no estimating). Updated monthly; data lags the current date by a few weeks. Arrival counts on the 1st of the earliest month may omit a few trips that began before midnight on the last day of the prior (unscanned) month.",
        "stations": sorted(names),
        "months_included": months_included,
        "daily": daily,
    }
    with open(os.path.abspath(OUT_PATH), "w") as f:
        json.dump(out, f, indent=2)
    print(f"Wrote {len(daily)} day-station records across {len(months_included)} month(s) -> {os.path.abspath(OUT_PATH)}")


if __name__ == "__main__":
    main()
