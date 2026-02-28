import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import OpenAI from "openai";
import pg from "pg";

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;

// Set these to identify your project to Nominatim (required by their usage policy).
// Replace with your actual contact info before any public demo/deployment.
const NOMINATIM_UA =
  process.env.NOMINATIM_USER_AGENT ||
  "AegisGridHackathon/0.1 (contact: you@example.com)";

// Public OSRM demo server (driving profile). Good enough for hackathon demos.
const OSRM_BASE =
  process.env.OSRM_BASE || "https://router.project-osrm.org";

const ROUTING_BACKUPS = [
  OSRM_BASE,
  "https://routing.openstreetmap.de/routed-car",
];

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

function normalizeGeocodeResult(r) {
  const lat = Number(r?.lat);
  const lon = Number(r?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const display_name = clampStr(String(
    r?.display_name || r?.formatted || r?.name || "Unknown location"
  ), 400);

  return {
    lat: String(lat),
    lon: String(lon),
    display_name,
  };
}

function summarizeUpstreamBody(text) {
  const src = String(text || "");
  const withoutTags = src.replace(/<[^>]+>/g, " ");
  const compact = withoutTags.replace(/\s+/g, " ").trim();
  if (!compact) return "empty response";
  return clampStr(compact, 160);
}

async function fetchJsonWithTimeout(url, { headers = {}, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const text = await resp.text();

    if (!resp.ok) {
      const detail = summarizeUpstreamBody(text);
      throw new Error(`HTTP ${resp.status} ${resp.statusText || ""} (${detail})`.trim());
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Invalid JSON from upstream provider");
    }
  } finally {
    clearTimeout(t);
  }
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

// --- Geocoding proxy ---
app.get("/api/geocode", async (req, res) => {
  try {
    const q = clampStr(req.query.q ?? "", 160).trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const key = `geocode:${q}`;
    const cached = cacheGet(key);
    if (cached) return res.json(cached);

    const providers = [
      {
        name: "nominatim",
        url:
          `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(q)}`,
        headers: {
          "User-Agent": NOMINATIM_UA,
          "Accept-Language": "en",
        },
        mapResults: (data) => Array.isArray(data) ? data : [],
      },
      {
        name: "maps.co",
        url: `https://geocode.maps.co/search?q=${encodeURIComponent(q)}&limit=5`,
        headers: {
          "User-Agent": NOMINATIM_UA,
        },
        mapResults: (data) => Array.isArray(data) ? data : [],
      },
    ];

    const failures = [];

    for (const p of providers) {
      try {
        const data = await fetchJsonWithTimeout(p.url, { headers: p.headers });
        const normalized = p.mapResults(data).map(normalizeGeocodeResult).filter(Boolean);
        if (normalized.length > 0) {
          cacheSet(key, normalized);
          return res.json(normalized);
        }
        failures.push(`${p.name}: no results`);
      } catch (err) {
        failures.push(`${p.name}: ${String(err)}`);
      }
    }

    return res.status(502).json({
      error: "Geocode failed",
      detail: failures.join(" | "),
    });
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

    const providers = [
      {
        name: "nominatim",
        url:
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
        headers: {
          "User-Agent": NOMINATIM_UA,
          "Accept-Language": "en",
        },
        mapResult: (data) => ({ display_name: clampStr(String(data?.display_name || ""), 400) }),
      },
      {
        name: "maps.co",
        url: `https://geocode.maps.co/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`,
        headers: {
          "User-Agent": NOMINATIM_UA,
        },
        mapResult: (data) => ({ display_name: clampStr(String(data?.display_name || data?.formatted || ""), 400) }),
      },
    ];

    const failures = [];

    for (const p of providers) {
      try {
        const data = await fetchJsonWithTimeout(p.url, { headers: p.headers });
        const mapped = p.mapResult(data);
        if (mapped.display_name) {
          cacheSet(key, mapped);
          return res.json(mapped);
        }
        failures.push(`${p.name}: empty address`);
      } catch (err) {
        failures.push(`${p.name}: ${String(err)}`);
      }
    }

    return res.status(502).json({
      error: "Reverse geocode failed",
      detail: failures.join(" | "),
    });
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

    const failures = [];

    for (const base of ROUTING_BACKUPS) {
      const url =
        `${base}/route/v1/driving/${start};${end}` +
        `?overview=full&geometries=geojson&steps=false` +
        `&alternatives=${alternatives ? "true" : "false"}`;

      try {
        const data = await fetchJsonWithTimeout(url, {
          headers: { "User-Agent": NOMINATIM_UA },
          timeoutMs: 15000,
        });

        if (data?.code === "Ok" && Array.isArray(data?.routes) && data.routes.length > 0) {
          cacheSet(key, data);
          return res.json(data);
        }

        failures.push(`${base}: response missing routes`);
      } catch (err) {
        failures.push(`${base}: ${String(err)}`);
      }
    }

    return res.status(502).json({
      error: "Route failed",
      detail: failures.join(" | "),
    });
  } catch (err) {
    res.status(500).json({ error: "Route error", detail: String(err) });
  }
});

// --- Reports ---
// GET /api/reports  — fetch all reports (newest first, cap at 500)
app.get("/api/reports", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, lat, lon, category, severity, note, EXTRACT(EPOCH FROM created_at)*1000 AS created_at FROM reports ORDER BY created_at DESC LIMIT 500"
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to load reports", detail: String(err) });
  }
});

// POST /api/reports  — save a new report
app.post("/api/reports", async (req, res) => {
  try {
    const body = req.body ?? {};
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const category = clampStr(body.category ?? "", 100).trim();
    const severity = Math.max(1, Math.min(3, Math.round(Number(body.severity) || 2)));
    const note = clampStr(body.note ?? "", 800).trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: "Missing/invalid lat/lon" });
    }
    if (!category) {
      return res.status(400).json({ error: "Missing category" });
    }

    const { rows } = await pool.query(
      `INSERT INTO reports (lat, lon, category, severity, note)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, lat, lon, category, severity, note, EXTRACT(EPOCH FROM created_at)*1000 AS created_at`,
      [lat, lon, category, severity, note]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to save report", detail: String(err) });
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
