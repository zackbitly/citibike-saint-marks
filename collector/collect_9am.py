"""
Collect one 9 AM (America/New_York) Citibike snapshot for the in-radius
stations and append it to data/snapshots_9am.jsonl.

Run by GitHub Actions at 13:05 and 14:05 UTC. GitHub cron is UTC and
DST-unaware; 9 AM New York is 13:00 UTC in summer (EDT) and 14:00 UTC in
winter (EST). To stay correct year-round we fire in both the 13:00 and 14:00
UTC hours but only WRITE when the current New York hour is 9 — so exactly one
run per day records a snapshot. Firing at :05 leaves ~55 min of slack inside
the 9 AM hour so GitHub's scheduled-run delay won't push us past the guard.
Pass --force to bypass the hour guard (manual tests).

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


def main():
    force = "--force" in sys.argv
    now_ny = datetime.now(NY)

    if not force and now_ny.hour != 9:
        print(f"NY time is {now_ny:%H:%M}; not the 9 AM window. Skipping (no write).")
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

    out = os.path.abspath(OUT_PATH)
    with open(out, "a") as f:
        f.write(json.dumps(record) + "\n")
    print(f"Wrote 9 AM snapshot ({now_ny:%Y-%m-%d %H:%M %Z}) for {len(stations)} stations -> {out}")


if __name__ == "__main__":
    main()
