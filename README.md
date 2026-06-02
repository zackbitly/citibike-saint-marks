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

## Data integrity

Only two data sources are ever used: the **live GBFS feed** and **saved
snapshots**. There is no modeling, interpolation, or inference of any kind.
`classic = num_bikes_available − num_ebikes_available` and every other figure is
a verbatim GBFS reading.

## How it's built

| Piece | File | Notes |
|-------|------|-------|
| In-radius station set | `build/build_stations.py` → `data/stations.json` | Real pedestrian walking times from Valhalla, computed once. Re-run if nearby stations change. |
| Live page | `index.html`, `app.js`, `styles.css` | Static; fetches GBFS directly in the browser (GBFS sends `Access-Control-Allow-Origin: *`). |
| 9 AM collector | `collector/collect_9am.py` | Appends one snapshot when NY time is 9 AM. |
| Scheduler | `.github/workflows/collect-9am.yml` | GitHub Actions cron at 12:55 & 13:55 UTC (DST-proof) + manual `workflow_dispatch`. |

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
```

## Deploy

Push to GitHub and enable **Pages → Deploy from branch → `main` / root**.
The Actions workflow collects and commits a snapshot each morning.
