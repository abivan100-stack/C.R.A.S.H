# CRASH Citizen Reports API

FastAPI backend for citizen-submitted accident reports. It stores reports in
MongoDB and serves the static frontend from the same origin.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Check MongoDB connectivity. |
| GET | `/reports` | Return all citizen reports as JSON. |
| POST | `/report` | Validate and store one citizen report. |

Reports are stored in the `accidents_db` database, `citizen_reports` collection.

## Run Locally

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate
pip install -r requirements.txt

cp .env.example .env
uvicorn main:app --reload
```

Open:

- <http://localhost:8000/health>
- <http://localhost:8000/reports>
- <http://localhost:8000/docs>

Set `MONGODB_URI` in `.env` before running the API with database sync enabled.

## Security

- Keep `MONGODB_URI` in environment variables only.
- Do not expose database credentials to the frontend.
- Restrict CORS to the deployed frontend domain before production use.
