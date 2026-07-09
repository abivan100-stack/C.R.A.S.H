# CRASH - Chennai Road Accident Safety Hub

CRASH is an interactive road-accident hotspot analysis tool for Greater Chennai.
It maps high-risk junctions, highlights emerging hotspots, supports citizen
accident reports, and generates evidence-based safety recommendations.

## Key Features

- Live Leaflet hotspot map with severity-weighted incident points and ranked junction risk.
- Filters for source, severity, time, weather, weekday, and contributing cause.
- Junction profiles covering severity, timing patterns, causes, vehicles, weather, and suggested interventions.
- Emerging-hotspot detection based on recent crash-rate increases.
- Analytics dashboards with Chart.js visualizations and density heatmaps.
- PDF safety reports for city-wide and area-specific summaries.
- Simulation mode for projecting likely crash concentrations across a 1-24 month horizon.
- Citizen reporting with MongoDB sync and local browser fallback.
- Live report notifications without page reloads.

## Pages

- `index.html` - main single-page app with Map, Analytics, Report, and Simulate tabs.
- `dashboard.html`, `analytics.html`, `compare.html` - standalone map, analytics, and area-comparison views.

## Tech Stack

- Frontend: vanilla JavaScript, Leaflet, Chart.js, jsPDF, CARTO basemaps, Google Fonts.
- Backend: FastAPI, pymongo, MongoDB Atlas.
- Deployment model: one FastAPI server serves both the REST API and static frontend.

## Run Locally

Run the backend server. It serves the app and the citizen-reports API from one origin.

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt

cp .env.example .env
uvicorn main:app --reload
```

Open <http://127.0.0.1:8000/>.

Add your MongoDB Atlas URI to `.env` to enable cross-device citizen-report sync.
Without the backend, map, analytics, and simulation features still work offline;
citizen reports are stored in the browser.

## Data

`data/accidents.json` contains simulated Greater Chennai incident data for
July 2024 through June 2026. It is based on real junction geography and typical
severity and cause patterns, but it is not an official record.

Regenerate the dataset with:

```bash
python data/_generate_final.py
```

Intervention impact figures are planning estimates. Citizen reports are
community-submitted, unverified, and shown separately from simulated records.
