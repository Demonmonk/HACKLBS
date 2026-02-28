# AegisGrid Hackathon MVP

## Overview
A hackathon-friendly prototype focused on personal safety:
- **Safer routing**: compares OSRM route alternatives and picks the lowest "risk score"
- **Community reports**: drop pins (broken streetlight / harassment hotspot / etc.) stored in browser localStorage
- **SOS generator**: produces a shareable emergency message from your live location, with optional OpenAI enhancement

## Architecture
Single Node.js/Express server (`server.js`) that serves:
- Static frontend files (`index.html`, `app.js`, `styles.css`) from the root directory
- REST API endpoints under `/api/`

**No database** — community reports are stored in browser localStorage only.

## Key Files
- `server.js` – Express server + API routes (geocoding proxy, routing proxy, SOS generator)
- `index.html` – Single-page frontend with Leaflet map
- `app.js` – Frontend JavaScript logic
- `styles.css` – Styles

## Configuration
Environment variables (set via Replit Secrets/Env Vars):
- `PORT` – Server port (set to 5000)
- `NOMINATIM_USER_AGENT` – Required by Nominatim usage policy
- `OPENAI_API_KEY` – Optional; enables AI-powered SOS generation
- `OPENAI_MODEL` – Optional; defaults to `gpt-5.2`
- `OSRM_BASE` – Optional; defaults to public OSRM demo server

## External Services
- **Nominatim** (OpenStreetMap) – geocoding/reverse geocoding
- **OSRM** (router.project-osrm.org) – routing
- **OpenAI** – optional AI SOS generation

## Running
```bash
npm install
node server.js
```
Server runs on port 5000.

## Deployment
Configured for autoscale deployment. Run command: `node server.js`
