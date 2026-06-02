"use strict";

// Personal Citibike ride history -> a map of straight start->end lines.
// Data is baked at build time by build/build_rides.py (see that file for why
// personal rides can't come from a live feed).

let RIDES = [];   // [{date, start:{name,lat,lng}, end:{name,lat,lng}, minutes}]
let map, rideLayer, stationLayer;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function year(r) { return (r.date || "").slice(0, 4); }
function ym(r) { return (r.date || "").slice(0, 7); }
function pairKey(r) { return `${r.start.name} → ${r.end.name}`; }
function isRoundTrip(r) { return r.start.lat === r.end.lat && r.start.lng === r.end.lng; }

// Great-circle distance in km between two [lat,lng] points.
function haversineKm(a, b) {
  const R = 6371, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const la1 = a[0] * toR, la2 = b[0] * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function initMap() {
  map = L.map("map", { scrollWheelZoom: false, zoomControl: true });
  // Same clean CARTO "Voyager" basemap the live page uses.
  L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    maxZoom: 20,
    subdomains: "abcd",
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
  }).addTo(map);
  rideLayer = L.layerGroup().addTo(map);
  stationLayer = L.layerGroup().addTo(map);
}

async function loadRides() {
  try {
    const res = await fetch("data/my_rides.json", { cache: "no-store" });
    const data = res.ok ? await res.json() : { rides: [] };
    RIDES = data.rides || [];
  } catch (_) {
    RIDES = [];
  }

  const sel = document.getElementById("year-select");
  const years = [...new Set(RIDES.map(year).filter(Boolean))].sort();
  sel.innerHTML = '<option value="all">All years</option>' +
    years.slice().reverse().map((y) => `<option value="${y}">${y}</option>`).join("");
  // "the year" -> default to the most recent year with rides.
  sel.value = years.length ? years[years.length - 1] : "all";

  sel.addEventListener("change", render);
  render();
}

function render() {
  const sel = document.getElementById("year-select").value;
  const inRange = sel === "all" ? RIDES : RIDES.filter((r) => year(r) === sel);

  renderSummary(sel, inRange);
  renderStats(inRange);
  renderMap(inRange);
}

function renderSummary(sel, rides) {
  const el = document.getElementById("rides-summary");
  if (RIDES.length === 0) {
    el.textContent = "No ride data yet — run build/build_rides.py against your export.";
    return;
  }
  const scope = sel === "all" ? "all years" : sel;
  el.textContent = `${rides.length.toLocaleString()} ride(s) · ${scope}.`;
}

function renderStats(rides) {
  const wrap = document.getElementById("stats");
  wrap.innerHTML = "";
  if (rides.length === 0) return;

  // Unique stations used (either endpoint).
  const stations = new Set();
  const pairCount = new Map();
  const monthCount = new Map();
  let km = 0;
  for (const r of rides) {
    stations.add(r.start.name);
    stations.add(r.end.name);
    if (!isRoundTrip(r)) km += haversineKm([r.start.lat, r.start.lng], [r.end.lat, r.end.lng]);
    pairCount.set(pairKey(r), (pairCount.get(pairKey(r)) || 0) + 1);
    monthCount.set(ym(r), (monthCount.get(ym(r)) || 0) + 1);
  }

  const topPair = [...pairCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const topMonth = [...monthCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const monthLabel = (m) => {
    if (!m) return "–";
    const [y, mo] = m.split("-");
    return `${MONTH_NAMES[+mo - 1]} ${y}`;
  };

  const cards = [
    { value: rides.length.toLocaleString(), label: "Total rides" },
    { value: stations.size.toLocaleString(), label: "Stations used" },
    { value: `${km.toFixed(0)} km`, label: "Straight-line distance", sub: "not the route actually ridden" },
    { value: topPair ? `${topPair[1]}×` : "–", label: "Top route", sub: topPair ? topPair[0] : "" },
    { value: topMonth ? topMonth[1].toString() : "–", label: "Busiest month", sub: monthLabel(topMonth && topMonth[0]) },
  ];

  for (const c of cards) {
    const div = document.createElement("div");
    div.className = "stat";
    div.innerHTML =
      `<div class="value">${c.value}</div>` +
      `<div class="label">${c.label}</div>` +
      (c.sub ? `<div class="sub-value">${c.sub}</div>` : "");
    wrap.appendChild(div);
  }
}

function renderMap(rides) {
  rideLayer.clearLayers();
  stationLayer.clearLayers();
  if (rides.length === 0) return;

  // Group identical start->end pairs so repeated corridors render darker/thicker
  // (each ride is still its own real trip; we just merge coincident lines).
  const pairs = new Map();
  const visits = new Map();  // station name -> {count, lat, lng}
  const bump = (s) => {
    const v = visits.get(s.name) || { count: 0, lat: s.lat, lng: s.lng };
    v.count += 1;
    visits.set(s.name, v);
  };

  for (const r of rides) {
    bump(r.start);
    bump(r.end);
    if (isRoundTrip(r)) continue;
    const k = pairKey(r);
    const p = pairs.get(k) || {
      a: [r.start.lat, r.start.lng], b: [r.end.lat, r.end.lng],
      label: k, count: 0,
    };
    p.count += 1;
    pairs.set(k, p);
  }

  const maxPair = Math.max(1, ...[...pairs.values()].map((p) => p.count));
  for (const p of pairs.values()) {
    const t = p.count / maxPair;            // 0..1
    L.polyline([p.a, p.b], {
      color: "#0a5ad6",
      weight: 1.5 + 4 * t,
      opacity: 0.2 + 0.55 * t,
    }).bindPopup(`<strong>${p.label}</strong><br>${p.count} ride(s)`).addTo(rideLayer);
  }

  // Station dots sized by visit count.
  const maxVisits = Math.max(1, ...[...visits.values()].map((v) => v.count));
  for (const [name, v] of visits) {
    const size = 7 + 11 * (v.count / maxVisits);
    const icon = L.divIcon({
      className: "",
      html: `<div class="cb-station" style="width:${size}px;height:${size}px"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    L.marker([v.lat, v.lng], { icon })
      .bindPopup(`<strong>${name}</strong><br>${v.count} visit(s)`)
      .addTo(stationLayer);
  }

  // Fit to all endpoints in range.
  const pts = [];
  for (const v of visits.values()) pts.push([v.lat, v.lng]);
  if (pts.length) {
    const bounds = L.latLngBounds(pts).pad(0.12);
    map.fitBounds(bounds);
    setTimeout(() => { map.invalidateSize(); map.fitBounds(bounds); }, 300);
  }
}

(async function main() {
  initMap();
  await loadRides();
})();
