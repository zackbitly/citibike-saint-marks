"use strict";

// Personal Citibike ride history -> a map of straight start->end lines.
// Data is baked at build time by build/build_rides.py (see that file for why
// personal rides can't come from a live feed).

let RIDES = [];   // [{date, started, hour, dow, start:{name,lat,lng}, end:{name,lat,lng}, minutes}]
let map, rideLayer, stationLayer;

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// dow is 0=Mon .. 6=Sun (Python datetime.weekday()).
const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function hourLabel(h) {
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${ampm}`;
}

// Time-of-day buckets for the map filter. `test(hour)` partitions 0–23;
// `short` is used in the summary line. Night wraps past midnight.
const TIME_BUCKETS = [
  { id: "morning", short: "morning", test: (h) => h >= 5 && h < 11 },
  { id: "midday", short: "midday", test: (h) => h >= 11 && h < 16 },
  { id: "evening", short: "evening", test: (h) => h >= 16 && h < 21 },
  { id: "night", short: "night", test: (h) => h >= 21 || h < 5 },
];
function dayTest(dow, dayType) {
  if (dayType === "weekday") return dow < 5;   // Mon–Fri
  if (dayType === "weekend") return dow >= 5;   // Sat–Sun
  return true;
}

function year(r) { return (r.date || "").slice(0, 4); }
function ym(r) { return (r.date || "").slice(0, 7); }
function pairKey(r) { return `${r.start.name} → ${r.end.name}`; }
function isRoundTrip(r) { return r.start.lat === r.end.lat && r.start.lng === r.end.lng; }

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

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

  for (const id of ["year-select", "time-select", "day-select"]) {
    document.getElementById(id).addEventListener("change", render);
  }
  render();
}

function render() {
  const yearSel = document.getElementById("year-select").value;
  const timeSel = document.getElementById("time-select").value;
  const daySel = document.getElementById("day-select").value;

  let inRange = RIDES;
  if (yearSel !== "all") inRange = inRange.filter((r) => year(r) === yearSel);
  if (timeSel !== "all") {
    const bucket = TIME_BUCKETS.find((b) => b.id === timeSel);
    inRange = inRange.filter((r) => r.hour != null && bucket.test(r.hour));
  }
  if (daySel !== "all") {
    inRange = inRange.filter((r) => r.dow != null && dayTest(r.dow, daySel));
  }

  renderSummary({ yearSel, timeSel, daySel }, inRange);
  renderStats(inRange);
  renderTopRoutes(inRange);
  renderHourChart(inRange);
  renderDowChart(inRange);
  renderMap(inRange);
}

function renderSummary(f, rides) {
  const el = document.getElementById("rides-summary");
  if (RIDES.length === 0) {
    el.textContent = "No ride data yet — run build/build_rides.py against your export.";
    return;
  }
  const parts = [f.yearSel === "all" ? "all years" : f.yearSel];
  if (f.timeSel !== "all") parts.push(TIME_BUCKETS.find((b) => b.id === f.timeSel).short);
  if (f.daySel !== "all") parts.push(f.daySel === "weekday" ? "weekdays" : "weekends");
  el.textContent = `${rides.length.toLocaleString()} ride(s) · ${parts.join(" · ")}.`;
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

  // Ride duration (only rides that recorded a duration).
  const durations = rides.map((r) => r.minutes).filter((v) => v != null);
  const avgMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const medMin = median(durations);

  const cards = [
    { value: rides.length.toLocaleString(), label: "Total rides" },
    { value: stations.size.toLocaleString(), label: "Stations used" },
    { value: avgMin != null ? `${avgMin.toFixed(0)} min` : "–", label: "Avg ride duration", sub: medMin != null ? `median ${medMin.toFixed(0)} min` : "" },
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

// Top directional routes (A→B kept distinct from B→A), excluding round trips
// so each row is a real station-to-station corridor — same notion of a "route"
// the map lines use.
function renderTopRoutes(rides) {
  const wrap = document.getElementById("top-routes");
  wrap.innerHTML = "";
  if (rides.length === 0) return;

  const routes = new Map();  // pairKey -> {count, minutesSum, minutesN}
  for (const r of rides) {
    if (isRoundTrip(r)) continue;
    const k = pairKey(r);
    const e = routes.get(k) || { count: 0, minutesSum: 0, minutesN: 0 };
    e.count += 1;
    if (r.minutes != null) { e.minutesSum += r.minutes; e.minutesN += 1; }
    routes.set(k, e);
  }
  if (routes.size === 0) return;

  const top = [...routes.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8);

  const rows = top.map(([label, e]) => {
    const avg = e.minutesN ? `${(e.minutesSum / e.minutesN).toFixed(0)} min` : "–";
    return `<tr><td class="route">${label}</td><td class="num">${e.count}</td><td class="num">${avg}</td></tr>`;
  }).join("");

  wrap.innerHTML =
    `<h3>Top routes</h3>` +
    `<table class="routes-table"><thead><tr>` +
    `<th class="route">Route</th><th class="num">Rides</th><th class="num">Avg</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`;
}

// Vertical bar chart from divs (no chart lib). items: [{label, count, full}],
// where `label` is the (possibly blank) axis tick and `full` the tooltip name.
function renderBars(elId, items) {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  const total = items.reduce((a, i) => a + i.count, 0);
  if (total === 0) {
    el.innerHTML = `<p class="chart-empty">No time-of-day data for this range.</p>`;
    return;
  }
  const max = Math.max(1, ...items.map((i) => i.count));
  el.innerHTML = items.map((i) => {
    const h = i.count ? Math.max(3, Math.round(100 * i.count / max)) : 0;
    return `<div class="bar" title="${i.full}: ${i.count} ride(s)">` +
      `<div class="bar-track"><div class="bar-fill" style="height:${h}%"></div></div>` +
      `<div class="bar-label">${i.label}</div>` +
    `</div>`;
  }).join("");
}

// Ride starts by hour of day (0–23). Only a few hours are labelled to keep the
// 24-bar axis legible; every bar still shows its exact count on hover.
function renderHourChart(rides) {
  const counts = new Array(24).fill(0);
  for (const r of rides) if (r.hour != null) counts[r.hour] += 1;
  const ticks = { 0: "12a", 6: "6a", 12: "12p", 18: "6p", 23: "11p" };
  const items = counts.map((c, h) => ({ label: ticks[h] || "", count: c, full: hourLabel(h) }));
  renderBars("hour-chart", items);
}

// Ride starts by day of week (Mon–Sun).
function renderDowChart(rides) {
  const counts = new Array(7).fill(0);
  for (const r of rides) if (r.dow != null) counts[r.dow] += 1;
  const items = counts.map((c, i) => ({ label: DOW_NAMES[i], count: c, full: DOW_FULL[i] }));
  renderBars("dow-chart", items);
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
