# CRASH — Chennai Road Accident Safety Hub

A single-origin web application that maps road accidents across Greater Chennai,
ranks the deadliest junctions by severity-weighted risk score, and turns every
hotspot into an evidence-based intervention recommendation. Includes analytics
dashboards, area comparison, citizen reporting, Monte Carlo simulation, and an
AI data assistant.

## Features

- **Interactive hotspot map** — Leaflet-based map with severity-coded incident
  points, ranked risk blooms, and emerging-hotspot pulse markers
- **Ranked danger index** — Top-10 junction cells scored by severity weighting
  (fatal ×3, serious ×2, slight ×1)
- **Live filters** — Slice by severity, time of day, weather, day of week, and
  cause without page reload
- **Zone dossiers** — Click any cell for its severity split, temporal rhythm,
  weather mix, and matched intervention
- **Analytics studio** — Chart.js visualisations covering severity, cause,
  vehicle, timing, weather, Pareto concentration, and emerging hotspots
- **Area comparison** — Side-by-side head-to-head of any two areas on every
  dimension
- **Intervention simulation** — Monte Carlo projection (1–24 months) with
  configurable weather and enforcement scenarios
- **Citizen reporting** — Report form with fullscreen map picker, cross-device
  synchronisation via MongoDB, and live notification feed
- **C.R.A.S.H Bot** — AI assistant that answers natural-language questions
  about the dataset (translates queries to validated filter objects)
- **PDF report export** — City-wide or per-zone safety reports via jsPDF
- **Dark/light theme** — Persistent toggle across all views with MapTiler base
  map matching

## Technology Stack

### Frontend
| Layer | Technology |
|---|---|
| Runtime | Vanilla HTML/CSS/JS (no framework, no build step) |
| Map engine | Leaflet 1.9.4 + Leaflet.heat |
| Charts | Chart.js 4.4.1 |
| PDF export | jsPDF + jsPDF-AutoTable |
| Tile layer | MapTiler (streets-v2 / streets-v2-dark) |
| Fonts | Newsreader (display), Roboto (body), IBM Plex Mono (tabular numbers) |

### Backend
| Component | Technology |
|---|---|
| Server | FastAPI + Uvicorn (Python 3.12.7) |
| Database | MongoDB Atlas (citizen reports only) |
| AI | Anthropic API (`claude-sonnet-4-6`) |
| Validation | Pydantic |
| Excel export | Standard library only (zipfile, xml.sax.saxutils) |

### Infrastructure
- **Single origin** — the same FastAPI service serves the static frontend AND
  the API from one address (no CORS needed)
- **Deployment** — Render (Python web service, free tier, region: Singapore)
- **No database for static data** — the 10k-record accident dataset is served as
  a static JSON file; only citizen reports use MongoDB

## Architecture

```
Browser (SPA)                  Server (FastAPI)              External
┌─────────────────────┐       ┌─────────────────────┐       ┌──────────┐
│ Leaflet map         │──────→│ / → static files    │       │ MongoDB  │
│ Chart.js analytics  │       │                     │←─────→│ Atlas    │
│ Hotspot engine      │       │ /report  (POST)     │       └──────────┘
│ (client-side grid   │       │ /reports (GET)      │
│  + ranking)         │       │ /health  (GET)      │       ┌──────────┐
│ CRASH Bot chat UI   │──────→│ /ask     (POST)     │──────→│ Anthropic│
│ Simulation engine   │       │ /export/xlsx (GET)  │       │ API     │
└─────────────────────┘       └─────────────────────┘       └──────────┘
      │
      ├── Map tiles (CARTO / MapTiler — direct from CDN, not through server)
      └── Static data (data/accidents.json — fetched at boot)
```

The hotspot engine runs entirely client-side: it grids the city into ~250 m
cells, severity-weights each incident, applies non-max suppression, and ranks
the top 10. No server dependency for the core map path.

## Getting Started

### Prerequisites
- Python 3.12+
- MongoDB Atlas URI (optional — app runs without it; required only for
  citizen reports)
- Anthropic API key (optional — required only for C.R.A.S.H Bot)

### Setup

```bash
# Clone the repository
git clone https://github.com/abivan100-stack/C.R.A.S.H.git
cd C.R.A.S.H

# Create and activate a Python virtual environment
python -m venv .venv
source .venv/Scripts/activate      # Windows (Git Bash)
# source .venv/bin/activate        # macOS / Linux

# Install backend dependencies (exact pinned versions)
pip install -r backend/requirements.txt

# Test-only tooling, not needed to run the app
pip install pytest httpx ruff mongomock

# Configure environment variables (optional for basic map + analytics)
cp backend/.env.example backend/.env
# Edit backend/.env with your MONGODB_URI and ANTHROPIC_API_KEY
```

`backend/requirements.txt` is **fully pinned**. Upgrade deliberately —
`pip install -U <package>`, run the suite, then commit the new pin on its own.

### Run locally

```bash
npm start
```

This starts Uvicorn with hot reload at `http://localhost:8000`. The backend
serves both the API and the static frontend on a single origin.

The app runs with **no environment variables at all** — the map, analytics,
comparison and simulation need none of them. Only citizen reports (MongoDB) and
the AI bot (Anthropic) require configuration, and both degrade cleanly when it
is absent.

### Test, lint and verify

There is no build step. These four commands are the whole gate, and all four
must be green before anything is committed:

```bash
npm test            # both suites
npm run test:js     # Node's built-in runner — 83 tests, zero dependencies
npm run test:py     # pytest — 255 tests, no network calls (mongomock + stubs)
npm run lint        # ruff + a parse check on all 12 JS files
```

`npm run test:py` and `npm run lint:py` call `python`, so activate the venv
first (or they will find the system interpreter).

The JS suite runs on Node's built-in `node:test` — no jest, no vitest, no npm
dependencies at all, which is why `package.json` still has none. The shared
modules are IIFEs over `typeof window !== 'undefined' ? window : this`, so they
`require()` unchanged under CommonJS.

No test contacts a real service: MongoDB is `mongomock`, Anthropic is stubbed,
and the fetch tests stand up a local HTTP server on an ephemeral port.

### Pages

| URL | Purpose |
|---|---|
| `/landing.html` | Marketing / editorial landing page |
| `/index.html` | Main SPA (map, analytics, report, simulate, bot tabs) |
| `/dashboard.html` | Standalone hotspot map view |
| `/analytics.html` | Full analytics dashboard |
| `/compare.html` | Side-by-side area comparison |

### Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGODB_URI` | For reports | — | MongoDB Atlas connection string. A malformed value disables citizen reports only; the rest of the site still serves. |
| `ANTHROPIC_API_KEY` | For AI bot | — | Anthropic API key for `/ask`. Absent → the bot returns 503 and the UI says it is unavailable. |
| `CORS_ALLOW_ORIGINS` | No | *(empty)* | Comma-separated extra origins. Empty means same-origin only, which is correct for the normal single-service deployment. |
| `ASK_RATE_LIMIT` | No | `20` | Max `/ask` requests per IP per window. |
| `ASK_RATE_WINDOW_SECONDS` | No | `60` | The rate-limit window. |
| `ASK_TIMEOUT_SECONDS` | No | `25` | Anthropic request timeout. Keep it at or below the frontend's 30s abort. |
| `LOG_LEVEL` | No | `INFO` | Standard Python logging level. |

Secrets are set in `backend/.env` for local development (gitignored) and in the
Render service environment for production. **Never commit a real value** — the
only tracked env file is `backend/.env.example`.

### Runbook — operating the deployed service

**Logs.** Every request gets an ID, returned as `X-Request-ID` and included in
error responses as `(request abc123def456)`. To investigate a user report, take
that ID and grep the Render logs for `[req=abc123def456]` — the full cause and
traceback are there. Client-facing messages are deliberately generic; the Mongo
URI and API key are never logged.

**Known operational liability.** `render.yaml` uses `/health` as its
`healthCheckPath`, and `/health` pings MongoDB. If Atlas is down or the free-tier
database is paused, Render marks the whole service unhealthy and the entire site
goes dark — including the map and analytics, which need no database. This was
reviewed and deliberately kept; see `audit/03-deferred.md`. **If a demo goes dark,
check Atlas first.**

**Cold starts.** The Render free plan spins down after ~15 minutes idle and takes
30–60s to wake. Load the site a few minutes before any demo. The map itself
paints from the static dataset and does not wait on the backend.

**Rate limiting** on `/ask` is in-process and resets on restart, so it is a cost
guard rather than a shared quota. `X-Forwarded-For` is trusted for client
identity and is spoofable — acceptable for blunting accidental abuse, not for
defending against a determined attacker.

**The MapTiler key** in `maptiler.js` is public by design: the browser fetches
tiles directly, so the key reaches every visitor whatever you do. Restrict it to
your Render domain plus `localhost` in the MapTiler dashboard — that, not
hiding it, is the control.

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | MongoDB connectivity check |
| `POST` | `/report` | Submit a citizen accident report (Pydantic-validated) |
| `GET` | `/reports` | List all citizen reports |
| `GET` | `/export/xlsx` | Download all reports as Excel |
| `POST` | `/ask` | AI: question + data digest → validated filter JSON |

## Repository Structure

```
├── backend/
│   ├── main.py            # FastAPI server (API routes + static file mount)
│   └── requirements.txt   # Python dependencies
├── data/
│   ├── accidents.json     # ~10k synthetic records, Jul 2024 – Jun 2026
│   └── citizen_seed.json  # Pre-seeded citizen reports
├── shared/
│   ├── constants.js       # Domain constants (severity, causes, grid, tuning)
│   ├── utils.js           # Utility functions (formatting, palette, theme)
│   └── engine.js          # Computational engine (grid, ranking, emerging)
├── vendor/                # Vendored third-party libraries
│   ├── chart.umd.js
│   ├── jspdf.umd.min.js
│   ├── jspdf.plugin.autotable.min.js
│   └── leaflet-heat.js
├── app.js                 # Main SPA (map, hotspot engine, filters, dossiers)
├── analytics.js           # Chart.js analytics dashboard logic
├── compare.js             # Area comparison logic
├── bot.js                 # C.R.A.S.H Bot chat UI
├── simulate.js            # Monte Carlo intervention simulation
├── report.js              # PDF report generator
├── notifications.js       # Cross-device notification polling
├── intervention-model.js  # Fix/cost/recommendation logic (shared by pages)
├── maptiler.js            # Base tile layer (single source of key + theme)
├── *.html                 # Page shells (landing, index, dashboard, analytics, compare)
├── render.yaml            # Render deployment blueprint
└── package.json           # npm scripts (start, start:prod)
```

## Deployment

Deployed on Render as a single Python web service:

```
Build:   pip install -r backend/requirements.txt
Start:   uvicorn backend.main:app --host 0.0.0.0 --port $PORT
Health:  /health
Env:     MONGODB_URI · ANTHROPIC_API_KEY · PYTHON_VERSION=3.12.7
```

## Dataset

`data/accidents.json` contains **10,169** synthetic accident records across 30
Chennai areas, modelled on real junctions (Kathipara, Guindy, Adyar, Koyambedu,
Anna Salai, Velachery, and more), spanning **Jul 2024 – Jun 2026**. The dataset
is seeded (`random.seed(42)`) for reproducibility. Not an official record.

Severity split: **637 fatal (6.3%)**, **3,256 serious (32.0%)**, **6,276 slight
(61.7%)**.

Correlations that are genuinely present: over-speeding is the top cause, and
two-wheelers are roughly 40% of vehicles involved.

**Correction:** earlier documentation claimed "night and rain increase severity".
That is **not** in the data, and the audit measured it directly — fatal share is
6.2% at night vs 6.3% by day, 6.5% in rain vs 6.2% in clear, and 5.9% in fog,
i.e. *below* baseline. The generator fixes each area's severity mix before it
draws the time and weather, so the two are independent by construction. Don't
repeat the old claim in a presentation; a judge can check it.

Coordinates are snapped to the road network by `scripts/snap_to_roads.py`. The
`*.backup.json` files are the genuine pre-snap inputs, not stale copies —
re-running the generator alone would overwrite the snapped coordinates. See
`audit/03-deferred.md`.

## License

MIT — developed for educational and demonstration purposes.
