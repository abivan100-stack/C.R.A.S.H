# CRASH — Citizen Reports API

Minimal FastAPI + MongoDB backend for **citizen accident reports only**. The rest
of the dashboard (historical `accidents.json`, map, analytics, simulate) is
untouched and stays on the static frontend.

## Endpoints
| Method | Path       | Purpose |
|--------|------------|---------|
| GET    | `/health`  | Pings MongoDB; `{"status":"ok"}` when reachable |
| GET    | `/reports` | All citizen reports as a JSON array (`_id` stringified) |
| POST   | `/report`  | Validate + insert one report; returns `{"status":"ok","id":"..."}` |

Data → database `accidents_db`, collection `citizen_reports`.

## Run locally
```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
#   ... or:  source .venv/bin/activate                  # macOS/Linux
pip install -r requirements.txt

cp .env.example .env        # then paste your MongoDB Atlas URI into .env
uvicorn main:app --reload
```
Then open <http://localhost:8000/health> and <http://localhost:8000/reports>
(interactive docs at <http://localhost:8000/docs>).

## Security
- `MONGODB_URI` comes from the environment **only** — never hardcoded, never sent
  to the frontend. Locally it lives in `.env` (gitignored); in production it is a
  Render environment variable.
- CORS currently allows `*` for testing; it will be tightened to the frontend
  domain when the backend is deployed (STEP 4).
