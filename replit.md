# AegisGrid Hackathon MVP

## Overview
A personal safety web application that provides safe routing, community hazard reports, and SOS generation. Built as a Node.js/Express app serving both the API backend and static frontend from the same server.

## Architecture
- **Runtime**: Node.js (ESM modules, `"type": "module"`)
- **Server**: Express.js (`server.js`) — serves static files and API routes
- **Frontend**: Vanilla JS (`app.js`), HTML (`index.html`), CSS (`styles.css`)
- **Map**: Leaflet.js with OpenStreetMap tiles
- **Geocoding**: Nominatim (primary) + geocode.maps.co (fallback)
- **Routing**: OSRM public demo server with fallback
- **SOS AI**: OpenAI API (optional, falls back to template if key not set)

## Key Files
- `server.js` — Express server, API routes (`/api/geocode`, `/api/reverse`, `/api/route`, `/api/sos`), static file serving
- `app.js` — Frontend application logic (map, routing, reports, SOS, voice)
- `index.html` — Main HTML page
- `styles.css` — Application styles
- `package.json` — Node.js dependencies

## Configuration
- Port: `5000` (default, or via `PORT` env var)
- `OPENAI_API_KEY` — Optional, enables AI SOS generation
- `OPENAI_MODEL` — Optional, defaults to `gpt-5.2`
- `NOMINATIM_USER_AGENT` — Optional, custom user agent for Nominatim
- `OSRM_BASE` — Optional, custom OSRM routing server

## Workflow
- **Start application**: `node server.js` on port 5000 (webview)

## Deployment
- Target: autoscale
- Run: `node server.js`

## Notes
- Reports are stored in `localStorage` (browser-side only, no backend persistence)
- Risk scoring is a heuristic based on time-of-day and nearby community reports
- The app.js had corrupted/interleaved function bodies from the original repo; these were fixed during import
