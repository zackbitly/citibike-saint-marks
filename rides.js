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

// Sampled quadratic-bezier arc from a=[lat,lng] to b=[lat,lng] for an OD flow
// map. The control point is offset to the RIGHT of travel by `curvature` of the
// segment length, so A->B and B->A bow to opposite sides instead of overlapping.
// lng is scaled by cos(midLat) so the bow looks symmetric on screen (lng degrees
// are compressed at NYC's latitude).
function arcPoints(a, b, curvature = 0.18, n = 24) {
  const midLat = (a[0] + b[0]) / 2;
  const kx = Math.cos(midLat * Math.PI / 180) || 1;  // lng compression
  // Work in a locally-equal-aspect plane: x = lng*kx, y = lat.
  const ax = a[1] * kx, ay = a[0];
  const bx = b[1] * kx, by = b[0];
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  const vx = bx - ax, vy = by - ay;
  const len = Math.hypot(vx, vy) || 1e-9;
  // Right-hand normal of travel direction (clockwise 90deg).
  const nx = vy / len, ny = -vx / len;
  const off = curvature * len;
  const cx = mx + nx * off, cy = my + ny * off;  // control point
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = u * u * ax + 2 * u * t * cx + t * t * bx;
    const y = u * u * ay + 2 * u * t * cy + t * t * by;
    pts.push([y, x / kx]);  // back to [lat, lng]
  }
  return pts;
}

// Screen bearing (degrees, 0 = pointing right/east, clockwise) from p1 to p2,
// both [lat,lng], correcting for lng compression so a CSS rotate() matches what's
// drawn. Used to orient the destination arrowhead along the arc's tangent.
function screenBearing(p1, p2) {
  const kx = Math.cos(((p1[0] + p2[0]) / 2) * Math.PI / 180) || 1;
  const dx = (p2[1] - p1[1]) * kx;
  const dy = p2[0] - p1[0];
  // Screen y grows downward, so negate dy to rotate in screen space.
  return Math.atan2(-dy, dx) * 180 / Math.PI;
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
  renderMonthChart(inRange);
  renderHourChart(inRange);
  renderDowChart(inRange);
  renderHeatmap(inRange);
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
function renderBars(elId, items, emptyMsg = "No time-of-day data for this range.") {
  const el = document.getElementById(elId);
  el.innerHTML = "";
  const total = items.reduce((a, i) => a + i.count, 0);
  if (total === 0) {
    el.innerHTML = `<p class="chart-empty">${emptyMsg}</p>`;
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

// Inclusive list of "YYYY-MM" strings from minYM to maxYM.
function monthsBetween(minYM, maxYM) {
  const out = [];
  let [y, m] = minYM.split("-").map(Number);
  const [y1, m1] = maxYM.split("-").map(Number);
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// Rides per calendar month across the (filtered) range, gaps filled with 0.
// Year is shown on January and the first bar to anchor multi-year spans.
function renderMonthChart(rides) {
  const counts = new Map();
  let minYM = null, maxYM = null;
  for (const r of rides) {
    const k = ym(r);
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (minYM === null || k < minYM) minYM = k;
    if (maxYM === null || k > maxYM) maxYM = k;
  }
  if (minYM === null) { renderBars("month-chart", [], "No rides in this range."); return; }

  const items = monthsBetween(minYM, maxYM).map((k, idx) => {
    const [y, mo] = k.split("-");
    const short = MONTH_NAMES[+mo - 1].slice(0, 3);
    const label = (mo === "01" || idx === 0) ? `${short} ’${y.slice(2)}` : short;
    return { label, count: counts.get(k) || 0, full: `${MONTH_NAMES[+mo - 1]} ${y}` };
  });
  renderBars("month-chart", items, "No rides in this range.");
}

// Day-of-week × hour-of-day heatmap (the 7×24 "commute fingerprint").
// Cell shade scales with ride count; darker = more rides started then.
function renderHeatmap(rides) {
  const wrap = document.getElementById("heatmap");
  wrap.innerHTML = "";

  const m = Array.from({ length: 7 }, () => new Array(24).fill(0));
  let total = 0;
  for (const r of rides) {
    if (r.dow == null || r.hour == null) continue;
    m[r.dow][r.hour] += 1;
    total += 1;
  }
  if (total === 0) {
    wrap.innerHTML = `<p class="chart-empty">No time-of-day data for this range.</p>`;
    return;
  }
  const max = Math.max(...m.map((row) => Math.max(...row)));

  const ticks = { 0: "12a", 6: "6a", 12: "12p", 18: "6p", 23: "11p" };
  const shade = (c) => (c ? `background:rgba(10,90,214,${(0.18 + 0.82 * (c / max)).toFixed(3)})` : "");

  let html = `<div class="heat"><div class="heat-corner"></div>`;
  for (let h = 0; h < 24; h++) html += `<div class="heat-htick">${ticks[h] || ""}</div>`;
  for (let d = 0; d < 7; d++) {
    html += `<div class="heat-day">${DOW_NAMES[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const c = m[d][h];
      html += `<div class="heat-cell${c ? "" : " heat-empty"}" style="${shade(c)}"` +
        ` title="${DOW_FULL[d]} ${hourLabel(h)}: ${c} ride(s)"></div>`;
    }
  }
  html += `</div>`;

  const steps = [0.18, 0.45, 0.7, 1.0]
    .map((a) => `<i style="background:rgba(10,90,214,${a})"></i>`).join("");
  html += `<div class="heat-legend"><span>less</span>${steps}<span>more</span></div>`;
  wrap.innerHTML = html;
}

function renderMap(rides) {
  rideLayer.clearLayers();
  stationLayer.clearLayers();
  if (rides.length === 0) return;

  // Group identical start->end pairs so repeated corridors render darker/thicker
  // (each ride is still its own real trip; we just merge coincident lines).
  const pairs = new Map();
  const visits = new Map();  // station name -> {count, starts, ends, lat, lng}
  const bump = (s, role) => {
    const v = visits.get(s.name) || { count: 0, starts: 0, ends: 0, lat: s.lat, lng: s.lng };
    v.count += 1;
    v[role] += 1;  // "starts" or "ends"
    visits.set(s.name, v);
  };

  for (const r of rides) {
    bump(r.start, "starts");
    bump(r.end, "ends");
    if (isRoundTrip(r)) continue;
    const k = pairKey(r);
    const p = pairs.get(k) || {
      a: [r.start.lat, r.start.lng], b: [r.end.lat, r.end.lng],
      label: k, count: 0,
    };
    p.count += 1;
    pairs.set(k, p);
  }

  // Each corridor as a curved arc (bowing right of travel) plus an arrowhead
  // near the destination — A->B and B->A separate into two opposing arcs.
  const maxPair = Math.max(1, ...[...pairs.values()].map((p) => p.count));
  for (const p of pairs.values()) {
    const t = p.count / maxPair;            // 0..1
    const pts = arcPoints(p.a, p.b);
    L.polyline(pts, {
      color: "#0a5ad6",
      weight: 1.5 + 4 * t,
      opacity: 0.2 + 0.55 * t,
    }).bindPopup(`<strong>${p.label}</strong><br>${p.count} ride(s)`).addTo(rideLayer);

    // Arrowhead: a fixed-size chevron sitting ~85% along the arc, rotated to the
    // local tangent so it points at the destination. divIcon keeps it constant
    // size across zoom (same trick as the station dots below).
    const tip = pts[Math.round(pts.length * 0.85)];
    const prev = pts[Math.round(pts.length * 0.78)];
    const deg = screenBearing(prev, tip);
    const arrow = L.divIcon({
      className: "",
      html: `<div class="cb-arrow" style="transform:rotate(${deg}deg)"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
    L.marker(tip, { icon: arrow, interactive: false }).addTo(rideLayer);
  }

  // Station dots sized by visit count, colored by net flow: pink (--origin) when
  // a station is mostly where rides start, blue (--ride) when mostly an end.
  const lerpColor = (bal) => {
    // bal in [-1,1]: +1 start-heavy -> pink #d6326b, -1 end-heavy -> blue #0a5ad6.
    const o = [0xd6, 0x32, 0x6b], e = [0x0a, 0x5a, 0xd6];
    const w = (bal + 1) / 2;  // 0 (end) .. 1 (start)
    const ch = (i) => Math.round(e[i] + (o[i] - e[i]) * w);
    return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
  };
  const maxVisits = Math.max(1, ...[...visits.values()].map((v) => v.count));
  for (const [name, v] of visits) {
    const size = 7 + 11 * (v.count / maxVisits);
    const bal = (v.starts - v.ends) / (v.starts + v.ends || 1);
    const icon = L.divIcon({
      className: "",
      html: `<div class="cb-station" style="width:${size}px;height:${size}px;background:${lerpColor(bal)}"></div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    L.marker([v.lat, v.lng], { icon })
      .bindPopup(`<strong>${name}</strong><br>${v.starts} start(s) · ${v.ends} end(s) · ${v.count} visit(s)`)
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
