"""
Compute the set of Citibike stations within a 7-minute WALK of a home
location in Crown Heights, Brooklyn, and bake them into data/stations.json.

Walking time is real pedestrian routing from the keyless Valhalla
instance (valhalla1.openstreetmap.de), not a straight-line estimate.
This runs once (re-run if Citibike adds/moves nearby stations);
the website never calls Valhalla at runtime.

Privacy note: the committed origin (and the displayed map pin) is rounded to
~100 m. The committed station list and walk times were generated from the
precise home address, which is intentionally not stored in this public repo.
Set ORIGIN_LAT/ORIGIN_LON to the exact coordinates locally to reproduce.

Usage:  python3 build/build_stations.py
"""

import json
import math
import os
import subprocess
import urllib.request

# Home location, rounded to ~100 m for privacy (see module docstring).
ORIGIN_LAT = 40.675
ORIGIN_LON = -73.952

WALK_LIMIT_SECONDS = 7 * 60          # 7-minute walk
PREFILTER_METERS = 1000              # straight-line cap to keep the matrix small

GBFS_INFO = "https://gbfs.citibikenyc.com/gbfs/en/station_information.json"
VALHALLA = "https://valhalla1.openstreetmap.de/sources_to_targets"

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "stations.json")


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "citibike-saint-marks/1.0 (build_stations)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def post_json(url, data):
    # Routed through curl: the system Python's old OpenSSL can't complete the
    # TLS handshake with the Valhalla host, but curl can.
    out = subprocess.run(
        ["curl", "-s", "--max-time", "60", url, "-H", "Content-Type: application/json",
         "--data-binary", json.dumps(data)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def haversine_m(lat1, lon1, lat2, lon2):
    R = 6371000
    p = math.radians
    dlat = p(lat2 - lat1)
    dlon = p(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p(lat1)) * math.cos(p(lat2)) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def main():
    info = fetch_json(GBFS_INFO)["data"]["stations"]

    # Prefilter by straight-line distance so the Valhalla matrix stays small.
    candidates = []
    for s in info:
        d = haversine_m(ORIGIN_LAT, ORIGIN_LON, s["lat"], s["lon"])
        if d <= PREFILTER_METERS:
            candidates.append(s)
    print(f"{len(candidates)} candidate stations within {PREFILTER_METERS}m straight-line")

    # One matrix call: origin -> every candidate, pedestrian costing.
    payload = {
        "sources": [{"lat": ORIGIN_LAT, "lon": ORIGIN_LON}],
        "targets": [{"lat": s["lat"], "lon": s["lon"]} for s in candidates],
        "costing": "pedestrian",
    }
    matrix = post_json(VALHALLA, payload)
    row = matrix["sources_to_targets"][0]

    stations = []
    for cell, s in zip(row, candidates):
        secs = cell.get("time")
        if secs is None or secs > WALK_LIMIT_SECONDS:
            continue
        stations.append({
            "station_id": s["station_id"],
            "name": s["name"],
            "lat": s["lat"],
            "lng": s["lon"],
            "capacity": s.get("capacity", 0),
            "walk_seconds": int(secs),
            "walk_min": round(secs / 60, 1),
            "walk_meters": round(cell.get("distance", 0) * 1000),
        })

    stations.sort(key=lambda x: x["walk_seconds"])

    out = {
        "origin": {
            "label": "Crown Heights, Brooklyn (approx.)",
            "lat": ORIGIN_LAT,
            "lng": ORIGIN_LON,
        },
        "walk_limit_minutes": 7,
        "routing": "valhalla pedestrian (valhalla1.openstreetmap.de)",
        "generated_note": "Walking times are real pedestrian routes computed once at build time.",
        "stations": stations,
    }
    with open(os.path.abspath(OUT_PATH), "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {len(stations)} stations (<= 7 min walk) to {os.path.abspath(OUT_PATH)}")
    for s in stations:
        print(f"  {s['walk_min']:>4} min  {s['walk_meters']:>4}m  {s['name']}")


if __name__ == "__main__":
    main()
