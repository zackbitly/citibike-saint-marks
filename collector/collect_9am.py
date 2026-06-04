"""
Collect one 9 AM (America/New_York) Citibike snapshot for the in-radius
stations and append it to data/snapshots_9am.jsonl.

Triggered on time by an external, DST-aware scheduler that fires GitHub's
workflow_dispatch at 9:00 AM America/New_York. workflow_dispatch runs within
seconds, so the NY hour is reliably 9 when we read — unlike GitHub's `schedule`
trigger, which routinely delays runs by hours (blowing past the hour guard) or
drops them entirely. The 13:05/14:05 UTC schedule entries remain only as a
best-effort fallback.

Two guards keep the series clean: we only WRITE when the current New York hour
is 9, and we skip if a snapshot for today's NY date is already recorded — so a
late fallback run can never double-write a day the dispatch already captured.
Pass --force to bypass both guards (manual tests).

Only real GBFS readings are stored: no estimating or inferring.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

GBFS_STATUS = "https://gbfs.citibikenyc.com/gbfs/en/station_status.json"
NY = ZoneInfo("America/New_York")

HERE = os.path.dirname(__file__)
STATIONS_PATH = os.path.join(HERE, "..", "data", "stations.json")
OUT_PATH = os.path.join(HERE, "..", "data", "snapshots_9am.jsonl")


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "citibike-saint-marks/1.0 (collector)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def last_captured_ny_date(out_path):
    """Return the NY date (YYYY-MM-DD) of the most recent snapshot, or None."""
    if not os.path.exists(out_path):
        return None
    last = None
    with open(out_path) as f:
        for line in f:
            line = line.strip()
            if line:
                last = line
    if not last:
        return None
    try:
        return json.loads(last)["captured_at_ny"][:10]
    except (ValueError, KeyError):
        return None


def main():
    force = "--force" in sys.argv
    now_ny = datetime.now(NY)
    out = os.path.abspath(OUT_PATH)

    if not force and now_ny.hour != 9:
        print(f"NY time is {now_ny:%H:%M}; not the 9 AM window. Skipping (no write).")
        return

    if not force and last_captured_ny_date(out) == f"{now_ny:%Y-%m-%d}":
        print(f"Snapshot for {now_ny:%Y-%m-%d} already recorded. Skipping (no double-write).")
        return

    with open(os.path.abspath(STATIONS_PATH)) as f:
        wanted = {s["station_id"]: s["name"] for s in json.load(f)["stations"]}

    status = fetch_json(GBFS_STATUS)
    by_id = {s["station_id"]: s for s in status["data"]["stations"]}

    stations = {}
    for sid in wanted:
        s = by_id.get(sid)
        if not s:
            continue  # no live report for this station right now; omit rather than guess
        ebikes = s.get("num_ebikes_available", 0) or 0
        total = s.get("num_bikes_available", 0) or 0
        stations[sid] = {
            "name": wanted[sid],
            "classic": max(total - ebikes, 0),
            "ebikes": ebikes,
            "total": total,
            "docks": s.get("num_docks_available", 0) or 0,
            "is_renting": 1 if (s.get("is_renting") and s.get("is_installed")) else 0,
        }

    record = {
        "captured_at_ny": now_ny.isoformat(timespec="seconds"),
        "captured_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "feed_last_updated": status.get("last_updated"),
        "station_count": len(stations),
        "stations": stations,
    }

    with open(out, "a") as f:
        f.write(json.dumps(record) + "\n")
    print(f"Wrote 9 AM snapshot ({now_ny:%Y-%m-%d %H:%M %Z}) for {len(stations)} stations -> {out}")


if __name__ == "__main__":
    main()
