# AegisGrid Hackathon MVP

A personal safety web app with safe routing, community hazard reports, and SOS generation.

## Architecture

- **Runtime**: Node.js 18+ with ESM modules (`"type": "module"`)
- **Server**: Express.js (`server.js`) — serves both the API and static frontend files
- **Frontend**: Vanilla HTML/CSS/JS (`index.html`, `app.js`, `styles.css`) — served from project root
- **Database**: PostgreSQL (Replit built-in, accessed via `DATABASE_URL`)
- **Port**: 5000 (`0.0.0.0:5000`)

## Features

- **Safe Routing**: Uses OSRM for route alternatives with heuristic risk scoring based on time-of-day and nearby reports
- **Community Reports**: Users submit hazard reports (harassment, broken lighting, etc.) saved to PostgreSQL
- **SOS Generator**: Generates emergency messages; AI-powered if `OPENAI_API_KEY` is set, otherwise uses template
- **Geocoding**: Nominatim (OpenStreetMap) with fallback to maps.co
- **Voice Input**: Web Speech API for SOS voice transcription

## Database Schema

```sql
CREATE TABLE reports (
    id SERIAL PRIMARY KEY,
    lat DOUBLE PRECISION NOT NULL,
    lon DOUBLE PRECISION NOT NULL,
    category VARCHAR(100) NOT NULL,
    severity INTEGER NOT NULL DEFAULT 2,
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Environment Variables

- `DATABASE_URL` — PostgreSQL connection string (set automatically by Replit)
- `PORT` — Server port (defaults to 5000)
- `OPENAI_API_KEY` — Optional; enables AI SOS generation
- `OPENAI_MODEL` — OpenAI model name (defaults to `gpt-5.2`)
- `NOMINATIM_USER_AGENT` — User-agent string for Nominatim API
- `OSRM_BASE` — OSRM routing server base URL

## API Endpoints

- `GET /api/health` — Health check
- `GET /api/geocode?q=...` — Forward geocoding
- `GET /api/reverse?lat=...&lon=...` — Reverse geocoding
- `GET /api/route?start=lon,lat&end=lon,lat&alternatives=1` — Routing via OSRM
- `GET /api/reports` — Fetch all reports
- `POST /api/reports` — Submit a new report
- `POST /api/sos` — Generate SOS message

## Running

```bash
node server.js
```

## Deployment

Configured for autoscale deployment with `node server.js`.
