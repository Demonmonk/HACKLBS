import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// Set these to identify your project to Nominatim (required by their usage policy).
// Replace with your actual contact info before any public demo/deployment.
const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT ||
  "AegisGridHackathon/0.1 (contact: you@example.com)";

// Public OSRM demo server (driving profile). Good enough for hackathon demos.
const OSRM_BASE =
  process.env.OSRM_BASE || "https://router.project-osrm.org";

// Optional OpenAI key for SOS generation.
// If not provided, the app will fall back to a non-AI template.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.2";

// --- Simple in-memory cache to reduce external calls ---
const cache = new Map(); // key -> { ts, data }
const CACHE_TTL_MS = 1000 * 60 * 5; // 5 minutes

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

function clampStr(s, maxLen) {
  if (typeof s !== "string") return "";
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// --- Static site ---
// Support both ./public (documented layout) and repo-root static files.
const publicDir = path.join(__dirname, "public");
const rootDir = __dirname;

app.use(express.static(publicDir));
app.use(express.static(rootDir));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Geocoding proxy (Nominatim) ---
app.get("/api/geocode", async (req, res) => {
  try {
    const q = clampStr(req.query.q ?? "", 160).trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const key = `geocode:${q}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const url =
      `https://nominatim.openstreetmap.org/search?format=json&limit=5` +
      `&q=${encodeURIComponent(q)}`;

    const resp = await fetch(url, {
      headers: {
        "User-Agent": NOMINATIM_UA,
        "Accept-Language": "en",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: "Geocode failed", detail: text });
    }

    const data = await resp.json();
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Geocode error", detail: String(err) });
  }
});

// Reverse geocode
app.get("/api/reverse", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Missing/invalid lat/lon" });
    }

    const key = `reverse:${lat.toFixed(5)},${lon.toFixed(5)}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const url =
      `https://nominatim.openstreetmap.org/reverse?format=json` +
      `&lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lon)}`;

    const resp = await fetch(url, {
      headers: {
        "User-Agent": NOMINATIM_UA,
        "Accept-Language": "en",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: "Reverse geocode failed", detail: text });
    }

    const data = await resp.json();
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Reverse geocode error", detail: String(err) });
  }
});

// --- Routing proxy (OSRM) ---
// /api/route?start=lon,lat&end=lon,lat&alternatives=1
app.get("/api/route", async (req, res) => {
  try {
    const start = clampStr(req.query.start ?? "", 64);
    const end = clampStr(req.query.end ?? "", 64);
    const alternatives = (req.query.alternatives ?? "1") === "1";

    const validCoord = (s) =>
      /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(String(s));

    if (!validCoord(start) || !validCoord(end)) {
      return res.status(400).json({ error: "Invalid start/end. Use lon,lat." });
    }

    const key = `route:${start}->${end}:alt=${alternatives}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const url =
      `${OSRM_BASE}/route/v1/driving/${start};${end}` +
      `?overview=full&geometries=geojson&steps=false` +
      `&alternatives=${alternatives ? "true" : "false"}`;

    const resp = await fetch(url, {
      headers: { "User-Agent": "AegisGridHackathon/0.1" },
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: "Route failed", detail: text });
    }

    const data = await resp.json();
    cacheSet(key, data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Route error", detail: String(err) });
  }
});

// --- SOS generator ---
// POST /api/sos
// body: { lat, lon, address, situation, notes, routeRisk, reportsNearby }
app.post("/api/sos", async (req, res) => {
  try {
    const body = req.body ?? {};
    const lat = Number(body.lat);
    const lon = Number(body.lon);

    const address = clampStr(body.address ?? "", 240);
    const situation = clampStr(body.situation ?? "", 120);
    const notes = clampStr(body.notes ?? "", 800);
    const routeRisk = Number.isFinite(Number(body.routeRisk)) ? Number(body.routeRisk) : null;
    const reportsNearby = Array.isArray(body.reportsNearby) ? body.reportsNearby.slice(0, 10) : [];

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Missing/invalid lat/lon" });
    }

    const baseContext = {
      lat,
      lon,
      address: address || "(address unavailable)",
      time_iso: new Date().toISOString(),
      situation: situation || "(not specified)",
      notes: notes || "(none)",
      route_risk_score_0_100: routeRisk,
      nearby_reports: reportsNearby,
    };

    // Fallback template if no OpenAI key
    if (!OPENAI_API_KEY) {
      const sos = [
        "EMERGENCY / SAFETY ALERT",
        `Location: ${baseContext.address}`,
        `Coords: ${lat.toFixed(5)}, ${lon.toFixed(5)}`,
        `Situation: ${baseContext.situation}`,
        notes ? `Notes: ${notes}` : null,
      ].filter(Boolean).join("\n");

      const guidance = [
        "If you are in immediate danger: call local emergency number (e.g., UK 999/112).",
        "Move to a well-lit, populated area if it’s safe to do so. Stay on the line with a trusted contact.",
        "If followed: enter a public place, ask staff for help, and avoid going home directly.",
      ];

      const share = `${sos}\n\nSuggested steps:\n- ${guidance.join("\n- ")}`;

      return res.json({ sos, guidance, share, used_ai: false });
    }

    const client = new OpenAI({ apiKey: OPENAI_API_KEY });

    const prompt = `
You are an emergency-response writing assistant. Create a concise SOS message someone can send to a trusted contact or on-site security.

Input context (JSON):
${JSON.stringify(baseContext, null, 2)}

Requirements:
- Output MUST be valid JSON only, with keys: "sos", "guidance", "share".
- "sos": <= 450 characters, plain text, includes location (address + coords), time, situation, and 1 actionable ask (e.g. "Call me now" or "Send security to me").
- "guidance": an array of exactly 3 short bullet sentences (no more than 18 words each).
- "share": <= 800 characters. This is the SOS plus the 3 bullets formatted nicely for sharing.
- Be calm, non-graphic, and do NOT invent facts not in the input.
`;

    const response = await client.responses.create({
      model: OPENAI_MODEL,
      input: prompt,
    });

    // SDK convenience field. If not present, try to reconstruct.
    const text = response.output_text || "";
    let parsed = null;

    try {
      parsed = JSON.parse(text);
    } catch {
      // Sometimes the model returns extra text; try to extract the first JSON object.
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { /* ignore */ }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      return res.json({
        sos: "EMERGENCY / SAFETY ALERT\n" +
             `Location: ${baseContext.address}\n` +
             `Coords: ${lat.toFixed(5)}, ${lon.toFixed(5)}\n` +
             `Situation: ${baseContext.situation}\n` +
             (notes ? `Notes: ${notes}\n` : ""),
        guidance: [
          "If in immediate danger, call local emergency services now.",
          "Move to a safer, populated place if it’s safe.",
          "Stay on the line with someone you trust; keep sharing your location.",
        ],
        share: text || "AI output unavailable (parsing failed).",
        used_ai: true,
        parsing_failed: true,
        raw: text.slice(0, 2000),
      });
    }

    // Basic sanitation
    const sos = clampStr(String(parsed.sos ?? ""), 1000);
    const guidance = Array.isArray(parsed.guidance)
      ? parsed.guidance.slice(0, 3).map((s) => clampStr(String(s), 140))
      : [];
    const share = clampStr(String(parsed.share ?? ""), 3000);

    res.json({ sos, guidance, share, used_ai: true });
  } catch (err) {
    res.status(500).json({ error: "SOS error", detail: String(err) });
  }
});

// Catch-all: serve the app
app.get("*", (_req, res) => {
  const publicIndex = path.join(publicDir, "index.html");
  const rootIndex = path.join(rootDir, "index.html");
  res.sendFile(publicIndex, (err) => {
    if (!err) return;
    res.sendFile(rootIndex);
  });
});

app.listen(PORT, () => {
  console.log(`AegisGrid hackathon MVP running on http://localhost:${PORT}`);
  console.log(`OpenAI enabled: ${Boolean(OPENAI_API_KEY)} (set OPENAI_API_KEY to enable)`);
});
