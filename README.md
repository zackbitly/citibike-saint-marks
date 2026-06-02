# Citibike near Crown Heights, Brooklyn

A single live webpage showing Citibike availability for every station within a
**7-minute walk** of an origin point in Crown Heights, Brooklyn — plus the **average
availability at 9 AM** over a date range you choose.

**Live demo:** https://zackbitly.github.io/citibike-saint-marks/

## What it shows

- **Live table + map.** Classic bikes, e-bikes, docks, and totals for each
  in-radius station, refreshed every 60 s straight from the
  [Citibike GBFS feed](https://gbfs.citibikenyc.com/gbfs/gbfs.json). The map uses
  Citibike-app-style markers (color by bike count, ⚡ badge for e-bikes).
- **9 AM averages.** Averages computed only from real 9 AM (America/New_York)
  snapshots saved daily into `data/snapshots_9am.jsonl`. Pick any window
  (e.g. May 1 – May 15 2026); each station shows its average and the number of
  collection days (`n`). Stations with no snapshot in the window show
  "no data" — never a guessed zero.
- **Trips per day by station.** Departures (trips starting) and arrivals (trips
  ending) per station, from Citibike's official
  [monthly trip-history files](https://s3.amazonaws.com/tripdata/). Pick a date
  range to see departures/day, arrivals/day, net/day, and totals. This data is
  published monthly and lags the current date by a few weeks — it is historical,
  not live.

## Data integrity

Only real Citibike data is used — the **live GBFS feed**, **saved 9 AM
snapshots**, and the **official monthly trip-history files**. There is no
modeling, interpolation, or inference of any kind. `classic =
num_bikes_available − num_ebikes_available`; trip counts are direct row counts
from the published trip files. (Trips are *not* inferred by differencing
bike-count snapshots — count changes also reflect rebalancing trucks.)

## How it's built

| Piece | File | Notes |
|-------|------|-------|
| In-radius station set | `build/build_stations.py` → `data/stations.json` | Real pedestrian walking times from Valhalla, computed once. Re-run if nearby stations change. |
| Live page | `index.html`, `app.js`, `styles.css` | Static; fetches GBFS directly in the browser (GBFS sends `Access-Control-Allow-Origin: *`). |
| 9 AM collector | `collector/collect_9am.py` | Appends one snapshot when NY time is 9 AM. |
| 9 AM scheduler | `.github/workflows/collect-9am.yml` | GitHub Actions cron at 12:55 & 13:55 UTC (DST-proof) + manual `workflow_dispatch`. |
| Trip aggregator | `build/build_trips.py` → `data/trips_daily.json` | Downloads monthly trip files, counts daily departures/arrivals for our stations. |
| Trip scheduler | `.github/workflows/collect-trips.yml` | GitHub Actions cron on the 6th of each month (pulls the previous month) + manual `workflow_dispatch`. |

The collector runs entirely on GitHub Actions — there is no local machine or
long-running server to silently stop collecting.

## Run locally

```bash
# (re)compute the in-radius station set
python3 build/build_stations.py

# serve the static site
python3 -m http.server 8000
# open http://localhost:8000

# collect a snapshot now (bypasses the 9 AM guard)
python3 collector/collect_9am.py --force

# (re)build trip-per-day data for specific months (downloads ~150 MB each)
python3 build/build_trips.py 202604 202603 202602
```

## Deploy

Push to GitHub and enable **Pages → Deploy from branch → `main` / root**.
The Actions workflow collects and commits a snapshot each morning.
