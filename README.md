# CRASH — Chennai Road Accident Safety Hub

An interactive road-accident hotspot analysis tool for Greater Chennai. A live
Leaflet map ranks the deadliest junctions by a severity-weighted risk score,
flags where risk is climbing, projects future risk under different conditions,
lets citizens report accidents the map doesn't have, and turns every hotspot
into an evidence-based intervention.

**Pages**
- `index.html` — the main app: a single-page shell with **Map / Analytics / Report / Simulate** tabs, served by the FastAPI backend on one URL
- `dashboard.html`, `analytics.html`, `compare.html` — standalone versions of the map, analytics, and area-comparison views

## Features

- **Live hotspot map** — CARTO dark/light basemap with ~10,000 severity-coloured incident points and signature "risk bloom" markers for the top-10 junctions. Instant, crisp zoom on hotspot select (no flicker), with a persistent-ring style for emerging markers so they stay legible against the full point cloud.
- **Ranked danger index** — 250 m grid cells scored by severity (fatal ×3, serious ×2, slight ×1), non-max-suppressed to 10 distinct junctions.
- **Live filters** — data source (all / official records only / citizen reports only), severity, time of day, weather, day of week, contributing cause; the whole engine recomputes on every change.
- **Zone dossier** — per-junction severity, hourly/weekday patterns, causes, vehicles, weather, and a recommended intervention.
- **Emerging hotspots (prediction)** — cells whose recent-6-month rate has jumped ≥1.5× their prior-18-month baseline, shown with pulsing markers and a watch list.
- **Intervention engine** — a leverage stat ("~30% of severe crashes sit in 10 junction cells"), a cost-tiered priority queue, and an estimate of preventable severe crashes per fix.
- **Analytics page** — 13 Chart.js charts + an hour × weekday density heatmap, all themed light/dark.
- **Branded PDF reports** — one-click city-wide or single-area safety reports (KPIs, top junctions, causes, vehicles, emerging hotspots, intervention queue), generated client-side with jsPDF.
- **Simulate mode** — a Monte Carlo projection of where accidents are likely to concentrate under chosen conditions (time of day / weather / day type) over a **custom 1–24 month horizon** you type in (validated, whole months only). Each run is a fresh probabilistic realization — the projected total and hotspot counts vary slightly run to run, like real accident counts — while staying reproducible per run and instant to render even at the largest horizon.
- **Citizen reporting** — an interactive map picker (click to drop an accent pin, or pick an area as an alternative) feeds straight into the report form; submissions save to a **shared MongoDB backend** so they sync across devices, with automatic **localStorage fallback** if the backend is unreachable.
- **Live notifications** — a header bell shows a toast + badge + panel for every new citizen report. Updates are component-only (never a page reload): instant when you file a report yourself, and a quiet ~8 s background poll surfaces reports filed on *other* devices. Read/unread state and the notification list persist across reloads. Click a notification to fly the map to that report.

## Stack

Vanilla JS, no build step, no frontend framework. [Leaflet](https://leafletjs.com/) for the map,
[Chart.js](https://www.chartjs.org/) (self-hosted in `vendor/`) for the charts, [jsPDF](https://github.com/parallax/jsPDF) for reports,
CARTO basemaps, Google Fonts (Space Grotesk / IBM Plex Sans / IBM Plex Mono).

Backend: [FastAPI](https://fastapi.tiangolo.com/) + [pymongo](https://pymongo.readthedocs.io/) against MongoDB Atlas, serving both the REST API **and** the static frontend on a single origin (see `backend/README.md`).

## Run locally

This is a single-origin app — one server serves the site *and* the citizen-reports API, so run the backend, not a plain static server:

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
#   ... or:  source .venv/bin/activate                  # macOS/Linux
pip install -r requirements.txt

cp .env.example .env        # then paste your MongoDB Atlas URI into .env
uvicorn main:app --reload
# open http://127.0.0.1:8000/
```

Without a backend running, the map/analytics/simulate still work fully offline; citizen reports just fall back to this browser's localStorage instead of syncing across devices. See `backend/README.md` for endpoints, deployment, and security notes.

## Data

`data/accidents.json` is **simulated** incident data for Greater Chennai
(Jul 2024 – Jun 2026), modelled on real junction geography and traffic-police
severity/cause patterns to demonstrate the analysis pipeline — it is not an
official record. Regenerate it with `python data/_generate_final.py`.
Intervention impact figures are indicative planning estimates, not measured outcomes.
Citizen-submitted reports are community-contributed and unverified, and are marked
distinctly wherever they appear.
