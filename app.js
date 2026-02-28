/* AegisGrid Hackathon MVP (front-end)
   - Safe routing: uses OSRM alternatives + local heuristic risk scoring
   - Reports: stored in localStorage
   - SOS: calls /api/sos (AI optional) and supports copy/share
*/

const $ = (id) => document.getElementById(id);

const state = {
  map: null,
  userMarker: null,
  startMarker: null,
  destMarker: null,
  reportPickMarker: null,
  reportMarkers: [],
  routeLines: { fastest: null, safest: null },
  userPos: null,      // { lat, lon }
  destPos: null,      // { lat, lon, label }
  selectedReportPos: null,
  reports: [],
  lastRouteSummary: null, // { fastest:{durationMin, risk}, safest:{durationMin, risk} }
  sosRecognition: null,
  sosIsListening: false,
  sosVoiceFinal: "",
  supportRecognition: null,
  supportIsListening: false,
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
  if (!el) return;
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

function setStartMarker(lat, lon, label = "Start") {
  state.userPos = { lat, lon, label };
  if (state.startMarker) state.map.removeLayer(state.startMarker);
  state.startMarker = L.marker([lat, lon], { title: label || "Start" }).addTo(state.map);
}

function setUserMarker(lat, lon) {
  if (state.userMarker) state.map.removeLayer(state.userMarker);
  state.userMarker = L.circleMarker([lat, lon], {
    radius: 8,
    color: "#4da3ff",
    weight: 2,
    fillOpacity: 0.55,
  }).addTo(state.map);
  setStartMarker(lat, lon, "Current location");
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

  if (tabName !== "sos") {
    stopSosVoice();
  }
  if (tabName !== "support") {
    stopVoiceSupport();
  }

  if (tabName === "report") {
    setStatus($("reportStatus"), "Tip: tap the map to place the report pin.");
  }
}

// ---------- API helpers ----------
function compactErrorText(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

async function parseApiError(resp) {
  const text = await resp.text();
  let message = `Request failed: ${resp.status}`;

  try {
    const data = JSON.parse(text);
    if (data && typeof data === "object") {
      if (data.error && data.detail) {
        message = `${data.error}. ${compactErrorText(data.detail)}`;
      } else if (data.error) {
        message = String(data.error);
      } else if (data.detail) {
        message = compactErrorText(data.detail);
      }
    }
  } catch {
    const compact = compactErrorText(text);
    if (compact) message = `${message}. ${compact}`;
  }

  return new Error(message);
}

async function apiGet(url) {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw await parseApiError(resp);
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
    throw await parseApiError(resp);
  }
  return resp.json();
}

// ---------- Geolocation ----------
async function reverseLabel(lat, lon) {
  try {
    const rev = await apiGet(`/api/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    return rev?.display_name || "Current location";
  } catch {
    return "Current location";
  }
}

function geolocationErrorMessage(err) {
  const code = err?.code;
  if (code === 1) return "Location permission denied. Allow location access or search your start location manually.";
  if (code === 2) return "Location unavailable. Try again outdoors or search your start location manually.";
  if (code === 3) return "Location request timed out. Try again or search your start location manually.";
  return `Location error: ${err?.message || "Unknown geolocation error"}`;
}

async function useMyLocation() {
  setStatus($("routeStatus"), "Getting your location…");
  showOverlay("Requesting location…");

  if (!navigator.geolocation) {
    setStatus($("routeStatus"), "Geolocation not available in this browser. Search your start location manually.");
    showOverlay("");
    return;
  }

  const success = async (pos) => {
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    setUserMarker(lat, lon);
    const label = await reverseLabel(lat, lon);
    state.userPos = { lat, lon, label };
    $("start").value = label;
    $("startResults").innerHTML = "";
    state.map.setView([lat, lon], 15);
    setStatus($("routeStatus"), `Using your current location: ${fmtCoord(lat, lon)}`);
    showOverlay("");
  };

  const failure = (err) => {
    setStatus($("routeStatus"), geolocationErrorMessage(err));
    showOverlay("");
  };

  navigator.geolocation.getCurrentPosition(success, failure, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 60000,
  });
}

// ---------- Destination search ----------

async function searchLocation({
  queryInputId,
  resultsId,
  emptyMessage,
  onSelect,
}) {
  const q = $(queryInputId).value.trim();
  if (!q) {
    setStatus($("routeStatus"), emptyMessage);
    return;
  }

  setStatus($("routeStatus"), "Searching…");
  const container = $(resultsId);
  container.innerHTML = "";

  try {
    const results = await apiGet(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!Array.isArray(results) || results.length === 0) {
      setStatus($("routeStatus"), "No results.");
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
    emptyMessage: "Enter a start location or use your current location.",
    onSelect: ({ lat, lon, name }) => {
      setStartMarker(lat, lon, name);
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Start set: ${name}`);
    },
  });
}

async function searchDestination() {
  await searchLocation({
    queryInputId: "dest",
    resultsId: "destResults",
    emptyMessage: "Enter a destination.",
    onSelect: ({ lat, lon, name }) => {
      setDestMarker(lat, lon, name);
      state.map.setView([lat, lon], 15);
      setStatus($("routeStatus"), `Destination set: ${name}`);
    },
  });
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
    setStatus($("routeStatus"), "Set a start location first (Use my location or search a start place).");
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

    fastestLine.bindPopup(`<b>Fastest</b><br/>${escapeHtml(describeRoute(fastest.route.duration, fastest.risk))}`);
    state.routeLines.fastest = fastestLine;

    const sameRoute = fastest.route === safest.route;
    let fitLayers = [fastestLine];

    if (!sameRoute) {
      const safestLine = L.geoJSON(safest.route.geometry, {
        style: { weight: 5, opacity: 0.9, dashArray: "6 6" },
      }).addTo(state.map);
      safestLine.bindPopup(`<b>Safest</b><br/>${escapeHtml(describeRoute(safest.route.duration, safest.risk))}`);
      state.routeLines.safest = safestLine;
      fitLayers = [fastestLine, safestLine];
    } else {
      state.routeLines.safest = null;
    }

    // Fit bounds
    const group = L.featureGroup(fitLayers);
    state.map.fitBounds(group.getBounds().pad(0.2));

    // KPIs
    $("fastestKpi").textContent = describeRoute(fastest.route.duration, fastest.risk);
    $("safestKpi").textContent = describeRoute(safest.route.duration, safest.risk);

    state.lastRouteSummary = {
      fastest: { durationMin: minutes(fastest.route.duration), risk: Math.round(fastest.risk) },
      safest: { durationMin: minutes(safest.route.duration), risk: Math.round(safest.risk) },
    };

    setStatus($("routeStatus"), sameRoute ? "Done. One route available; fastest and safest are the same." : `Done. Showing ${data.routes.length} alternative route(s).`);
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

  const transcript = $("sosTranscript").value.trim();
  const situation = $("situation").value.trim() || transcript.slice(0, 120);
  const notesField = $("sosNotes").value.trim();
  const notes = [notesField, transcript ? `Voice transcript: ${transcript}` : ""].filter(Boolean).join("\n");

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

// ---------- SOS Voice ----------

function stopSosVoice() {
  if (state.sosRecognition && state.sosIsListening) {
    state.sosRecognition.stop();
  }
  state.sosIsListening = false;
  setStatus($("sosStatus"), "Voice input stopped.");
}

function updateSosTranscript(interim = "") {
  const combined = `${state.sosVoiceFinal} ${interim}`.trim();
  $("sosTranscript").value = combined;
}


function startSosVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus($("sosStatus"), "Voice input is not supported in this browser. You can type your details instead.");
    return;
  }

  if (!state.sosRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const phrase = result[0].transcript.trim();
        if (!phrase) continue;
        if (result.isFinal) {
          state.sosVoiceFinal = `${state.sosVoiceFinal} ${phrase}`.trim();
        } else {
          interim = `${interim} ${phrase}`.trim();
        }
      }
      updateSosTranscript(interim);
    };

    recognition.onerror = () => {
      state.sosIsListening = false;
      setStatus($("sosStatus"), "Voice input error. You can continue by typing.");
    };

    recognition.onend = () => {
      if (state.sosIsListening) {
        recognition.start();
      }
    };

    state.sosRecognition = recognition;
  }

  if (!state.sosVoiceFinal && $("sosTranscript").value.trim()) {
    state.sosVoiceFinal = $("sosTranscript").value.trim();
  }

  state.sosIsListening = true;
  state.sosRecognition.start();
  setStatus($("sosStatus"), "Listening… speak naturally. Transcript updates live.");
}

function speakSos() {
  const text = $("sosOutput").textContent || "";
  if (!text || text === "(nothing yet)" || text === "(generating…)" || text === "(error)") return;
  if (!("speechSynthesis" in window)) {
    setStatus($("sosStatus"), "Speech playback is not available in this browser.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
  setStatus($("sosStatus"), "Reading SOS aloud.");
}

// ---------- AI Support ----------

function getSafetyContextLabel() {
  if (state.lastRouteSummary?.safest?.risk != null) {
    return `Current route risk estimate: ${state.lastRouteSummary.safest.risk}/100.`;
  }
  return "Route risk estimate unavailable.";
}

function buildSupportResponse(transcript) {
  const cleaned = transcript.trim();
  const lowered = cleaned.toLowerCase();

  const highRiskSignals = ["follow", "attacked", "hurt", "danger", "threat", "weapon", "can't breathe", "kidnap"];
  const hasHighRiskSignal = highRiskSignals.some((signal) => lowered.includes(signal));

  const opening = hasHighRiskSignal
    ? "I hear you, and your safety matters right now. If you are in immediate danger, call emergency services right now (UK: 999/112)."
    : "Thank you for sharing this. You are not overreacting—your safety and feelings matter.";

  const middle = cleaned
    ? `You said: "${cleaned.slice(0, 260)}${cleaned.length > 260 ? "…" : ""}"`
    : "I don't have details yet, but we can still take calm, practical safety steps.";

  const context = getSafetyContextLabel();

  const closing = hasHighRiskSignal
    ? "Prioritize moving toward a populated, well-lit place and contact someone you trust now."
    : "If it helps, stay on this page, keep your location on, and reach out to a trusted contact while you ground yourself.";

  const response = `${opening}\n\n${middle}\n${context}\n\n${closing}`;

  const steps = hasHighRiskSignal
    ? [
      "Move to a safer public location with people nearby.",
      "Call emergency services (UK: 999/112) and share your location.",
      "Contact a trusted person and stay on the phone.",
      "Keep your phone charged and avoid isolated routes.",
    ]
    : [
      "Take 5 slow breaths (inhale 4 sec, exhale 6 sec).",
      "Name 5 things you can see, 4 you can feel, 3 you can hear.",
      "Message a trusted person your current location.",
      "If concern increases, call emergency services immediately.",
    ];

  return { response, steps };
}

function clearSupportSteps() {
  $("supportSteps").innerHTML = "";
}

function setSupportSteps(steps) {
  clearSupportSteps();
  for (const step of steps) {
    const li = document.createElement("li");
    li.textContent = step;
    $("supportSteps").appendChild(li);
  }
}

function stopVoiceSupport() {
  if (state.supportRecognition && state.supportIsListening) {
    state.supportRecognition.stop();
  }
  state.supportIsListening = false;
  setStatus($("supportStatus"), "Voice input stopped.");
}

function startVoiceSupport() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setStatus($("supportStatus"), "Voice input is not supported in this browser. You can type your check-in instead.");
    return;
  }

  if (!state.supportRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "en-GB";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      $("supportTranscript").value = `${$("supportTranscript").value} ${transcript}`.trim();
    };

    recognition.onerror = () => {
      setStatus($("supportStatus"), "Voice input had an error. You can keep typing instead.");
      state.supportIsListening = false;
    };

    recognition.onend = () => {
      if (state.supportIsListening) {
        recognition.start();
      }
    };

    state.supportRecognition = recognition;
  }

  state.supportIsListening = true;
  state.supportRecognition.start();
  setStatus($("supportStatus"), "Listening… speak naturally and your words will be transcribed.");
}


function generateSupportResponse() {
  const transcript = $("supportTranscript").value.trim();
  const { response, steps } = buildSupportResponse(transcript);
  $("supportOutput").textContent = response;
  setSupportSteps(steps);
  setStatus($("supportStatus"), "Support response ready.");
}

function speakSupportResponse() {
  const text = $("supportOutput").textContent || "";
  if (!text || text === "(nothing yet)") {
    setStatus($("supportStatus"), "Generate a support response first.");
    return;
  }

  if (!("speechSynthesis" in window)) {
    setStatus($("supportStatus"), "Speech playback is not available in this browser.");
    return;
  }

  window.speechSynthesis.cancel();
  const msg = new SpeechSynthesisUtterance(text);
  msg.rate = 0.95;
  msg.pitch = 1;
  window.speechSynthesis.speak(msg);
  setStatus($("supportStatus"), "Reading support response aloud.");
}

// ---------- Boot ----------
function wireUi() {
  // Tabs
  for (const b of document.querySelectorAll(".tab")) {
    b.addEventListener("click", () => setTab(b.dataset.tab));
  }

  // Route
  $("useMyLocation").addEventListener("click", useMyLocation);
  $("startSearch").addEventListener("click", searchStartLocation);
  $("start").addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchStartLocation();
  });
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

  // SOS voice
  $("startSosVoice").addEventListener("click", startSosVoice);
  $("stopSosVoice").addEventListener("click", stopSosVoice);
  $("speakSos").addEventListener("click", speakSos);
  // AI Support
  $("startVoiceSupport").addEventListener("click", startVoiceSupport);
  $("stopVoiceSupport").addEventListener("click", stopVoiceSupport);
  $("generateSupport").addEventListener("click", generateSupportResponse);
  $("speakSupport").addEventListener("click", speakSupportResponse);
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