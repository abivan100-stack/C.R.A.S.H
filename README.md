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
| AI | Anthropic API (Claude Sonnet 4) |
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
- MongoDB Atlas URI (optional — app runs without it; citizen reports and
  AI features require it)
- Anthropic API key (optional — required for C.R.A.S.H Bot)

### Setup

```bash
# Clone the repository
git clone https://github.com/abivan100-stack/C.R.A.S.H.git
cd C.R.A.S.H

# Create and activate a Python virtual environment
python3 -m venv venv
source venv/bin/activate

# Install backend dependencies
pip install -r backend/requirements.txt

# Configure environment variables (optional for basic map + analytics)
cp backend/.env.example backend/.env
# Edit backend/.env with your MONGODB_URI and ANTHROPIC_API_KEY
```

### Run locally

```bash
npm start
```

This starts Uvicorn with hot reload at `http://localhost:8000`. The backend
serves both the API and the static frontend on a single origin.

### Pages

| URL | Purpose |
|---|---|
| `/landing.html` | Marketing / editorial landing page |
| `/index.html` | Main SPA (map, analytics, report, simulate, bot tabs) |
| `/dashboard.html` | Standalone hotspot map view |
| `/analytics.html` | Full analytics dashboard |
| `/compare.html` | Side-by-side area comparison |

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MONGODB_URI` | For reports | MongoDB Atlas connection string |
| `ANTHROPIC_API_KEY` | For AI bot | Anthropic API key for C.R.A.S.H Bot |

Both are set in `backend/.env` for local development and in the Render service
environment for production.

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

`data/accidents.json` contains ~10,000 synthetic accident records modelled on 15+
real Chennai junctions (Kathipara, Guindy, Adyar, Koyambedu, Anna Salai,
Velachery, and more). The dataset is seeded (`random.seed(42)`) for
reproducibility and includes realistic correlations (over-speeding as top cause,
two-wheelers ~40% of vehicles, night/rain increases severity). Not an official
record.

## License

MIT — developed for educational and demonstration purposes.
