"""CRASH — citizen accident reports API + single-origin static host.

A minimal FastAPI backend that persists citizen-submitted accident reports to
MongoDB so they can be shared across devices, AND serves the existing static site
from the same server so the whole app lives on one URL (http://localhost:8000/).
It handles REPORTS ONLY at the data layer — the historical accidents.json dataset
is just served as a static file; the backend never reads or changes it.

Security:
  * The MongoDB connection string is read from the MONGODB_URI environment
    variable ONLY — never hardcoded, never returned to the frontend.
  * For local dev, python-dotenv loads a gitignored .env (see .env.example).
  * In production (Render) MONGODB_URI is set in the service's env settings.
"""
import os

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pymongo import MongoClient

from dotenv import load_dotenv

# Local dev: load variables from a .env file if present. In production the real
# environment variables are already set, so this is a harmless no-op.
load_dotenv()

MONGODB_URI = os.environ.get("MONGODB_URI")   # NEVER hardcode — env var only
DB_NAME = "accidents_db"
COLLECTION_NAME = "citizen_reports"

# The static frontend lives one level up (…/project). Resolved from THIS file's
# path (not the CWD) so it works no matter where uvicorn is started from.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))     # …/project/backend
FRONTEND_DIR = os.path.dirname(BASE_DIR)                  # …/project (the site root)

app = FastAPI(title="CRASH Citizen Reports API")

# --- CORS ---------------------------------------------------------------------
# STEP 1: allow any origin for local testing. In STEP 4 this is tightened to the
# deployed frontend domain only. Credentials are OFF, which is required when the
# allowed origin is the "*" wildcard.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- MongoDB ------------------------------------------------------------------
# MongoClient is lazy (it doesn't dial out until the first operation), so building
# it at import time is safe even with a bad/missing URI — the error then surfaces
# on the first DB call, where we translate it into a clean HTTP error. A short
# server-selection timeout means /health and /reports fail fast instead of hanging.
_client = (
    MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, appname="crash-reports")
    if MONGODB_URI
    else None
)


def get_collection():
    """Return the citizen_reports collection, or a clear 500 if unconfigured."""
    if _client is None:
        raise HTTPException(
            status_code=500,
            detail="MONGODB_URI is not configured on the server.",
        )
    return _client[DB_NAME][COLLECTION_NAME]


# --- Schema -------------------------------------------------------------------
class Report(BaseModel):
    """A citizen accident report — the same 8-field schema as the frontend."""
    lat: float
    lng: float
    severity: str
    datetime: str
    weather: str
    cause: str
    vehicle: str
    area: str


# --- API routes ---------------------------------------------------------------
# These are registered BEFORE the static mount below, so they take precedence over
# the catch-all file handler. /health, /report and /reports never collide with any
# frontend file name.
@app.get("/health")
def health():
    """Quick connectivity check — pings MongoDB so a 200 means the DB is reachable."""
    if _client is None:
        raise HTTPException(status_code=503, detail="MONGODB_URI is not configured.")
    try:
        _client.admin.command("ping")
    except Exception as exc:  # pymongo raises on unreachable / bad-credential URIs
        raise HTTPException(status_code=503, detail=f"MongoDB unreachable: {exc}")
    return {"status": "ok"}


@app.post("/report")
def create_report(report: Report):
    """Validate the body against Report and insert it into citizen_reports."""
    collection = get_collection()
    try:
        result = collection.insert_one(report.model_dump())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Insert failed: {exc}")
    return {"status": "ok", "id": str(result.inserted_id)}


@app.get("/reports")
def list_reports():
    """Return every citizen report as a JSON array, with _id stringified.

    The raw BSON ObjectId is never returned — each document's _id is converted to
    a plain string so the response is ordinary JSON.
    """
    collection = get_collection()
    try:
        documents = list(collection.find())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Query failed: {exc}")
    for doc in documents:
        doc["_id"] = str(doc["_id"])
    return documents


# --- Static frontend (single-origin) ------------------------------------------
# Serve the existing static site from THIS same server, so the whole app lives on
# one URL (http://localhost:8000/) — no separate frontend port, no cross-origin hop.
# The API routes above are matched first; every other path falls through to a file.

# Safety: never expose the backend folder (it holds .env) over HTTP. This 404s any
# request under /backend/ and is registered before the catch-all mount below.
@app.get("/backend/{rest:path}", include_in_schema=False)
def _block_backend(rest: str):
    raise HTTPException(status_code=404, detail="Not Found")


# Mounted LAST so it can't shadow the API routes. html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
