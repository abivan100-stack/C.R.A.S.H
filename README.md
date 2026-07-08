# CRASH — Chennai Road Accident Safety Hub

An interactive road-accident hotspot analysis tool for Greater Chennai. A live
Leaflet map ranks the deadliest junctions by a severity-weighted risk score,
flags where risk is climbing, and turns every hotspot into an evidence-based
intervention — with a full analytics page behind it.

**Pages**
- `index.html` — landing page
- `dashboard.html` — live map: ranked danger index, zone dossiers, filters, emerging hotspots, city strategy
- `analytics.html` — detailed charts across every dimension (Pareto, severity, cause, vehicle, time, weather, geography, emerging, interventions)

## Features

- **Live hotspot map** — CARTO dark/light basemap with ~7,300 severity-coloured incident points and signature "risk bloom" markers for the top-10 junctions.
- **Ranked danger index** — 250 m grid cells scored by severity (fatal ×3, serious ×2, slight ×1), non-max-suppressed to 10 distinct junctions.
- **Live filters** — severity, time of day, weather, day of week, contributing cause; the whole engine recomputes on every change.
- **Zone dossier** — per-junction severity, hourly/weekday patterns, causes, vehicles, weather, and a recommended intervention.
- **Emerging hotspots (prediction)** — cells whose recent-6-month rate has jumped ≥1.5× their prior-18-month baseline, shown with pulsing markers and a watch list.
- **Intervention engine** — a leverage stat ("~30% of severe crashes sit in 10 junction cells"), a cost-tiered priority queue, and an estimate of preventable severe crashes per fix.
- **Analytics page** — 13 Chart.js charts + an hour × weekday density heatmap, all themed light/dark.

## Stack

Vanilla JS, no build step. [Leaflet](https://leafletjs.com/) for the map,
[Chart.js](https://www.chartjs.org/) (self-hosted in `vendor/`) for the charts,
CARTO basemaps, Google Fonts (Space Grotesk / IBM Plex Sans / IBM Plex Mono).

## Run locally

The pages fetch `data/accidents.json`, so serve over HTTP (not `file://`):

```bash
python -m http.server 8000
# open http://127.0.0.1:8000/
```

## Data

`data/accidents.json` is **simulated** incident data for Greater Chennai
(Jul 2024 – Jun 2026), modelled on real junction geography and traffic-police
severity/cause patterns to demonstrate the analysis pipeline — it is not an
official record. Regenerate it with `python data/_generate_final.py`.
Intervention impact figures are indicative planning estimates, not measured outcomes.
