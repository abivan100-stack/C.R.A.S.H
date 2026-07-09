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
import io
import math
import os
import zipfile
from xml.sax.saxutils import escape as xml_escape

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
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


# --- Excel (.xlsx) export --------------------------------------------------------
# The export columns, in the exact order they appear in the sheet. The BSON _id is
# surfaced as `id` (stringified); the remaining eight are the report schema. lat/lng
# are written as real numbers so Excel treats them numerically (no "number stored as
# text" warning); everything else is written as text.
EXPORT_COLUMNS = ["id", "lat", "lng", "severity", "datetime", "weather", "cause", "vehicle", "area"]
NUMERIC_COLUMNS = {"lat", "lng"}

# A .xlsx file is just a ZIP of XML parts. These four parts never change; only the
# worksheet (built per request) does. Keeping them as constants makes the package
# minimal and valid (Office Open XML / SpreadsheetML).
_CONTENT_TYPES_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    '</Types>'
)
_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    '</Relationships>'
)
_WORKBOOK_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    '<sheets><sheet name="Citizen Reports" sheetId="1" r:id="rId1"/></sheets>'
    '</workbook>'
)
_WORKBOOK_RELS_XML = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    '</Relationships>'
)


def _rows_from_documents(documents):
    """Normalise each Mongo document to the 9 export fields (id first, None -> "")."""
    rows = []
    for doc in documents:
        row = {"id": str(doc.get("_id", ""))}
        for key in EXPORT_COLUMNS[1:]:
            value = doc.get(key, "")
            row[key] = "" if value is None else value
        rows.append(row)
    return rows


def _column_widths(rows):
    """Auto-fit width per column = longest cell (or header) + a little padding,
    clamped to a sensible range so one long value can't make a column absurdly wide."""
    widths = []
    for key in EXPORT_COLUMNS:
        longest = len(key)
        for row in rows:
            longest = max(longest, len(str(row.get(key, ""))))
        widths.append(min(max(longest + 2, 8), 60))
    return widths


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _worksheet_xml(rows):
    """Build the sheet: a <cols> block (auto-fit widths) + the header row + one row
    per report. lat/lng become numeric cells; every other value is an inline string
    (XML-escaped, whitespace preserved) so commas/quotes/newlines never corrupt it."""
    widths = _column_widths(rows)
    cols = "".join(
        f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
        for i, w in enumerate(widths)
    )

    def cell(ref, key, value):
        if key in NUMERIC_COLUMNS and _is_number(value):
            return f'<c r="{ref}"><v>{value}</v></c>'
        text = xml_escape("" if value is None else str(value))
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'

    body = [
        '<row r="1">'
        + "".join(cell(f"{chr(65 + i)}1", key, key) for i, key in enumerate(EXPORT_COLUMNS))
        + "</row>"
    ]
    for r_index, row in enumerate(rows, start=2):
        body.append(
            f'<row r="{r_index}">'
            + "".join(cell(f"{chr(65 + i)}{r_index}", key, row.get(key, "")) for i, key in enumerate(EXPORT_COLUMNS))
            + "</row>"
        )

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<cols>{cols}</cols>"
        f'<sheetData>{"".join(body)}</sheetData>'
        "</worksheet>"
    )


def _build_xlsx(documents):
    """Assemble the whole .xlsx package (ZIP of XML parts) in memory and return bytes."""
    rows = _rows_from_documents(documents)
    sheet = _worksheet_xml(rows)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _CONTENT_TYPES_XML)
        zf.writestr("_rels/.rels", _RELS_XML)
        zf.writestr("xl/workbook.xml", _WORKBOOK_XML)
        zf.writestr("xl/_rels/workbook.xml.rels", _WORKBOOK_RELS_XML)
        zf.writestr("xl/worksheets/sheet1.xml", sheet)
    return buffer.getvalue(), len(rows)


@app.get("/export/xlsx")
def export_reports_xlsx():
    """Download EVERY citizen report as a formatted citizen_reports.xlsx workbook.

    Same source as /reports — all documents from the collection — but written as a
    real Excel file (Office Open XML) with one header row, one row per report, and
    each column auto-sized to its content so it opens with proper column widths in
    Excel. lat/lng are stored as numbers. The workbook is generated on demand from
    MongoDB on every request and streamed from memory; nothing is written to the
    server's disk (Render's filesystem is ephemeral), so the export is always
    current. X-Report-Count reports how many rows it holds.
    """
    collection = get_collection()
    try:
        documents = list(collection.find())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Query failed: {exc}")

    body, count = _build_xlsx(documents)
    return Response(
        content=body,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="citizen_reports.xlsx"',
            "X-Report-Count": str(count),
        },
    )


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
