# AegisGrid Hackathon MVP (Turnkey)

This is a **hackathon-friendly** prototype of the AegisGrid concept:

- **Safer routing**: compares OSRM route alternatives and picks the lowest “risk score”.
- **Community reports**: drop pins (broken streetlight / harassment hotspot / etc.) stored locally.
- **SOS generator**: produces a shareable emergency message from your live location.
  - If you set an `OPENAI_API_KEY`, it will generate SOS content with OpenAI’s **Responses API**.
  - Otherwise it uses a safe non-AI template.

> ⚠️ Demo only — not a safety guarantee. If you are in immediate danger: call local emergency services (UK: 999/112).

---

## 1) Requirements

- **Node.js 18+** (recommended: latest LTS)
- Internet connection (for maps + routing + geocoding)

---

## 2) Run locally (3 commands)

In this folder:

```bash
npm install
cp .env.example .env
npm start
```

Then open:

- http://localhost:3000

---

## 3) (Optional) Enable AI SOS generation

Edit `.env` and set:

- `OPENAI_API_KEY=...`

You can also change:

- `OPENAI_MODEL=gpt-5.2` (default)

The server uses the OpenAI JavaScript SDK and calls `client.responses.create(...)`.

---

## 4) Notes (important)

### Nominatim user-agent
Nominatim requests require a clear User-Agent/contact. Update this in `.env`:

- `NOMINATIM_USER_AGENT="AegisGridHackathon/0.1 (contact: your-email@example.com)"`

### Data storage
Reports are stored in **your browser’s localStorage** only (no database).

### Routing
Routing is done via the public OSRM demo server (`router.project-osrm.org`) using the **driving** profile (close enough for demo).

---

## 5) What to demo to judges (script)

1. Set your location → search destination → show **fastest** vs **safest** route.
2. Go to **Report** → tap map → save “Broken streetlight” near a route → recompute routes → risk changes.
3. Go to **SOS** → generate message → copy/share.

---

## 6) File structure

- `server.js` – Express server + API routes
- `public/` – static front-end (Leaflet map, UI)
- `.env.example` – environment variable template