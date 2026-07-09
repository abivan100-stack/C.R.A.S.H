# CRASH - Chennai Road Accident Safety Hub

CRASH (Chennai Road Accident Safety Hub) is a web-based road accident analysis platform for Greater Chennai. It combines interactive mapping, statistical analysis, predictive simulation, and citizen reporting to help identify accident hotspots, understand crash patterns, and support data-driven road safety planning.

The platform transforms accident data into actionable insights through hotspot detection, junction risk analysis, trend visualization, and safety recommendations.

---

## Features

### Interactive Accident Map

- Interactive Leaflet map covering Greater Chennai
- Severity-weighted accident markers
- Ranked accident hotspots
- Junction clustering
- Detailed incident popups
- CARTO basemap integration

### Advanced Filtering

Accident records can be filtered by:

- Severity
- Data source
- Time of day
- Day of week
- Weather conditions
- Contributing cause
- Vehicle type
- Date range

All maps, charts, and statistics update dynamically based on the selected filters.

### Junction Risk Profiles

Each major junction includes:

- Total accident count
- Severity distribution
- Peak accident hours
- Weekly accident trends
- Weather analysis
- Vehicle involvement
- Contributing causes
- Overall risk score
- Recommended safety interventions

### Hotspot Detection

The application automatically identifies:

- Highest-risk junctions
- Emerging accident hotspots
- Areas with increasing accident frequency
- Locations requiring priority intervention

Hotspots are ranked using a severity-weighted scoring model rather than simple accident counts.

### Analytics Dashboard

Interactive dashboards provide insights into:

- Accident trends over time
- Severity distribution
- Contributing causes
- Weather impact
- Vehicle involvement
- Time-of-day distribution
- Day-of-week distribution
- Geographic density heatmaps

Visualizations are generated using Chart.js and respond instantly to active filters.

### Predictive Simulation

Simulation mode estimates future accident concentrations over a configurable time horizon.

Features include:

- Forecast period from 1 to 24 months
- Projected hotspot growth
- Future risk visualization
- Planning support for infrastructure improvements

Simulation results are intended for planning and demonstration purposes.

### Citizen Reporting

Users can submit accident reports directly through the application.

Features include:

- MongoDB Atlas synchronization
- Browser-based local storage fallback
- Live report updates
- Separate visualization of community-submitted reports

### PDF Report Generation

Generate downloadable reports containing:

- City-wide summaries
- Area-specific analysis
- Junction rankings
- Severity statistics
- Recommended interventions
- Supporting charts and visualizations

---

## Pages

| Page | Description |
|------|-------------|
| `index.html` | Main application containing Map, Analytics, Reports, and Simulation modules |
| `dashboard.html` | Dedicated interactive hotspot map |
| `analytics.html` | Statistical dashboard and visualizations |
| `compare.html` | Side-by-side comparison of selected areas or junctions |

---

## Technology Stack

### Frontend

- HTML5
- CSS3
- JavaScript (Vanilla)
- Leaflet
- Chart.js
- jsPDF
- CARTO Basemaps
- Google Fonts

### Backend

- FastAPI
- PyMongo
- MongoDB Atlas

---

## Architecture

```
Browser
    │
    ▼
FastAPI Server
    ├── Static Frontend
    ├── REST API
    └── MongoDB Atlas
```

The FastAPI server delivers both the frontend application and backend REST API, allowing the project to run from a single origin.

---
## Configuration

To enable cloud synchronization for citizen reports, add your MongoDB Atlas connection string to `.env`.

```env
MONGODB_URI=your_connection_string
```

Without MongoDB, the application continues to function normally. Interactive mapping, analytics, filtering, and simulation remain available, while citizen reports are stored locally in the browser.

---

## Dataset

The project includes a synthetic accident dataset located at:

```
data/accidents.json
```

Dataset characteristics:

- Geographic coverage: Greater Chennai
- Time period: July 2024 – June 2026
- Real junction locations
- Simulated accident severity
- Weather conditions
- Vehicle categories
- Contributing causes
- Temporal information

The dataset is designed for demonstration and development purposes and is not an official accident database.

---

## Regenerating the Dataset

Generate a new synthetic dataset using:

```bash
python data/_generate_final.py
```

The generator produces statistically realistic accident records while maintaining plausible spatial and temporal distributions.

---

## Project Structure

```
CRASH/
├── backend/
├── data/
├── css/
├── js/
├── assets/
├── index.html
├── dashboard.html
├── analytics.html
├── compare.html
└── README.md
```

---

## Disclaimer

- Accident records included with the project are simulated.
- Junction locations correspond to real locations within Greater Chennai.
- Safety recommendations are planning estimates generated from observed accident patterns.
- Citizen reports are community submissions and are displayed separately from the simulated dataset.
- The platform is intended for educational, research, and demonstration purposes.