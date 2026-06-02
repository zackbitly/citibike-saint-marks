"use strict";

const GBFS_STATUS = "https://gbfs.citibikenyc.com/gbfs/en/station_status.json";
const REFRESH_MS = 60 * 1000;

let STATIONS = [];        // baked in-radius stations (from data/stations.json)
let STATION_IDS = new Set();
let map, markerLayer, originMarker;

// ---------- helpers ----------

function bucket(total) {
  if (total >= 6) return "good";
  if (total >= 3) return "ok";
  if (total >= 1) return "low";
  return "empty";
}

function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// ---------- live view ----------

async function loadStations() {
  const res = await fetch("data/stations.json", { cache: "no-store" });
  const data = await res.json();
  STATIONS = data.stations;
  STATION_IDS = new Set(STATIONS.map((s) => s.station_id));
  document.querySelector("#live-totals .station").textContent =
    `Total (${STATIONS.length} stations)`;
  initMap(data.origin);
  return data;
}

function initMap(origin) {
  map = L.map("map", { scrollWheelZoom: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  originMarker = L.marker([origin.lat, origin.lng], {
    icon: L.divIcon({ className: "", html: '<div class="cb-origin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`<strong>${origin.label}</strong>`);

  const pts = STATIONS.map((s) => [s.lat, s.lng]).concat([[origin.lat, origin.lng]]);
  map.fitBounds(L.latLngBounds(pts).pad(0.15));
}

async function loadLive() {
  const statusEl = document.getElementById("live-status");
  try {
    const res = await fetch(GBFS_STATUS, { cache: "no-store" });
    const json = await res.json();
    const byId = new Map(json.data.stations.map((s) => [s.station_id, s]));

    const rows = STATIONS.map((st) => {
      const s = byId.get(st.station_id);
      const ebikes = s ? (s.num_ebikes_available || 0) : 0;
      const total = s ? (s.num_bikes_available || 0) : 0;
      const classic = Math.max(total - ebikes, 0);
      const docks = s ? (s.num_docks_available || 0) : 0;
      const renting = s ? !!s.is_renting && !!s.is_installed : false;
      return { st, ebikes, total, classic, docks, renting, present: !!s };
    });

    renderLiveTable(rows);
    renderMarkers(rows);

    // GBFS last_updated is a unix timestamp for the whole feed.
    const fed = json.last_updated ? new Date(json.last_updated * 1000) : new Date();
    statusEl.textContent = `Live as of ${fmtTime(fed)} · source: Citibike GBFS`;
  } catch (err) {
    statusEl.textContent = "Could not load live data — will retry.";
    console.error(err);
  }
}

function renderLiveTable(rows) {
  const tbody = document.getElementById("live-tbody");
  tbody.innerHTML = "";
  const totals = { classic: 0, ebikes: 0, total: 0, docks: 0 };

  for (const r of rows) {
    const tr = document.createElement("tr");
    const flag = r.present
      ? (r.renting ? "" : '<span class="flag">not renting</span>')
      : '<span class="flag">no report</span>';
    tr.innerHTML =
      `<td class="station">${r.st.name}${flag}</td>` +
      `<td class="num">${r.st.walk_min} min</td>` +
      `<td class="num">${r.classic}</td>` +
      `<td class="num">${r.ebikes}</td>` +
      `<td class="num">${r.total}</td>` +
      `<td class="num">${r.docks}</td>`;
    tbody.appendChild(tr);
    totals.classic += r.classic;
    totals.ebikes += r.ebikes;
    totals.total += r.total;
    totals.docks += r.docks;
  }

  const foot = document.getElementById("live-totals");
  foot.querySelector('[data-k="classic"]').textContent = totals.classic;
  foot.querySelector('[data-k="ebikes"]').textContent = totals.ebikes;
  foot.querySelector('[data-k="total"]').textContent = totals.total;
  foot.querySelector('[data-k="docks"]').textContent = totals.docks;
}

function renderMarkers(rows) {
  markerLayer.clearLayers();
  for (const r of rows) {
    const cls = bucket(r.total);
    const ebikeBadge = r.ebikes > 0 ? `<span class="cb-ebike">&#9889;${r.ebikes}</span>` : "";
    const icon = L.divIcon({
      className: "",
      html: `<div class="cb-marker ${cls}">${r.total}${ebikeBadge}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    const popup =
      `<strong>${r.st.name}</strong><br>` +
      `${r.st.walk_min} min walk<br>` +
      `Classic: ${r.classic} &middot; E-bikes: ${r.ebikes}<br>` +
      `Total bikes: ${r.total} &middot; Docks: ${r.docks}` +
      (r.present && !r.renting ? "<br><em>Not currently renting</em>" : "") +
      (!r.present ? "<br><em>No live report</em>" : "");
    L.marker([r.st.lat, r.st.lng], { icon }).bindPopup(popup).addTo(markerLayer);
  }
}

// ---------- 9am averages ----------

let SNAPSHOTS = [];   // [{date:'YYYY-MM-DD', stations:{id:{classic,ebikes,total,docks}}}]

async function loadSnapshots() {
  try {
    const res = await fetch("data/snapshots_9am.jsonl", { cache: "no-store" });
    if (!res.ok) { SNAPSHOTS = []; }
    else {
      const text = await res.text();
      SNAPSHOTS = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    }
  } catch (_) {
    SNAPSHOTS = [];
  }
  setupRangeDefaults();
  renderAverages();
}

function snapDate(s) {
  // captured_at_ny is ISO local NY time, e.g. "2026-06-02T09:01:00-04:00"
  return (s.captured_at_ny || s.captured_at_utc || "").slice(0, 10);
}

function setupRangeDefaults() {
  const fromEl = document.getElementById("from-date");
  const toEl = document.getElementById("to-date");
  const dates = SNAPSHOTS.map(snapDate).filter(Boolean).sort();
  if (dates.length) {
    if (!fromEl.value) fromEl.value = dates[0];
    if (!toEl.value) toEl.value = dates[dates.length - 1];
  } else {
    // No data yet: default to the project start window.
    if (!fromEl.value) fromEl.value = "2026-06-02";
    if (!toEl.value) toEl.value = "2026-06-02";
  }
}

function renderAverages() {
  const from = document.getElementById("from-date").value;
  const to = document.getElementById("to-date").value;
  const summary = document.getElementById("range-summary");
  const tbody = document.getElementById("avg-tbody");
  tbody.innerHTML = "";

  const inRange = SNAPSHOTS.filter((s) => {
    const d = snapDate(s);
    return d && (!from || d >= from) && (!to || d <= to);
  });

  summary.textContent = SNAPSHOTS.length === 0
    ? "No 9 AM snapshots collected yet — accumulating daily from 2026-06-02."
    : `${inRange.length} collection day(s) in range ${from} → ${to}.`;

  for (const st of STATIONS) {
    const vals = { classic: [], ebikes: [], total: [], docks: [] };
    for (const snap of inRange) {
      const rec = snap.stations && snap.stations[st.station_id];
      if (!rec) continue;
      vals.classic.push(rec.classic);
      vals.ebikes.push(rec.ebikes);
      vals.total.push(rec.total);
      vals.docks.push(rec.docks);
    }
    const n = vals.total.length;
    const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);

    const tr = document.createElement("tr");
    if (n === 0) {
      tr.innerHTML =
        `<td class="station">${st.name}</td>` +
        `<td class="num muted-cell" colspan="4">no data in range</td>` +
        `<td class="num">0</td>`;
    } else {
      tr.innerHTML =
        `<td class="station">${st.name}</td>` +
        `<td class="num">${avg(vals.classic)}</td>` +
        `<td class="num">${avg(vals.ebikes)}</td>` +
        `<td class="num">${avg(vals.total)}</td>` +
        `<td class="num">${avg(vals.docks)}</td>` +
        `<td class="num">${n}</td>`;
    }
    tbody.appendChild(tr);
  }
}

// ---------- boot ----------

(async function main() {
  await loadStations();
  await loadLive();
  await loadSnapshots();

  document.getElementById("refresh-btn").addEventListener("click", loadLive);
  document.getElementById("apply-range").addEventListener("click", renderAverages);
  setInterval(loadLive, REFRESH_MS);
})();
