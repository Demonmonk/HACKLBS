/* AegisGrid Hackathon MVP (front-end)
   - Safe routing: uses OSRM alternatives + local heuristic risk scoring
   - Reports: stored in localStorage
   - SOS: calls /api/sos (AI optional) and supports copy/share
*/

const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  userMarker: null,
  destMarker: null,
  reportPickMarker: null,
  reportMarkers: [],
  routeLines: { fastest: null, safest: null },
  userPos: null,      // { lat, lon }
  destPos: null,      // { lat, lon, label }
  selectedReportPos: null,
  reports: [],
  lastRouteSummary: null, // { fastest:{durationMin, risk}, safest:{durationMin, risk} }
};

const LS_KEY = "aegisgrid_reports_v1";

// ---------- Utilities ----------
function fmtCoord(lat, lon) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}
function nowHourLocal() {
  return new Date().getHours();
}
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function loadReports() {
  const raw = localStorage.getItem(LS_KEY);
  const data = safeJsonParse(raw, []);
  if (!Array.isArray(data)) return [];
  return data.filter((r) =>
    r && Number.isFinite(r.lat) && Number.isFinite(r.lon) && typeof r.category === "string"
  );
}

function saveReports(reports) {
  localStorage.setItem(LS_KEY, JSON.stringify(reports));
}

function setStatus(el, msg) {
  el.textContent = msg || "";
}

function showOverlay(msg) {
  const overlay = $("mapOverlay");
  overlay.textContent = msg;
  overlay.style.display = msg ? "block" : "none";
}

// ---------- Risk scoring (hackathon heuristic) ----------
// Output: 0..100
function riskAtPoint(pt, hour, reports) {
  // Time-of-day baseline (feel free to tweak for your demo).
  // 0..1.0
  const base =
    hour >= 0 && hour < 5 ? 0.95 :
    hour >= 5 && hour < 7 ? 0.60 :
    hour >= 7 && hour < 17 ? 0.25 :
    hour >= 17 && hour < 20 ? 0.55 :
    hour >= 20 && hour <= 23 ? 0.85 : 0.50;

  let score = base * 35; // baseline up to ~33

  // Nearby reports add risk with distance decay.
  for (const r of reports) {
    const d = haversineMeters(pt, r);
    const sev = Number(r.severity) || 2; // 1..3
    const w =
      r.category.includes("Harassment") ? 18 :
      r.category.includes("Stalking") ? 20 :
      r.category.includes("Broken") ? 10 :
      r.category.includes("CCTV") ? 12 :
      r.category.includes("Unsafe") ? 14 : 12;

    // Gaussian-ish decay
    const decay = Math.exp(-((d / 70) ** 2)); // ~70m radius
    score += (w * sev / 3) * decay;
  }

  // Clamp
  score = Math.max(0, Math.min(100, score));
  return score;
}

function routeRisk(routeGeojson, reports) {
  const coords = routeGeojson?.coordinates;
  if (!coords || coords.length < 2) return 0;

  const hour = nowHourLocal();

  // Sample up to N points along the polyline
  const N = 50;
  const step = Math.max(1, Math.floor(coords.length / N));

  let sum = 0;
  let count = 0;
  for (let i = 0; i < coords.length; i += step) {
    const [lon, lat] = coords[i];
    const pt = { lat, lon };
    sum += riskAtPoint(pt, hour, reports);
    count += 1;
  }
  const avg = count ? sum / count : 0;

  // Add slight penalty for route length so very long detours don't "win" too easily.
  // OSRM route distance is meters; if absent, skip.
  return Math.max(0, Math.min(100, avg));
}

// ---------- Map ----------
function initMap() {
  const london = { lat: 51.5074, lon: -0.1278 };

  state.map = L.map("map", { zoomControl: true }).setView([london.lat, london.lon], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(state.map);

  state.map.on("click", (e) => {
    if (getActiveTab() !== "report") return;
    const { lat, lng } = e.latlng;
    state.selectedReportPos = { lat, lon: lng };
    $("reportPoint").textContent = fmtCoord(lat, lng);

    if (state.reportPickMarker) state.map.removeLayer(state.reportPickMarker);
    state.reportPickMarker = L.marker([lat, lng], { title: "New report" }).addTo(state.map);
  });

  showOverlay("");
}

function setUserMarker(lat, lon) {
  state.userPos = { lat, lon };
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker = L.marker([lat, lon], { title: "You" }).addTo(state.map);
}

function setDestMarker(lat, lon, label) {
  state.destPos = { lat, lon, label };
  if (state.destMarker) state.map.removeLayer(state.destMarker);
  state.destMarker = L.marker([lat, lon], { title: "Destination" }).addTo(state.map);
}

function clearRouteLines() {
  for (const k of ["fastest", "safest"]) {
    if (state.routeLines[k]) state.map.removeLayer(state.routeLines[k]);
    state.routeLines[k] = null;
  }
}

function renderReports() {
  // Remove old markers
  for (const m of state.reportMarkers) state.map.removeLayer(m);
  state.reportMarkers = [];

  for (const r of state.reports) {
    const m = L.circleMarker([r.lat, r.lon], {
      radius: 7,
      weight: 2,
      opacity: 1,
      fillOpacity: 0.25,
    }).addTo(state.map);

    const when = new Date(r.createdAt).toLocaleString();
    m.bindPopup(
      `<b>${escapeHtml(r.category)}</b><br/>Severity: ${escapeHtml(String(r.severity))}<br/>${escapeHtml(when)}<br/>${escapeHtml(r.note || "")}`
    );
    state.reportMarkers.push(m);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Tabs ----------
function getActiveTab() {
  const active = document.querySelector(".tab.active");
  return active?.dataset?.tab || "route";
}

function setTab(tabName) {
  for (const b of document.querySelectorAll(".tab")) {
    b.classList.toggle("active", b.dataset.tab === tabName);
  }
  for (const pane of document.querySelectorAll(".tabPane")) {
    pane.classList.add("hidden");
  }
  $(`pane-${tabName}`).classList.remove("hidden");

  if (tabName === "report") {
    setStatus($("reportStatus"), "Tip: tap the map to place the report pin.");
  }
}

// ---------- API helpers ----------
async function apiGet(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Request failed: ${resp.status}`);
  }
  return resp.json();
}

async function apiPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Request failed: ${resp.status}`);
  }
  return resp.json();
}

// ---------- Geolocation ----------
async function useMyLocation() {
  setStatus($("routeStatus"), "Getting your location…");
  showOverlay("Requesting location…");

  if (!navigator.geolocation) {
    setStatus($("routeStatus"), "Geolocation not available in this browser.");
    showOverlay("");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      setUserMarker(lat, lon);
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Using your location: ${fmtCoord(lat, lon)}`);
      showOverlay("");
    },
    (err) => {
      setStatus($("routeStatus"), `Location error: ${err.message}`);
      showOverlay("");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ---------- Destination search ----------
async function searchDestination() {
  const q = $("dest").value.trim();
  if (!q) return;

  setStatus($("routeStatus"), "Searching…");
  $("destResults").innerHTML = "";
  try {
    const results = await apiGet(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!Array.isArray(results) || results.length === 0) {
      setStatus($("routeStatus"), "No results.");
      return;
    }

    const container = $("destResults");
    for (const r of results) {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const name = r.display_name || "(unknown)";
      const item = document.createElement("div");
      item.className = "resultItem";
      item.innerHTML = `
        <div class="resultTitle">${escapeHtml(name.split(",")[0] || name)}</div>
        <div class="resultMeta">${escapeHtml(name)}</div>
      `;
      item.addEventListener("click", () => {
        setDestMarker(lat, lon, name);
        state.map.setView([lat, lon], 15);
        setStatus($("routeStatus"), `Destination set: ${name}`);
        container.innerHTML = "";
      });
      container.appendChild(item);
    }

    setStatus($("routeStatus"), `Found ${results.length} result(s). Tap to select.`);
  } catch (e) {
    setStatus($("routeStatus"), `Search failed: ${e.message}`);
  }
}

// ---------- Routing ----------
function minutes(sec) {
  return Math.round((sec / 60) * 10) / 10;
}

function describeRoute(durationSec, riskScore) {
  const d = minutes(durationSec);
  const r = Math.round(riskScore);
  return `${d} min · risk ${r}/100`;
}

async function computeRoutes() {
  if (!state.userPos) {
    setStatus($("routeStatus"), "Set your location first (Use my location).");
    return;
  }
  if (!state.destPos) {
    setStatus($("routeStatus"), "Pick a destination first.");
    return;
  }

  clearRouteLines();
  setStatus($("routeStatus"), "Computing routes…");
  showOverlay("Routing…");

  const start = `${state.userPos.lon},${state.userPos.lat}`;
  const end = `${state.destPos.lon},${state.destPos.lat}`;

  try {
    const data = await apiGet(`/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&alternatives=1`);

    if (data.code !== "Ok" || !Array.isArray(data.routes) || data.routes.length === 0) {
      throw new Error("No routes returned.");
    }

    // Score routes
    const scored = data.routes.map((r) => {
      const geom = r.geometry; // geojson LineString
      const risk = routeRisk(geom, state.reports);
      return { route: r, risk };
    });

    // Fastest: lowest duration
    const fastest = [...scored].sort((a, b) => a.route.duration - b.route.duration)[0];
    // Safest: lowest risk, tiebreaker duration
    const safest = [...scored].sort((a, b) => (a.risk - b.risk) || (a.route.duration - b.route.duration))[0];

    const fastestLine = L.geoJSON(fastest.route.geometry, {
      style: { weight: 5, opacity: 0.9 },
    }).addTo(state.map);

    const safestLine = L.geoJSON(safest.route.geometry, {
      style: { weight: 5, opacity: 0.9, dashArray: "6 6" },
    }).addTo(state.map);

    fastestLine.bindPopup(`<b>Fastest</b><br/>${escapeHtml(describeRoute(fastest.route.duration, fastest.risk))}`);
    safestLine.bindPopup(`<b>Safest</b><br/>${escapeHtml(describeRoute(safest.route.duration, safest.risk))}`);

    state.routeLines.fastest = fastestLine;
    state.routeLines.safest = safestLine;

    // Fit bounds
    const group = L.featureGroup([fastestLine, safestLine]);
    state.map.fitBounds(group.getBounds().pad(0.2));

    // KPIs
    $("fastestKpi").textContent = describeRoute(fastest.route.duration, fastest.risk);
    $("safestKpi").textContent = describeRoute(safest.route.duration, safest.risk);

    state.lastRouteSummary = {
      fastest: { durationMin: minutes(fastest.route.duration), risk: Math.round(fastest.risk) },
      safest: { durationMin: minutes(safest.route.duration), risk: Math.round(safest.risk) },
    };

    setStatus($("routeStatus"), `Done. Showing ${data.routes.length} alternative route(s).`);
    showOverlay("");
  } catch (e) {
    setStatus($("routeStatus"), `Routing failed: ${e.message}`);
    showOverlay("");
  }
}

// ---------- Reports ----------
function addReport() {
  const pos = state.selectedReportPos;
  if (!pos) {
    setStatus($("reportStatus"), "Tap the map to select a point first.");
    return;
  }
  const category = $("category").value;
  const severity = Number($("severity").value);
  const note = $("note").value.trim();

  const report = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    lat: pos.lat,
    lon: pos.lon,
    category,
    severity,
    note,
    createdAt: Date.now(),
  };

  state.reports.unshift(report);
  saveReports(state.reports);
  renderReports();

  setStatus($("reportStatus"), "Saved locally. Routing risk score will now reflect this.");
  $("note").value = "";
}

function clearReports() {
  if (!confirm("Clear all locally saved reports in this browser?")) return;
  state.reports = [];
  saveReports(state.reports);
  renderReports();
  setStatus($("reportStatus"), "Cleared local reports.");
}

// ---------- SOS ----------
async function generateSos() {
  setStatus($("sosStatus"), "Generating…");
  $("sosOutput").textContent = "(generating…)";
  $("guidanceList").innerHTML = "";

  const pos = state.userPos || state.destPos || null;
  if (!pos) {
    setStatus($("sosStatus"), "No location available. Use 'Use my location' first.");
    $("sosOutput").textContent = "(no location)";
    return;
  }

  let address = "";
  try {
    const rev = await apiGet(`/api/reverse?lat=${encodeURIComponent(pos.lat)}&lon=${encodeURIComponent(pos.lon)}`);
    address = rev?.display_name || "";
  } catch {
    // non-fatal
  }

  const situation = $("situation").value.trim();
  const notes = $("sosNotes").value.trim();

  // "nearby reports" summary (top few within 150m)
  const nearby = state.reports
    .map((r) => ({ r, d: haversineMeters(pos, r) }))
    .filter((x) => x.d <= 150)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => ({
      category: x.r.category,
      severity: x.r.severity,
      meters_away: Math.round(x.d),
      createdAt: x.r.createdAt,
    }));

  const routeRisk = state.lastRouteSummary?.safest?.risk ?? null;

  try {
    const out = await apiPost("/api/sos", {
      lat: pos.lat,
      lon: pos.lon,
      address,
      situation,
      notes,
      routeRisk,
      reportsNearby: nearby,
    });

    const shareText = out.share || out.sos || "";
    $("sosOutput").textContent = shareText || "(no output)";

    const guidance = Array.isArray(out.guidance) ? out.guidance : [];
    for (const g of guidance) {
      const li = document.createElement("li");
      li.textContent = g;
      $("guidanceList").appendChild(li);
    }

    setStatus($("sosStatus"), out.used_ai ? "Generated with AI." : "Generated with template (AI key not configured).");
  } catch (e) {
    setStatus($("sosStatus"), `SOS failed: ${e.message}`);
    $("sosOutput").textContent = "(error)";
  }
}

async function copySos() {
  const txt = $("sosOutput").textContent || "";
  if (!txt || txt === "(nothing yet)" || txt === "(generating…)") return;
  try {
    await navigator.clipboard.writeText(txt);
    setStatus($("sosStatus"), "Copied to clipboard.");
  } catch {
    setStatus($("sosStatus"), "Copy failed (browser permissions).");
  }
}

async function shareSos() {
  const txt = $("sosOutput").textContent || "";
  if (!txt || txt === "(nothing yet)" || txt === "(generating…)") return;

  if (navigator.share) {
    try {
      await navigator.share({ title: "AegisGrid SOS", text: txt });
      setStatus($("sosStatus"), "Shared.");
    } catch {
      setStatus($("sosStatus"), "Share cancelled.");
    }
  } else {
    // fallback: mailto
    const subject = encodeURIComponent("Safety Alert (AegisGrid)");
    const body = encodeURIComponent(txt);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }
}

// ---------- Boot ----------
function wireUi() {
  // Tabs
  for (const b of document.querySelectorAll(".tab")) {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  }

  // Route
  $("useMyLocation").addEventListener("click", useMyLocation);
  $("destSearch").addEventListener("click", searchDestination);
  $("dest").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchDestination();
  });
  $("computeRoutes").addEventListener("click", computeRoutes);

  // Reports
  $("saveReport").addEventListener("click", addReport);
  $("clearReports").addEventListener("click", clearReports);

  // SOS
  $("generateSos").addEventListener("click", generateSos);
  $("copySos").addEventListener("click", copySos);
  $("shareSos").addEventListener("click", shareSos);
}

function boot() {
  // Load reports first
  state.reports = loadReports();
  // Initialize map
  initMap();
  renderReports();
  wireUi();

  // Try to get location automatically (non-blocking)
  useMyLocation();

  showOverlay("");
}

window.addEventListener("DOMContentLoaded", boot);