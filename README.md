# CRASH - Chennai Road Accident Safety Hub

CRASH is a web application for exploring and analyzing road accidents across Greater Chennai. It visualizes accident hotspots on an interactive map, provides analytics and risk rankings for major junctions, allows citizen accident reporting, and includes predictive simulations to identify emerging high-risk areas.

## Features

- Interactive Leaflet map with severity-weighted accident hotspots
- Analytics dashboard with Chart.js visualizations
- Junction risk profiles and hotspot rankings
- Filtering by severity, weather, cause, time, and more
- Predictive hotspot simulation (1–24 months)
- PDF safety report generation
- Citizen reporting with MongoDB sync and local storage fallback
- Live report updates without page reloads

## Pages

- `index.html` – Main application
- `dashboard.html` – Hotspot map
- `analytics.html` – Charts and statistics
- `compare.html` – Area comparison

## Tech Stack

**Frontend**
- HTML
- CSS
- JavaScript
- Leaflet
- Chart.js
- jsPDF

**Backend**
- FastAPI
- MongoDB Atlas
- PyMongo

## Dataset

`data/accidents.json` contains a synthetic accident dataset covering Greater Chennai from July 2024 to June 2026. The locations are based on real junctions, but the incidents are simulated for demonstration purposes.

To regenerate the dataset:

```bash
python data/_generate_final.py
```

## License

This project was developed for educational and demonstration purposes.