/* AegisGrid Hackathon MVP — front-end
   Features:
   - Pick start (green pin) / destination (red pin) on map, or search
   - Reports loaded from server on every map init, shown with category icons
   - Reports factored into route risk scoring
   - SOS generator
*/

const $ = (id) => document.getElementById(id);

// ---- Category config (icons + colours) ----
const CATEGORY_CONFIG = {
  "Broken streetlight":        { emoji: "🔦", color: "#f5c518", bg: "#2e2800" },
  "Harassment hotspot":        { emoji: "⚠️", color: "#ff7b00", bg: "#2e1400" },
  "Stalking / followed":       { emoji: "👁️", color: "#e040fb", bg: "#1e0028" },
  "CCTV not working":          { emoji: "📷", color: "#29b6f6", bg: "#00151e" },
  "Unsafe alley / poor visibility": { emoji: "🚧", color: "#ff5252", bg: "#1e0000" },
  "Other":                     { emoji: "❓", color: "#aab7d6", bg: "#101828" },
};

function categoryConfig(cat) {
  return CATEGORY_CONFIG[cat] || CATEGORY_CONFIG["Other"];
}

// ---- State ----
const state = {
  map: null,
  userMarker: null,
  startMarker: null,
  destMarker: null,
  reportPickMarker: null,
  reportMarkers: [],
  routeLines: { fastest: null, safest: null },
  userPos: null,
  destPos: null,
  selectedReportPos: null,
  reports: [],
  lastRouteSummary: null,
  mapPickMode: null,   // "start" | "dest" | "report" | null
  sosRecognition: null,
  sosIsListening: false,
  sosVoiceFinal: "",
  supportRecognition: null,
  supportIsListening: false,
};

// ---- Utilities ----
function fmtCoord(lat, lon) { return `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
function nowHourLocal() { return new Date().getHours(); }

function haversineMeters(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function clampStr(s, max) {
  s = String(s || "");
  return s.length > max ? s.slice(0, max) : s;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setStatus(el, msg) { if (el) el.textContent = msg || ""; }

function showOverlay(msg) {
  const o = $("mapOverlay");
  if (msg) { o.textContent = msg; o.classList.remove("hidden"); }
  else o.classList.add("hidden");
}

// ---- Pick-mode banner ----
function setPickMode(mode) {
  state.mapPickMode = mode;
  const banner = $("pickModeBanner");
  const mapEl = $("map");

  if (!mode) {
    banner.classList.add("hidden");
    mapEl.classList.remove("pick-cursor");
    return;
  }

  mapEl.classList.add("pick-cursor");
  banner.classList.remove("hidden");

  if (mode === "start") {
    banner.className = "pick-mode-banner pick-mode-green";
    banner.textContent = "🟢 Click the map to set your start location";
  } else if (mode === "dest") {
    banner.className = "pick-mode-banner pick-mode-red";
    banner.textContent = "🔴 Click the map to set your destination";
  } else if (mode === "report") {
    banner.className = "pick-mode-banner pick-mode-report";
    banner.textContent = "📍 Click the map to place the report pin";
  }
}

// ---- Custom Leaflet icons ----
function makeEmojiIcon(emoji, sizeClass) {
  return L.divIcon({
    className: "",
    html: `<div class="map-emoji-pin ${sizeClass || ""}">${emoji}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 36],
    popupAnchor: [0, -36],
  });
}

const START_ICON = L.divIcon({
  className: "",
  html: `<div class="map-pin map-pin-green">▲</div>`,
  iconSize: [28, 34],
  iconAnchor: [14, 34],
  popupAnchor: [0, -34],
});

const DEST_ICON = L.divIcon({
  className: "",
  html: `<div class="map-pin map-pin-red">▲</div>`,
  iconSize: [28, 34],
  iconAnchor: [14, 34],
  popupAnchor: [0, -34],
});

// ---- Map init ----
function initMap() {
  const london = { lat: 51.5074, lon: -0.1278 };
  state.map = L.map("map", { zoomControl: true }).setView([london.lat, london.lon], 13);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(state.map);

  state.map.on("click", onMapClick);

  loadAndRenderReports();
}

function onMapClick(e) {
  const { lat, lng: lon } = e.latlng;

  if (state.mapPickMode === "start") {
    setStartMarker(lat, lon, fmtCoord(lat, lon));
    $("start").value = fmtCoord(lat, lon);
    $("startResults").innerHTML = "";
    $("startLabel").textContent = `Start: ${fmtCoord(lat, lon)}`;
    setStatus($("routeStatus"), `Start set at ${fmtCoord(lat, lon)}`);
    setPickMode(null);
    return;
  }

  if (state.mapPickMode === "dest") {
    setDestMarker(lat, lon, fmtCoord(lat, lon));
    $("dest").value = fmtCoord(lat, lon);
    $("destResults").innerHTML = "";
    $("destLabel").textContent = `Destination: ${fmtCoord(lat, lon)}`;
    setStatus($("routeStatus"), `Destination set at ${fmtCoord(lat, lon)}`);
    setPickMode(null);
    return;
  }

  if (getActiveTab() === "report") {
    state.selectedReportPos = { lat, lon };
    $("reportPoint").textContent = fmtCoord(lat, lon);
    if (state.reportPickMarker) state.map.removeLayer(state.reportPickMarker);
    state.reportPickMarker = L.marker([lat, lon], {
      icon: makeEmojiIcon("📍"),
      title: "New report",
    }).addTo(state.map);
    setPickMode(null);
  }
}

// ---- Markers ----
function setStartMarker(lat, lon, label) {
  state.userPos = { lat, lon, label };
  if (state.startMarker) state.map.removeLayer(state.startMarker);
  state.startMarker = L.marker([lat, lon], { icon: START_ICON, title: "Start" })
    .bindPopup(`<b>Start</b><br/>${escapeHtml(label || fmtCoord(lat, lon))}`)
    .addTo(state.map);
}

function setUserMarker(lat, lon) {
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker = L.circleMarker([lat, lon], {
    radius: 9, color: "#4da3ff", weight: 3, fillOpacity: 0.5,
  }).bindPopup("<b>Your location</b>").addTo(state.map);
  setStartMarker(lat, lon, "Current location");
}

function setDestMarker(lat, lon, label) {
  state.destPos = { lat, lon, label };
  if (state.destMarker) state.map.removeLayer(state.destMarker);
  state.destMarker = L.marker([lat, lon], { icon: DEST_ICON, title: "Destination" })
    .bindPopup(`<b>Destination</b><br/>${escapeHtml(label || fmtCoord(lat, lon))}`)
    .addTo(state.map);
}

function clearRouteLines() {
  for (const k of ["fastest", "safest"]) {
    if (state.routeLines[k]) state.map.removeLayer(state.routeLines[k]);
    state.routeLines[k] = null;
  }
}

// ---- Reports: load + render ----
async function loadReportsFromServer() {
  try {
    const data = await apiGet("/api/reports");
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      ...r,
      lat: Number(r.lat),
      lon: Number(r.lon),
      severity: Number(r.severity),
      createdAt: Number(r.created_at),
    })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  } catch {
    return [];
  }
}

async function loadAndRenderReports() {
  const reports = await loadReportsFromServer();
  state.reports = reports;
  renderReports();
}

function renderReports() {
  for (const m of state.reportMarkers) state.map.removeLayer(m);
  state.reportMarkers = [];

  for (const r of state.reports) {
    const cfg = categoryConfig(r.category);
    const icon = L.divIcon({
      className: "",
      html: `<div class="map-report-pin" style="background:${cfg.bg};border-color:${cfg.color}">
               <span class="map-report-emoji">${cfg.emoji}</span>
             </div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 34],
      popupAnchor: [0, -34],
    });

    const when = new Date(r.createdAt).toLocaleString();
    const sevLabel = r.severity === 1 ? "Low" : r.severity === 3 ? "High" : "Medium";
    const marker = L.marker([r.lat, r.lon], { icon })
      .bindPopup(
        `<div class="popup-report">
          <div class="popup-cat">${escapeHtml(cfg.emoji)} ${escapeHtml(r.category)}</div>
          <div class="popup-sev" style="color:${cfg.color}">Severity: ${escapeHtml(sevLabel)}</div>
          ${r.note ? `<div class="popup-note">${escapeHtml(r.note)}</div>` : ""}
          <div class="popup-when">${escapeHtml(when)}</div>
        </div>`
      )
      .addTo(state.map);
    state.reportMarkers.push(marker);
  }
}

// ---- Tabs ----
function getActiveTab() {
  const active = document.querySelector(".tab.active");
  return active?.dataset?.tab || "route";
}

function setTab(tabName) {
  for (const b of document.querySelectorAll(".tab"))
    b.classList.toggle("active", b.dataset.tab === tabName);
  for (const p of document.querySelectorAll(".tabPane"))
    p.classList.add("hidden");
  $(`pane-${tabName}`).classList.remove("hidden");

  if (tabName !== "sos") stopSosVoice();
  if (tabName !== "support") stopVoiceSupport?.();

  if (tabName === "report") {
    setPickMode("report");
    setStatus($("reportStatus"), "Tap the map to place the report pin.");
  } else if (tabName !== "report" && state.mapPickMode === "report") {
    setPickMode(null);
  }
}

// ---- API helpers ----
function compactErrorText(text) {
  return String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
}

async function parseApiError(resp) {
  const text = await resp.text();
  let message = `Request failed: ${resp.status}`;
  try {
    const data = JSON.parse(text);
    if (data?.error && data?.detail) message = `${data.error}. ${compactErrorText(data.detail)}`;
    else if (data?.error) message = String(data.error);
    else if (data?.detail) message = compactErrorText(data.detail);
  } catch {
    const compact = compactErrorText(text);
    if (compact) message = `${message}. ${compact}`;
  }
  return new Error(message);
}

async function apiGet(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw await parseApiError(resp);
  return resp.json();
}

async function apiPost(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw await parseApiError(resp);
  return resp.json();
}

// ---- Geolocation ----
async function reverseLabel(lat, lon) {
  try {
    const rev = await apiGet(`/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    return rev?.display_name || "Current location";
  } catch {
    return "Current location";
  }
}

function geolocationErrorMessage(err) {
  if (err?.code === 1) return "Location denied. Allow location or pick start manually.";
  if (err?.code === 2) return "Location unavailable. Try again or pick manually.";
  if (err?.code === 3) return "Location timed out. Try again or pick manually.";
  return `Location error: ${err?.message || "Unknown error"}`;
}

async function useMyLocation() {
  setStatus($("routeStatus"), "Getting your location…");
  showOverlay("Requesting location…");

  if (!navigator.geolocation) {
    setStatus($("routeStatus"), "Geolocation not available. Pick start on map instead.");
    showOverlay("");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      setUserMarker(lat, lon);
      const label = await reverseLabel(lat, lon);
      state.userPos = { lat, lon, label };
      $("start").value = label;
      $("startLabel").textContent = `Start: ${label}`;
      $("startResults").innerHTML = "";
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Using your location: ${fmtCoord(lat, lon)}`);
      showOverlay("");
    },
    (err) => {
      setStatus($("routeStatus"), geolocationErrorMessage(err));
      showOverlay("");
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
  );
}

// ---- Search ----
async function searchLocation({ queryInputId, resultsId, emptyMessage, onSelect }) {
  const q = $(queryInputId).value.trim();
  if (!q) { setStatus($("routeStatus"), emptyMessage); return; }

  setStatus($("routeStatus"), "Searching…");
  const container = $(resultsId);
  container.innerHTML = "";

  try {
    const results = await apiGet(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!Array.isArray(results) || results.length === 0) {
      setStatus($("routeStatus"), "No results found.");
      return;
    }

    for (const r of results) {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const name = r.display_name || "(unknown)";
      const item = document.createElement("div");
      item.className = "resultItem";
      item.innerHTML = `
        <div class="resultTitle">${escapeHtml(name.split(",")[0] || name)}</div>
        <div class="resultMeta">${escapeHtml(name)}</div>
      `;
      item.addEventListener("click", () => {
        onSelect({ lat, lon, name });
        container.innerHTML = "";
      });
      container.appendChild(item);
    }
    setStatus($("routeStatus"), `Found ${container.children.length} result(s). Tap to select.`);
  } catch (e) {
    setStatus($("routeStatus"), `Search failed: ${e.message}`);
  }
}

async function searchStartLocation() {
  await searchLocation({
    queryInputId: "start",
    resultsId: "startResults",
    emptyMessage: "Enter a start location or use 'Pick on map'.",
    onSelect: ({ lat, lon, name }) => {
      setStartMarker(lat, lon, name);
      $("startLabel").textContent = `Start: ${name}`;
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Start: ${name}`);
    },
  });
}

async function searchDestination() {
  await searchLocation({
    queryInputId: "dest",
    resultsId: "destResults",
    emptyMessage: "Enter a destination or use 'Pick on map'.",
    onSelect: ({ lat, lon, name }) => {
      setDestMarker(lat, lon, name);
      $("destLabel").textContent = `Destination: ${name}`;
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Destination: ${name}`);
    },
  });
}

// ---- Risk scoring ----
function riskAtPoint(pt, hour, reports) {
  const base =
    hour >= 0 && hour < 5 ? 0.95 :
    hour >= 5 && hour < 7 ? 0.60 :
    hour >= 7 && hour < 17 ? 0.25 :
    hour >= 17 && hour < 20 ? 0.55 :
    hour >= 20 && hour <= 23 ? 0.85 : 0.50;

  let score = base * 35;

  for (const r of reports) {
    const d = haversineMeters(pt, r);
    const sev = Number(r.severity) || 2;
    const w =
      r.category.includes("Harassment") ? 18 :
      r.category.includes("Stalking") ? 20 :
      r.category.includes("Broken") ? 10 :
      r.category.includes("CCTV") ? 12 :
      r.category.includes("Unsafe") ? 14 : 12;
    const decay = Math.exp(-((d / 70) ** 2));
    score += (w * sev / 3) * decay;
  }

  return Math.max(0, Math.min(100, score));
}

function routeRisk(routeGeojson, reports) {
  const coords = routeGeojson?.coordinates;
  if (!coords || coords.length < 2) return 0;
  const hour = nowHourLocal();
  const N = 50;
  const step = Math.max(1, Math.floor(coords.length / N));
  let sum = 0, count = 0;
  for (let i = 0; i < coords.length; i += step) {
    const [lon, lat] = coords[i];
    sum += riskAtPoint({ lat, lon }, hour, reports);
    count++;
  }
  return Math.max(0, Math.min(100, count ? sum / count : 0));
}

// ---- Routing ----
function minutes(sec) { return Math.round((sec / 60) * 10) / 10; }

function riskLabel(score) {
  if (score < 20) return "Low";
  if (score < 45) return "Moderate";
  if (score < 65) return "High";
  return "Very High";
}

function riskColor(score) {
  if (score < 20) return "#4caf50";
  if (score < 45) return "#ffb300";
  if (score < 65) return "#ff7043";
  return "#e53935";
}

async function computeRoutes() {
  if (!state.userPos) {
    setStatus($("routeStatus"), "Set a start location first — use your location or pick on map.");
    return;
  }
  if (!state.destPos) {
    setStatus($("routeStatus"), "Set a destination — pick on map or search.");
    return;
  }

  clearRouteLines();
  setStatus($("routeStatus"), "Fetching routes…");
  showOverlay("Routing…");

  const start = `${state.userPos.lon},${state.userPos.lat}`;
  const end   = `${state.destPos.lon},${state.destPos.lat}`;

  try {
    // Reload fresh reports before scoring so we always have the latest
    const freshReports = await loadReportsFromServer();
    state.reports = freshReports;
    renderReports();

    const data = await apiGet(
      `/api/route?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&alternatives=3`
    );

    if (data.code !== "Ok" || !Array.isArray(data.routes) || !data.routes.length) {
      throw new Error("No routes returned by the router.");
    }

    // Score every route returned by OSRM
    const scored = data.routes.map((r, i) => ({
      route: r,
      index: i,
      risk: routeRisk(r.geometry, state.reports),
      durationMin: minutes(r.duration),
    }));

    // Fastest = lowest duration; safest = lowest risk (tie-break: shorter)
    const fastest = [...scored].sort((a, b) => a.route.duration - b.route.duration)[0];
    const safest  = [...scored].sort((a, b) => (a.risk - b.risk) || (a.route.duration - b.route.duration))[0];

    const sameRoute = fastest.index === safest.index;

    if (sameRoute) {
      // Draw single route in blue with both labels
      const line = L.geoJSON(fastest.route.geometry, {
        style: { color: "#4da3ff", weight: 6, opacity: 0.92 },
      }).addTo(state.map);
      line.bindPopup(
        `<div class="popup-route">
          <b>Only one route available</b><br/>
          ${escapeHtml(fastest.durationMin)} min &nbsp;·&nbsp;
          <span style="color:${riskColor(fastest.risk)}">Risk: ${Math.round(fastest.risk)}/100 (${riskLabel(fastest.risk)})</span>
        </div>`
      );
      state.routeLines.fastest = line;
      state.routeLines.safest  = null;

      state.map.fitBounds(L.featureGroup([line]).getBounds().pad(0.2));

      $("fastestKpi").innerHTML = `${fastest.durationMin} min<br/><span style="color:${riskColor(fastest.risk)};font-size:12px">Risk ${Math.round(fastest.risk)}/100</span>`;
      $("safestKpi").innerHTML  = `<span style="color:var(--muted);font-size:13px">${
        data.routes.length === 1
          ? "Only 1 route found"
          : state.reports.length === 0
            ? "No reports to avoid"
            : "Same as fastest"
      }</span>`;

      const noReports = state.reports.length === 0;
      setStatus($("routeStatus"),
        data.routes.length === 1
          ? `Only one route found between these points. ${noReports ? "Add reports to see risk scoring." : `Risk: ${Math.round(fastest.risk)}/100.`}`
          : `All ${data.routes.length} routes have equal risk — showing fastest. ${noReports ? "Add reports to see avoidance." : `Risk: ${Math.round(fastest.risk)}/100.`}`
      );
    } else {
      // Two distinct routes — fastest (red) vs safest (green)
      const fastestLine = L.geoJSON(fastest.route.geometry, {
        style: { color: "#e53935", weight: 6, opacity: 0.90 },
      }).addTo(state.map);
      fastestLine.bindPopup(
        `<div class="popup-route">
          <b style="color:#ef9a9a">🔴 Fastest route</b><br/>
          ${escapeHtml(String(fastest.durationMin))} min &nbsp;·&nbsp;
          <span style="color:${riskColor(fastest.risk)}">Risk: ${Math.round(fastest.risk)}/100 (${riskLabel(fastest.risk)})</span>
        </div>`
      );
      state.routeLines.fastest = fastestLine;

      const safestLine = L.geoJSON(safest.route.geometry, {
        style: { color: "#43a047", weight: 6, opacity: 0.92, dashArray: "10 5" },
      }).addTo(state.map);
      safestLine.bindPopup(
        `<div class="popup-route">
          <b style="color:#a5d6a7">🟢 Safest route</b><br/>
          ${escapeHtml(String(safest.durationMin))} min &nbsp;·&nbsp;
          <span style="color:${riskColor(safest.risk)}">Risk: ${Math.round(safest.risk)}/100 (${riskLabel(safest.risk)})</span>
        </div>`
      );
      state.routeLines.safest = safestLine;

      state.map.fitBounds(L.featureGroup([fastestLine, safestLine]).getBounds().pad(0.2));

      $("fastestKpi").innerHTML = `
        <span style="color:#ef9a9a">🔴</span> ${fastest.durationMin} min
        <br/><span style="color:${riskColor(fastest.risk)};font-size:12px">Risk ${Math.round(fastest.risk)}/100 — ${riskLabel(fastest.risk)}</span>
      `;
      $("safestKpi").innerHTML = `
        <span style="color:#a5d6a7">🟢</span> ${safest.durationMin} min
        <br/><span style="color:${riskColor(safest.risk)};font-size:12px">Risk ${Math.round(safest.risk)}/100 — ${riskLabel(safest.risk)}</span>
      `;

      const savedTime = Math.round((safest.durationMin - fastest.durationMin) * 10) / 10;
      const riskDiff  = Math.round(fastest.risk - safest.risk);
      setStatus($("routeStatus"),
        `🔴 Fastest (${fastest.durationMin} min, risk ${Math.round(fastest.risk)}) vs 🟢 Safest (${safest.durationMin} min, risk ${Math.round(safest.risk)}). ` +
        `Safest avoids ${riskDiff} risk points${savedTime > 0 ? `, costs ${savedTime} extra min` : ""}.`
      );
    }

    state.lastRouteSummary = {
      fastest: { durationMin: fastest.durationMin, risk: Math.round(fastest.risk) },
      safest:  { durationMin: safest.durationMin,  risk: Math.round(safest.risk) },
    };

    showOverlay("");
  } catch (e) {
    setStatus($("routeStatus"), `Routing failed: ${e.message}`);
    showOverlay("");
  }
}

// ---- Reports: save ----
async function addReport() {
  const pos = state.selectedReportPos;
  if (!pos) {
    setStatus($("reportStatus"), "Tap the map to select a point first.");
    return;
  }
  const category = $("category").value;
  const severity = Number($("severity").value);
  const note = $("note").value.trim();

  setStatus($("reportStatus"), "Saving…");

  try {
    const saved = await apiPost("/api/reports", { lat: pos.lat, lon: pos.lon, category, severity, note });
    const report = {
      ...saved,
      lat: Number(saved.lat),
      lon: Number(saved.lon),
      severity: Number(saved.severity),
      createdAt: Number(saved.created_at),
    };

    state.reports.unshift(report);
    renderReports();

    if (state.reportPickMarker) {
      state.map.removeLayer(state.reportPickMarker);
      state.reportPickMarker = null;
    }
    state.selectedReportPos = null;
    $("reportPoint").textContent = "Tap the map to place a pin…";
    $("note").value = "";
    setStatus($("reportStatus"), `Saved! ${categoryConfig(category).emoji} Report now visible to everyone.`);
    setPickMode("report");
  } catch (e) {
    setStatus($("reportStatus"), `Failed to save: ${e.message}`);
  }
}

// ---- SOS ----
async function generateSos() {
  setStatus($("sosStatus"), "Generating…");
  $("sosOutput").textContent = "(generating…)";
  $("guidanceList").innerHTML = "";

  const pos = state.userPos || state.destPos || null;
  if (!pos) {
    setStatus($("sosStatus"), "No location set. Use 'Use my location' on the Route tab first.");
    $("sosOutput").textContent = "(no location)";
    return;
  }

  let address = "";
  try {
    const rev = await apiGet(`/api/reverse?lat=${encodeURIComponent(pos.lat)}&lon=${encodeURIComponent(pos.lon)}`);
    address = rev?.display_name || "";
  } catch { /* non-fatal */ }

  const transcript = $("sosTranscript").value.trim();
  const situation = $("situation").value.trim() || transcript.slice(0, 120);
  const notesField = $("sosNotes").value.trim();
  const notes = [notesField, transcript ? `Voice transcript: ${transcript}` : ""].filter(Boolean).join("\n");

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

  const risk = state.lastRouteSummary?.safest?.risk ?? null;

  try {
    const out = await apiPost("/api/sos", {
      lat: pos.lat, lon: pos.lon, address, situation, notes, routeRisk: risk, reportsNearby: nearby,
    });

    const shareText = out.share || out.sos || "";
    $("sosOutput").textContent = shareText || "(no output)";

    for (const g of (Array.isArray(out.guidance) ? out.guidance : [])) {
      const li = document.createElement("li");
      li.textContent = g;
      $("guidanceList").appendChild(li);
    }
    setStatus($("sosStatus"), out.used_ai ? "Generated with AI." : "Generated (template — AI key not set).");
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
    try { await navigator.share({ title: "AegisGrid SOS", text: txt }); setStatus($("sosStatus"), "Shared."); }
    catch { setStatus($("sosStatus"), "Share cancelled."); }
  } else {
    window.location.href = `mailto:?subject=${encodeURIComponent("Safety Alert (AegisGrid)")}&body=${encodeURIComponent(txt)}`;
  }
}

// ---- SOS Voice ----
function stopSosVoice() {
  if (state.sosRecognition && state.sosIsListening) state.sosRecognition.stop();
  state.sosIsListening = false;
}

function startSosVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { setStatus($("sosStatus"), "Voice input not supported in this browser."); return; }

  if (!state.sosRecognition) {
    const r = new SR();
    r.lang = "en-GB";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const phrase = event.results[i][0].transcript.trim();
        if (!phrase) continue;
        if (event.results[i].isFinal) state.sosVoiceFinal = `${state.sosVoiceFinal} ${phrase}`.trim();
        else interim = `${interim} ${phrase}`.trim();
      }
      $("sosTranscript").value = `${state.sosVoiceFinal} ${interim}`.trim();
    };
    r.onerror = () => { state.sosIsListening = false; setStatus($("sosStatus"), "Voice error. Type instead."); };
    r.onend = () => { if (state.sosIsListening) r.start(); };
    state.sosRecognition = r;
  }

  if (!state.sosVoiceFinal && $("sosTranscript").value.trim())
    state.sosVoiceFinal = $("sosTranscript").value.trim();

  state.sosIsListening = true;
  state.sosRecognition.start();
  setStatus($("sosStatus"), "Listening… speak naturally.");
}

function speakSos() {
  const text = $("sosOutput").textContent || "";
  if (!text || text === "(nothing yet)" || text === "(generating…)" || text === "(error)") return;
  if (!("speechSynthesis" in window)) { setStatus($("sosStatus"), "Speech not available in this browser."); return; }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function stopVoiceSupport() {}

// ---- Severity label ----
function updateSeverityLabel() {
  const val = Number($("severity").value);
  $("severityVal").textContent = val === 1 ? "Low" : val === 3 ? "High" : "Medium";
}

// ---- Boot ----
document.addEventListener("DOMContentLoaded", () => {
  initMap();

  // Tab switching
  for (const btn of document.querySelectorAll(".tab")) {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  }
  // Show route tab by default
  setTab("route");

  // Route tab
  $("useMyLocation").addEventListener("click", useMyLocation);

  $("pickStart").addEventListener("click", () => {
    const isActive = state.mapPickMode === "start";
    setPickMode(isActive ? null : "start");
    $("pickStart").classList.toggle("active-pick", !isActive);
  });

  $("pickDest").addEventListener("click", () => {
    const isActive = state.mapPickMode === "dest";
    setPickMode(isActive ? null : "dest");
    $("pickDest").classList.toggle("active-pick", !isActive);
  });

  $("startSearch").addEventListener("click", searchStartLocation);
  $("start").addEventListener("keydown", (e) => { if (e.key === "Enter") searchStartLocation(); });

  $("destSearch").addEventListener("click", searchDestination);
  $("dest").addEventListener("keydown", (e) => { if (e.key === "Enter") searchDestination(); });

  $("computeRoutes").addEventListener("click", computeRoutes);

  // Report tab
  $("saveReport").addEventListener("click", addReport);
  $("severity").addEventListener("input", updateSeverityLabel);

  // SOS tab
  $("startSosVoice").addEventListener("click", startSosVoice);
  $("stopSosVoice").addEventListener("click", stopSosVoice);
  $("generateSos").addEventListener("click", generateSos);
  $("copySos").addEventListener("click", copySos);
  $("shareSos").addEventListener("click", shareSos);
  $("speakSos").addEventListener("click", speakSos);
});
