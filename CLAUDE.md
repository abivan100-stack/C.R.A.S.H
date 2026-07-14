# C.R.A.S.H — Chennai Road Accident Hotspot Analysis

A web application that maps every road accident in Chennai, ranks the
deadliest junctions, diagnoses *why* each one is dangerous, and tells
authorities where to spend the road-safety budget first. It also lets
citizens report accidents, simulates future risk, and includes an AI
assistant.

**Core thesis:** not just *where* crashes happen — *where to fix first*.
Reframes road safety as a budget-allocation problem: a large share of a
city's severe crashes concentrate in a small number of junctions, so
prioritising the worst ~10 saves the most lives for the least cost.

**Competition:** TechnoXian INNOVATIONS (AICRA), Junior category (ages 8–16).
Judged on innovation, creativity/uniqueness, and future scope.
**Team VAN:** Raghav Krishna G, Abivan Vijaykumar, Pranav P.
**Repo:** `abivan100-stack/C.R.A.S.H`, deploys the `main` branch on Render.

---

## Tech stack

**Frontend** — vanilla HTML/CSS/JavaScript. No framework, no build step.
This is deliberate: reliability, and Leaflet fights React/Vue for DOM
control. Libraries: Leaflet 1.9.4 (map engine) + Leaflet.heat, Chart.js
4.4.1 (analytics), jsPDF + jsPDF-AutoTable 3.8.4 (PDF export). Fonts via
Google Fonts.

**Backend** — FastAPI + Uvicorn, Python 3.12.7. Libraries: Pydantic
(validation), PyMongo + dnspython (MongoDB driver), anthropic (AI SDK),
python-dotenv, truststore. Excel export is hand-built from the **standard
library only** (`zipfile`, `xml.sax.saxutils`, `io`) — no pandas, no
openpyxl. CSV export uses the stdlib `csv` module.

**Deployment** — Render, one Python web service, **single origin**: the
same FastAPI service serves the static frontend AND the API from one
address. This removes CORS entirely and was the fix for an earlier
cross-device notification bug. Region: Singapore. Health check: `/health`.

**Data** — `data/accidents.json`: ~10,000 simulated-but-realistically-modeled
records, anchored to 15+ real Chennai junctions (Kathipara, Guindy, Adyar,
Koyambedu, Anna Salai, Velachery, Tambaram, Porur, Vandalur, Poonamallee,
Saidapet, Teynampet, Padi, and more), covering Jul 2024–Jun 2026. Seeded
(`random.seed(42)`) for reproducibility. Realistic correlations baked in:
over-speeding is the top cause; two-wheelers ~40% of vehicles involved;
hit-and-runs skew night; potholes skew rain/fog; lorries skew fatal; night
and rain increase severity. This dataset is served as a **static file** —
the backend never reads or queries it.

**Database** — MongoDB Atlas. The **only** live, stateful store — used
exclusively for citizen-submitted reports (collections: `accidents_db` /
`citizen_reports`). Justified specifically because cross-device report
sync needs a real server; nothing else in the app needs a database.

**AI** — Anthropic API, model `claude-sonnet-4-6`, powers the C.R.A.S.H
Bot. **Critical principle: "the AI translates, the code counts."** The
frontend sends a data digest + the user's question to `/ask`; the model
returns a strict JSON *filters* object (never a number); the backend
validates it against fixed vocabularies; the frontend applies the filters
and does the actual counting. The AI can never fabricate a statistic.

---

## Application architecture

Three tiers:
1. **Browser** — runs the SPA (map, analytics, report form, simulation,
   AI chat UI). Fetches map tiles **directly** from CARTO/OpenStreetMap
   (not through our server). Computes the hotspot engine and
   nearest-hospital distances **client-side** — grids the city into
   ~250 m cells, severity-weights each (fatal ×3, serious ×2, slight ×1),
   ranks the top 10 worst-first. No runtime dependency for this core path,
   so the map keeps working even if the server or network is down.
2. **Server** — one FastAPI service on Render, single origin. Internally
   split into static-file serving (site + dataset) and API routes.
3. **External services** — MongoDB Atlas (citizen reports) and the
   Anthropic API (AI assistant), called server-side only.

### API endpoints
| Method & path | Purpose |
|---|---|
| `GET /health` | Confirms MongoDB is reachable |
| `POST /report` | Saves a citizen-submitted report (Pydantic-validated) |
| `GET /reports` | Lists all reports (polled ~every 8s for cross-device sync) |
| `GET /export/xlsx` | Downloads all reports as a hand-built Excel file |
| `POST /ask` | AI: question + digest → validated filter JSON |

### Data model — accident record (static dataset)
`id, lat, lng, severity (fatal/serious/slight), datetime, weather
(clear/rain/fog), cause (11 types), vehicle (8 types), area`

### Data model — citizen report (MongoDB)
`_id, lat, lng, severity, cause, vehicle, datetime, created_at`

### Frontend file map
`app.js` (map + hotspot engine), `analytics.js` (charts), `simulate.js`
(Monte Carlo projection), `report.js` / `notifications.js` (report form +
cross-device polling), `bot.js` (AI chat UI), `intervention-model.js`
(shared fix/cost logic used by multiple pages so recommendations never
diverge).

---

## OFF-LIMITS — never modify without explicit permission

- `backend/`, all `data/` files, `.env`, `render.yaml`,
  `requirements.txt`, `package.json`, any config file.
- Never rename, remove, or repurpose an existing element ID, class name,
  JS function, or variable that other code depends on.
- Never create duplicate or parallel files instead of editing the real one.
- Never touch anything not explicitly asked for, even if it looks related.

---

## How I want you to work

- **Work in phases.** Phase 0 = map the relevant files and propose an
  exact plan; wait for my approval before writing any code.
- **Pause after every phase** so I can test. Do not chain phases together
  without my go-ahead.
- **Before editing any file, name it** and confirm it isn't in the
  off-limits list above.
- **Commit at the end of each phase** with a conventional message
  (`feat:` / `fix:` / `style:` / `docs:`).
- **Never run `git push` until I explicitly say "no bugs."** This is a
  hard gate, not a suggestion.
- **Give me honest pushback.** If a request is fragile, over-engineered,
  or likely to break something, say so plainly instead of just agreeing.
  I'd rather hear it than find out after pushing.
- **Prefer the simple, demo-safe option.** Reliability beats flashiness —
  this app needs to work live in front of judges with no internet hiccups
  or flaky dependencies breaking it.
- **Avoid over-engineering.** Recurring anti-patterns to push back on: a
  database for static data, a frontend framework, unnecessary abstractions,
  or local installers instead of already-working cloud services.
- I'm a school student, time-pressured near the competition. I prefer
  **short, copy-pasteable answers** over long explanations, unless I ask
  for detail.

---

## Design language — "editorial civic-intelligence broadsheet"

Warm printed-paper aesthetic, not a clinical SaaS look.

**Colors (light, default):** canvas `#F4F0E7` · surface `#FCFAF4` ·
surface-2 `#EBE5D8` · border `#D9D1C1` · text `#221F18` · text-muted
`#6E675A` · accent (steel-blue) `#2F5C87` · accent-ink `#FCFBF8` ·
row-hover `#EFEADE`.
**Colors (dark toggle):** canvas `#16191D` · surface `#1E232A` · border
`#333B44` · text `#ECEAE4` · accent `#6FA3D0`.
**Severity (data only, never UI chrome):** fatal `#BE2F2A` · serious
`#CE8A2E` · slight = existing amber/yellow.
**Secondary accent (external services / comparisons):** ochre `#A9773C`.

**Typography:** headings in a serif (Newsreader, weight 600, tight
tracking, occasional italic emphasis); body in Roboto; all numbers,
coordinates, and scores in IBM Plex Mono (tabular figures); eyebrows
uppercase with wide letter-spacing.

**Shape:** near-sharp corners (3px radius), 1px warm hairline borders
instead of heavy shadows, flat cards by default. Thin-line icons only
(1.5–1.6px stroke), never emoji.

**Map:** CARTO Positron (light) as the default basemap, matching dark
tiles on the dark-theme toggle.

---

## Deploy reference

```
Build:  pip install -r backend/requirements.txt
Start:  uvicorn backend.main:app --host 0.0.0.0 --port $PORT
Env:    MONGODB_URI · ANTHROPIC_API_KEY · PYTHON_VERSION=3.12.7
```

---

## Project status / reference docs

The editorial design-language redesign has been applied via a CSS-only
re-skin (branch `style/editorial-redesign`), following a
`DESIGN_LANGUAGE.md` spec. Matching reference PDFs already exist for this
project: Application Architecture, System Architecture (diagram),
Technology Stack, and a "How the Architecture Works" glossary — all in
the design language above.

**Still outstanding:** browser geolocation in the Report tab, the full
C.R.A.S.H Bot build-out, a judge Q&A cheat-sheet, a presentation deck and
3-speaker script, and a GitHub `v1.0.0` release tag.

**Keep this file up to date** — when something durable changes (a
feature ships, a rule changes), edit this file and commit it. A stale
`CLAUDE.md` is worse than none, since future sessions will trust it.
