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
import contextvars
import datetime as _dt
import io
import json
import logging
import math
import os
import time as _time
import uuid
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape as xml_escape

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo import MongoClient
from pymongo.errors import ConnectionFailure, ServerSelectionTimeoutError

# Local dev: load variables from a .env file if present. In production the real
# environment variables are already set, so this is a harmless no-op.
load_dotenv()

MONGODB_URI = os.environ.get("MONGODB_URI")   # NEVER hardcode — env var only
DB_NAME = "accidents_db"
COLLECTION_NAME = "citizen_reports"

# --- Domain vocabularies ------------------------------------------------------
# The single source of truth for every controlled field, used BOTH to validate an
# incoming citizen report and to constrain the AI's filter output. These must stay
# equal to the values actually present in data/accidents.json — a test asserts it.
AREAS = [
    "Adyar", "Ambattur", "Anna Nagar", "Avadi", "Chromepet", "Egmore", "Guindy",
    "Kattankulathur", "Koyambedu", "Maduravoyal", "Medavakkam", "Mylapore", "Nandanam",
    "Nungambakkam", "Padi", "Pallavaram", "Perambur", "Perungudi", "Poonamallee",
    "Porur", "Saidapet", "Sholinganallur", "T. Nagar", "Tambaram", "Teynampet",
    "Thiruvanmiyur", "Thoraipakkam", "Vadapalani", "Vandalur", "Velachery",
]
CAUSES = [
    "Over-speeding", "Wrong-side driving", "Signal jumping", "Drunken driving",
    "Mobile phone use", "Hit and run", "Pothole / bad road", "Pedestrian crossing error",
    "Improper overtaking", "Vehicle defect", "Poor visibility",
]
VEHICLES = [
    "Two-wheeler", "Car", "Auto-rickshaw", "Bus (MTC/Private)", "Lorry / Truck",
    "LCV / Van", "Bicycle", "Unknown (fled)",
]
SEVERITIES = frozenset({"fatal", "serious", "slight"})
WEATHERS = frozenset({"clear", "rain", "fog"})

# Greater Chennai bounding box, matching BBOX in shared/constants.js with a small
# margin. A report outside it is not a Chennai road accident.
LAT_MIN, LAT_MAX = 12.60, 13.40
LNG_MIN, LNG_MAX = 79.90, 80.45

# "YYYY-MM-DD HH:MM", the exact shape the frontend sends and the engines parse.
DATETIME_RE = r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$"

# The static frontend lives one level up (…/project). Resolved from THIS file's
# path (not the CWD) so it works no matter where uvicorn is started from.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))     # …/project/backend
FRONTEND_DIR = os.path.dirname(BASE_DIR)                  # …/project (the site root)

app = FastAPI(title="CRASH Citizen Reports API")

# --- Logging and request correlation ------------------------------------------
# The backend previously had NO logging at all, so every 500 was undiagnosable:
# the only evidence was whatever text had been pasted into the HTTP response,
# which is exactly the text that must NOT be sent to clients. Now the detail goes
# to the log with a request ID, and the client gets that ID plus a generic
# message — enough to correlate a user report with a log line, and nothing more.
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-8s [%(name)s] [req=%(request_id)s] %(message)s",
)
log = logging.getLogger("crash")

_request_id: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class _RequestIdFilter(logging.Filter):
    """Stamp every record with the current request's ID (or '-' outside a request)."""

    def filter(self, record):
        # Always overwrite. A conditional `if not hasattr(...)` let a stale filter
        # left over from a previous module load win and write "-" forever.
        record.request_id = _request_id.get()
        return True


def _install_request_id_filter(target):
    """Attach the filter, replacing any instance left by an earlier module load.

    `logging.getLogger("crash")` returns the SAME object every time this module is
    imported, so filters accumulate. That matters in production, not just in
    tests: `npm start` runs uvicorn with --reload, which re-imports on every save.
    Each stale filter closes over the ContextVar from ITS load, so the old one
    would run first and stamp "-", breaking log correlation after one edit.
    """
    target.filters = [f for f in target.filters if type(f).__name__ != "_RequestIdFilter"]
    target.addFilter(_RequestIdFilter())


# Attached to the LOGGER, not just a handler: a logger filter stamps the record
# once, at creation, so every downstream handler sees the request ID — including
# handlers added later (an aggregator sidecar, or pytest's capture handler).
_install_request_id_filter(log)
# The root formatter references %(request_id)s, so records logged by libraries
# through the root logger need the attribute too.
for _handler in logging.getLogger().handlers:
    _install_request_id_filter(_handler)


# NEVER log or return these. The Mongo URI embeds credentials and the API key is
# a bearer secret; either one in a log line is a leak that outlives the process.
def _safe_config_summary():
    return {
        "mongodb_configured": bool(MONGODB_URI),
        "anthropic_configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.middleware("http")
async def request_context(request, call_next):
    """Assign a request ID, echo it back, and log failures with it."""
    incoming = request.headers.get("X-Request-ID", "")
    # Only accept a caller-supplied ID if it looks like one — it lands in logs.
    request_id = incoming if (incoming.isalnum() and len(incoming) <= 64) else uuid.uuid4().hex[:12]
    token = _request_id.set(request_id)
    try:
        response = await call_next(request)
    except Exception:
        # Log the traceback here, where the request ID is still bound, then let
        # the framework turn it into a 500.
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        raise
    finally:
        _request_id.reset(token)
    response.headers["X-Request-ID"] = request_id
    return response


def _fail(status_code, message, exc, context):
    """Log the real cause, return a generic message plus the request ID.

    Raw exception text used to be interpolated straight into `detail`. Verified:
    GET /health on a misconfigured server returned the full Atlas hostname and a
    ServerDescription topology dump to any anonymous caller.
    """
    log.error("%s: %s", context, exc, exc_info=True)
    # An unreachable database is "service unavailable", not "server error": the
    # request was valid and retrying later may work. It also tells the frontend
    # to fall back to localStorage rather than report a bug.
    if isinstance(exc, (ServerSelectionTimeoutError, ConnectionFailure)):
        status_code = 503
        message = "The reports database is temporarily unreachable."
    return HTTPException(
        status_code=status_code,
        detail=f"{message} (request {_request_id.get()})",
    )

# --- CORS ---------------------------------------------------------------------
# This app is deliberately SINGLE-ORIGIN: one FastAPI service serves both the
# static site and the API, so the browser never makes a cross-origin request and
# needs no CORS grant at all. `allow_origins=["*"]` was left over from an early
# two-service layout and did nothing for the app while letting any website on the
# internet read /reports and /export/xlsx and POST to /report and /ask from a
# visitor's browser.
#
# Extra origins can be granted explicitly via CORS_ALLOW_ORIGINS (comma-separated)
# for a genuinely separate frontend; empty means same-origin only. Credentials
# stay off — this API has no cookies or sessions, so there is nothing to send.
_cors_origins = [o.strip() for o in os.environ.get("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    log.info("CORS enabled for %d configured origin(s)", len(_cors_origins))
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-ID"],
        max_age=600,
    )


# --- Always revalidate the HTML shell -----------------------------------------
# StaticFiles sends ETag/Last-Modified but NO Cache-Control, so browsers heuristically
# cache index.html and can keep serving a STALE shell after a deploy — the inline
# report/app logic then looks "not updated" even though the server has the new file.
# Force revalidation on HTML only: the browser may keep its copy but must check the
# ETag first (a cheap 304 when unchanged, fresh HTML when it changed). Versioned JS/CSS
# (the ?v= assets) are untouched and still cache long.
@app.middleware("http")
async def revalidate_html(request, call_next):
    response = await call_next(request)
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# --- Validation errors --------------------------------------------------------
# FastAPI's default 422 body echoes the rejected value back under "input". That is
# a problem twice over:
#   1. It CRASHES on exactly the input we most want to reject. A body of
#      {"lat": NaN} is parsed fine by the stdlib, correctly refused by the model —
#      and then the error response itself raises "Out of range float values are not
#      JSON compliant", turning a clean 422 into a 500.
#   2. It reflects attacker-supplied content straight back to the client.
# So report which field failed and why, and never the submitted value.
@app.exception_handler(RequestValidationError)
async def _handle_validation_error(request: Request, exc: RequestValidationError):
    errors = []
    for err in exc.errors():
        location = [str(part) for part in err.get("loc", ()) if part != "body"]
        errors.append({
            "field": ".".join(location) or "body",
            "message": str(err.get("msg", "invalid value")),
        })
    return JSONResponse(status_code=422, content={"detail": "Validation failed", "errors": errors})


# --- MongoDB ------------------------------------------------------------------
# The client is built on FIRST USE, not at import.
#
# The old comment here claimed constructing MongoClient was safe with a bad URI
# because the driver is lazy. That is true for *connecting*, but NOT for parsing:
# verified by execution, MONGODB_URI="mongodb+srv://u:p@bad host/db" raises
# ConfigurationError inside the constructor — at import time, before uvicorn can
# bind. A single typo in a Render environment variable therefore took the WHOLE
# site down, including the map, analytics and simulation, none of which touch the
# database at all. Deferring construction keeps a config mistake contained to the
# report endpoints, which already degrade gracefully.
_client = None                 # tests monkeypatch this directly
_client_error = None           # remembered so a broken URI isn't re-parsed per request


def _get_client():
    """Return the MongoClient, building it once, or None if it cannot be built."""
    global _client, _client_error
    if _client is not None:
        return _client
    if not MONGODB_URI or _client_error is not None:
        return None
    try:
        # A short server-selection timeout means the report routes fail fast
        # instead of hanging a worker for the driver's 30s default.
        _client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000, appname="crash-reports")
    except Exception as exc:  # noqa: BLE001 — deliberately broad; see below
        # Broad on purpose. The entire point of this block is that NOTHING the
        # driver raises while parsing a user-supplied URI may reach the import
        # and take the whole site down (finding F008). Narrowing to PyMongoError
        # would let a ValueError or TypeError from a malformed URI escape and
        # reinstate exactly the bug this fixes.
        # Never log the URI itself — it carries the password.
        _client_error = exc
        log.error("MONGODB_URI could not be parsed; citizen reports are disabled: %s",
                  type(exc).__name__)
        return None
    return _client


def get_collection():
    """Return the citizen_reports collection, or a clear 503 if unavailable.

    503, not 500: the request itself was fine, the server just isn't ready. This
    also lets the frontend distinguish "backend not configured" from "your report
    was rejected" and fall back to local storage without reporting a bug.
    """
    client = _get_client()
    if client is None:
        raise HTTPException(
            status_code=503,
            detail="Citizen reports are unavailable: the server has no database configured.",
        )
    return client[DB_NAME][COLLECTION_NAME]


# --- Schema -------------------------------------------------------------------
class Report(BaseModel):
    """A citizen accident report — the same 8-field schema as the frontend.

    Every field is constrained here, at the trust boundary. /report is public and
    unauthenticated, so anything this model accepts is stored and then rendered on
    every visitor's map. Type-only validation previously let through NaN
    coordinates (which permanently 500'd GET /reports), 100 kB strings, XML control
    characters, and HTML/script payloads.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    # allow_inf_nan=False rejects NaN and ±Infinity, which the stdlib JSON parser
    # accepts but Starlette's serialiser then refuses to write.
    lat: float = Field(ge=LAT_MIN, le=LAT_MAX, allow_inf_nan=False)
    lng: float = Field(ge=LNG_MIN, le=LNG_MAX, allow_inf_nan=False)
    severity: str
    datetime: str = Field(pattern=DATETIME_RE)
    weather: str
    cause: str
    vehicle: str
    area: str

    @field_validator("severity")
    @classmethod
    def _check_severity(cls, v: str) -> str:
        if v not in SEVERITIES:
            raise ValueError(f"severity must be one of {sorted(SEVERITIES)}")
        return v

    @field_validator("weather")
    @classmethod
    def _check_weather(cls, v: str) -> str:
        if v not in WEATHERS:
            raise ValueError(f"weather must be one of {sorted(WEATHERS)}")
        return v

    @field_validator("cause")
    @classmethod
    def _check_cause(cls, v: str) -> str:
        if v not in CAUSES:
            raise ValueError("cause is not a recognised accident cause")
        return v

    @field_validator("vehicle")
    @classmethod
    def _check_vehicle(cls, v: str) -> str:
        if v not in VEHICLES:
            raise ValueError("vehicle is not a recognised vehicle type")
        return v

    @field_validator("area")
    @classmethod
    def _check_area(cls, v: str) -> str:
        # The frontend always derives `area` from nearestArea() over this same
        # list, so a value outside it did not come from the report form.
        if v not in AREAS:
            raise ValueError("area is not a recognised Chennai area")
        return v

    @field_validator("datetime")
    @classmethod
    def _check_datetime_is_real(cls, v: str) -> str:
        try:
            parsed = _dt.datetime.strptime(v, "%Y-%m-%d %H:%M")
        except ValueError as exc:
            raise ValueError("datetime must be 'YYYY-MM-DD HH:MM'") from exc
        # A far-future date silently stretches the frontend's analysis window and
        # corrupts the per-month KPIs, so reject it here rather than downstream.
        if parsed > _dt.datetime.now() + _dt.timedelta(minutes=5):
            raise ValueError("datetime cannot be in the future")
        if parsed < _dt.datetime(2000, 1, 1):
            raise ValueError("datetime is implausibly old")
        return v


# --- API routes ---------------------------------------------------------------
# These are registered BEFORE the static mount below, so they take precedence over
# the catch-all file handler. /health, /report and /reports never collide with any
# frontend file name.
@app.get("/health")
def health():
    """Quick connectivity check — pings MongoDB so a 200 means the DB is reachable.

    NOTE: deliberately unchanged. This endpoint is render.yaml's healthCheckPath,
    so a 503 here marks the whole service unhealthy even though the map, analytics
    and simulation need no database (finding F006). That coupling was reviewed and
    kept as-is by explicit decision; it is recorded in audit/03-deferred.md.
    """
    client = _get_client()
    if client is None:
        raise HTTPException(status_code=503, detail="MONGODB_URI is not configured.")
    try:
        client.admin.command("ping")
    except Exception as exc:  # pymongo raises on unreachable / bad-credential URIs
        raise _fail(503, "Database is unreachable.", exc, "mongodb ping failed") from exc
    return {"status": "ok"}


@app.post("/report")
def create_report(report: Report):
    """Validate the body against Report and insert it into citizen_reports."""
    collection = get_collection()
    try:
        result = collection.insert_one(report.model_dump())
    except Exception as exc:
        raise _fail(500, "Could not save the report.", exc, "report insert failed") from exc
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
        raise _fail(500, "Could not load reports.", exc, "reports query failed") from exc
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


# XML 1.0 permits only these characters:
#   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
# xml_escape() only rewrites & < >, so a control character such as \x00 passed
# straight through into the sheet. The result was a structurally valid ZIP whose
# worksheet XML would not parse — Excel reports "unreadable content" and the
# frontend's PK-magic-bytes fallback check cannot detect it, so the export failed
# silently. Reports reach this from MongoDB, including any stored before the
# /report validator was tightened.
def _xml_safe(text):
    """Drop characters XML 1.0 cannot represent, keeping tab/newline/return."""
    return "".join(
        ch for ch in text
        if ch in "\t\n\r"
        or "\x20" <= ch <= "퟿"
        or "" <= ch <= "�"
        or ch >= "\U00010000"
    )


def _column_ref(index):
    """0-based column index -> spreadsheet letters (0 -> A, 25 -> Z, 26 -> AA).

    The previous `chr(65 + i)` was correct for today's 9 columns but silently
    emitted punctuation past column Z, which would corrupt the workbook rather
    than fail loudly if EXPORT_COLUMNS ever grew.
    """
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


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
        text = xml_escape(_xml_safe("" if value is None else str(value)))
        return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'

    body = [
        '<row r="1">'
        + "".join(cell(f"{_column_ref(i)}1", key, key) for i, key in enumerate(EXPORT_COLUMNS))
        + "</row>"
    ]
    for r_index, row in enumerate(rows, start=2):
        body.append(
            f'<row r="{r_index}">'
            + "".join(cell(f"{_column_ref(i)}{r_index}", key, row.get(key, "")) for i, key in enumerate(EXPORT_COLUMNS))
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
        raise _fail(500, "Could not load reports for export.", exc, "export query failed") from exc

    body, count = _build_xlsx(documents)
    return Response(
        content=body,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": 'attachment; filename="citizen_reports.xlsx"',
            "X-Report-Count": str(count),
        },
    )


# --- C.R.A.S.H Bot: free-form Q&A over the dataset ----------------------------
# The frontend sends the question PLUS a complete statistical digest of the in-memory
# dataset (all ~10k raw rows can't fit the model's context, so it sends every aggregate:
# each area's full breakdown, all causes/vehicles/weather/day-night). The AI answers
# freely from that digest and optionally returns a filter so THIS page's map can
# highlight the matching accidents. The API key is read from the environment only.
ANTHROPIC_MODEL = "claude-sonnet-4-6"   # editable — must be a model this API key can access
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")   # env only, NEVER hardcoded

# Valid filter vocabularies — MUST match the frontend dataset so the AI's output lines
# up exactly with the map's own filtering. Areas are the 30 real dataset areas.
# Aliases onto the single vocabulary defined at the top of this module, so the
# AI's allowed filter values and the /report validator can never drift apart.
BOT_AREAS = AREAS
BOT_CAUSES = CAUSES
BOT_VEHICLES = VEHICLES
BOT_SEVERITY = SEVERITIES
BOT_TIME = frozenset({"day", "night"})
BOT_WEATHER = WEATHERS

ASK_SYSTEM_PROMPT = (
    "You are C.R.A.S.H Bot, a helpful assistant for a Chennai road-accident dashboard.\n"
    "Answer the user's question using ONLY the DATA SUMMARY at the end of this message. Its\n"
    "numbers are exact — read them and do any arithmetic yourself (sums, differences,\n"
    "comparisons, max/min, percentages). Never invent figures that aren't in or derivable\n"
    "from the summary; if it genuinely doesn't cover something, say so briefly. Discuss ONLY\n"
    "Chennai road accidents; for anything else, politely redirect in one sentence.\n\n"
    "The DATA SUMMARY also lists Chennai's major hospitals and, for each area, its nearest\n"
    "hospital with the straight-line distance in km. Hospital access and emergency-response\n"
    "proximity ARE in scope \u2014 answer those from that data, and note the distances are\n"
    "straight-line (not road distance) when it matters.\n\n"
    "Respond with ONLY a JSON object (no text outside it):\n"
    '{"answer": "<your natural-language answer as plain text; may use **bold**; concise>",\n'
    ' "filters": {"area": <valid area or null>, "severity": "fatal"|"serious"|"slight"|null,\n'
    '   "timeOfDay": "day"|"night"|null, "weather": "clear"|"rain"|"fog"|null,\n'
    '   "cause": <valid cause or null>, "vehicle": <valid vehicle or null>}}\n'
    "Set \"filters\" to the single accident subset the answer is about so the map can highlight\n"
    "it (e.g. area + severity), using the exact vocab below; use null for any field, or set\n"
    '"filters" to null for a whole-city / comparison / off-topic answer. All prose goes inside\n'
    "\"answer\". 'night' = 18:00-06:00, 'day' = 06:00-18:00.\n\n"
    "Valid areas: " + ", ".join(BOT_AREAS) + ".\n"
    "Valid causes: " + ", ".join(BOT_CAUSES) + ".\n"
    "Valid vehicles: " + ", ".join(BOT_VEHICLES) + "."
)


# --- /ask cost and abuse controls ---------------------------------------------
# /ask is public, unauthenticated, and spends the project owner's Anthropic
# credit on every call. The client also supplies `digest`, which is concatenated
# into the system prompt — so without caps this endpoint is a free LLM proxy that
# anyone can point at any prompt, billed to this key.
ASK_TIMEOUT_SECONDS = float(os.environ.get("ASK_TIMEOUT_SECONDS", "25"))
ASK_MAX_QUESTION_CHARS = 1000
ASK_MAX_DIGEST_CHARS = 20000
ASK_RATE_LIMIT = int(os.environ.get("ASK_RATE_LIMIT", "20"))          # requests...
ASK_RATE_WINDOW_SECONDS = int(os.environ.get("ASK_RATE_WINDOW_SECONDS", "60"))   # ...per window, per IP

# In-process fixed-window counter. Deliberately simple: Render free runs a single
# instance, and the goal is to blunt runaway cost, not to be a shared quota
# service. It resets on restart and is per-process — documented, not hidden.
_ask_hits: dict[str, list[float]] = {}


def _client_ip(request: Request) -> str:
    """Best-effort client identity for rate limiting.

    Render terminates TLS and forwards the real address in X-Forwarded-For, so the
    left-most entry is used when present. This is spoofable, which is acceptable
    here: the limiter exists to cap accidental and casual abuse, and a determined
    attacker rotating the header is a problem for a real WAF, not this counter.
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    return request.client.host if request.client else "unknown"


def _check_ask_rate_limit(request: Request) -> None:
    now = _time.monotonic()
    cutoff = now - ASK_RATE_WINDOW_SECONDS
    key = _client_ip(request)

    hits = [t for t in _ask_hits.get(key, []) if t > cutoff]
    if len(hits) >= ASK_RATE_LIMIT:
        _ask_hits[key] = hits
        log.warning("ask rate limit hit for %s", key)
        raise HTTPException(
            status_code=429,
            detail="Too many questions in a short time. Please wait a moment and try again.",
            headers={"Retry-After": str(ASK_RATE_WINDOW_SECONDS)},
        )
    hits.append(now)
    _ask_hits[key] = hits

    # Opportunistic sweep so an unbounded number of distinct IPs cannot grow the
    # dict forever — this is the endpoint most exposed to a flood.
    if len(_ask_hits) > 2048:
        for stale_key in [k for k, v in _ask_hits.items() if not any(t > cutoff for t in v)]:
            _ask_hits.pop(stale_key, None)


class AskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Capped at the model level so an oversized body is rejected during parsing,
    # before any of it is copied into a prompt.
    question: str = Field(max_length=ASK_MAX_QUESTION_CHARS)
    # frontend-computed statistical summary of the full dataset
    digest: str = Field(default="", max_length=ASK_MAX_DIGEST_CHARS)


def _canon(value, valid_list):
    """Case-insensitively map a value to its canonical spelling, else None."""
    if not isinstance(value, str):
        return None
    v = value.strip().lower()
    for item in valid_list:
        if item.lower() == v:
            return item
    return None


def _normalize_filters(raw):
    """Coerce the model's filter object into the safe 6-key shape (unknown values -> None)."""
    if not isinstance(raw, dict):
        return dict.fromkeys(("area", "severity", "timeOfDay", "weather", "cause", "vehicle"))

    def _low(v):
        return v.strip().lower() if isinstance(v, str) else None
    sev, tod, wea = _low(raw.get("severity")), _low(raw.get("timeOfDay")), _low(raw.get("weather"))
    return {
        "area": _canon(raw.get("area"), BOT_AREAS),
        "severity": sev if sev in BOT_SEVERITY else None,
        "timeOfDay": tod if tod in BOT_TIME else None,
        "weather": wea if wea in BOT_WEATHER else None,
        "cause": _canon(raw.get("cause"), BOT_CAUSES),
        "vehicle": _canon(raw.get("vehicle"), BOT_VEHICLES),
    }


def _parse_ask_json(text):
    """Parse the model's reply into an object, tolerating code fences / stray prose."""
    if not text:
        return None
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`").strip()
        if s[:4].lower() == "json":
            s = s[4:].strip()
    # Narrow, not blind: the only expected failure here is "the model did not
    # return clean JSON", which is exactly what the fallback below handles. A
    # blind catch would also have hidden a real bug in this function.
    try:
        return json.loads(s)
    except (json.JSONDecodeError, TypeError):
        log.debug("model reply was not valid JSON; trying the outermost braces")
    start, end = s.find("{"), s.rfind("}")   # last-ditch: grab the outermost {...}
    if start != -1 and end > start:
        try:
            return json.loads(s[start:end + 1])
        except (json.JSONDecodeError, TypeError):
            log.debug("model reply could not be parsed as JSON at all")
            return None
    return None


_anthropic_client = None


def _get_anthropic():
    """Lazily build the Anthropic client — imported HERE (not at module load) so the
    rest of the app runs even if the SDK/key aren't present yet. Clean 503 if missing."""
    global _anthropic_client
    if _anthropic_client is not None:
        return _anthropic_client
    if not ANTHROPIC_API_KEY:
        raise HTTPException(status_code=503, detail="ANTHROPIC_API_KEY is not configured on the server.")
    try:
        from anthropic import Anthropic
    except Exception as exc:
        raise _fail(503, "The AI assistant is unavailable.", exc, "anthropic SDK import failed") from exc
    # On a corporate TLS-inspecting proxy, Python's default certifi bundle can't verify
    # the re-signed certificate (CERTIFICATE_VERIFY_FAILED), so the AI call fails. Give
    # THIS client an httpx transport that verifies against the OS trust store (which
    # trusts the proxy CA, like the browser does). Scoped to the Anthropic client only —
    # a GLOBAL truststore patch recurses in pymongo's SSL setup on some Python builds.
    http_client = None
    try:
        import ssl

        import httpx
        import truststore
        ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        # An explicit transport timeout as well: without one httpx would wait
        # indefinitely to connect, holding a worker thread the whole time.
        http_client = httpx.Client(verify=ctx, timeout=httpx.Timeout(ASK_TIMEOUT_SECONDS, connect=10.0))
    except Exception as exc:  # noqa: BLE001 — optional transport, must never be fatal
        # truststore absent (e.g. prod with standard CAs) — fall back to the SDK
        # default. Broad on purpose: this is an optional convenience for
        # TLS-inspecting corporate proxies, and no failure to build it should
        # stop the bot working. Deliberate and safe, but logged: previously this
        # swallowed the error silently, so a genuine TLS misconfiguration looked
        # identical to "truststore simply isn't installed".
        log.info("truststore transport unavailable, using the SDK default: %s", exc)
        http_client = None
    # An explicit timeout and retry budget. The SDK's default timeout is 10
    # MINUTES: a slow upstream would pin a worker for that long, and with the
    # frontend giving up after 30s the work was wasted anyway. max_retries is
    # capped so one bad request cannot silently cost three upstream calls.
    options = {
        "api_key": ANTHROPIC_API_KEY,
        "timeout": ASK_TIMEOUT_SECONDS,
        "max_retries": 1,
    }
    if http_client is not None:
        options["http_client"] = http_client
    _anthropic_client = Anthropic(**options)
    return _anthropic_client


@app.post("/ask")
def ask(req: AskRequest, request: Request):
    """Answer a question about the Chennai accident data using the frontend-supplied digest.

    Returns {"answer": <natural-language text>, "filters": <subset for the map, or null>}.
    Missing key/SDK -> 503; a failed AI call -> 502 (the frontend shows 'bot unavailable');
    too many requests -> 429. Non-JSON model output degrades to showing the raw text so
    an answer is never lost.
    """
    question = (req.question or "").strip()
    if not question:
        # Answered locally — costs nothing, so it is deliberately not rate limited.
        return {"answer": "Ask me anything about the Chennai road-accident data — e.g. “which area has the most fatal accidents?”", "filters": None}
    # Checked only once we know the request would actually reach Anthropic.
    _check_ask_rate_limit(request)
    digest = (req.digest or "")[:ASK_MAX_DIGEST_CHARS]   # belt-and-braces; the model field also caps it
    client = _get_anthropic()             # clean 503 if key/SDK missing
    system = ASK_SYSTEM_PROMPT + "\n\nDATA SUMMARY:\n" + (digest or "(no data summary was provided)")
    try:
        msg = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=700,
            system=system,
            messages=[{"role": "user", "content": question[:ASK_MAX_QUESTION_CHARS]}],
        )
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text")
    except Exception as exc:
        raise _fail(502, "The AI assistant could not answer that right now.", exc, "anthropic request failed") from exc
    parsed = _parse_ask_json(text)
    if isinstance(parsed, dict) and isinstance(parsed.get("answer"), str) and parsed["answer"].strip():
        return {"answer": parsed["answer"].strip(), "filters": _normalize_filters(parsed.get("filters"))}
    # not JSON (or no 'answer') -> show the model's raw text so we never lose an answer
    return {"answer": (text or "").strip() or "Sorry, I couldn't find an answer for that.", "filters": None}


# --- Static frontend (single-origin) ------------------------------------------
# Serve the existing static site from THIS same server, so the whole app lives on
# one URL (http://localhost:8000/) — no separate frontend port, no cross-origin hop.
# The API routes above are matched first; every other path falls through to a file.

# The site HOME ("/") is the marketing landing page. index.html — the live app —
# stays reachable at /index.html.
@app.get("/", include_in_schema=False)
def home():
    """Serve the editorial landing page as the site home."""
    return FileResponse(os.path.join(FRONTEND_DIR, "landing.html"))


# --- Static frontend: an explicit allowlist, not the whole repo ----------------
# This used to be `app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True))`,
# which served the ENTIRE repository root. Verified reachable over HTTP:
# /.git/config, /.git/HEAD and /.venv/pyvenv.cfg all returned 200. The
# `/backend/{rest:path}` block that was supposed to protect the secrets directory
# was itself incomplete — FastAPI's APIRoute does not add HEAD the way Starlette's
# Route does, so `HEAD /backend/.env.example` returned 200, and `GET
# /%2e/backend/.env.example` slipped past the literal prefix match entirely.
#
# Allowlisting is the fix: a request is served only if it names a file this site
# actually publishes. Anything else — dotfiles, source, secrets, VCS metadata, new
# directories added later — 404s by default rather than by remembering to block it.
SITE_ROOT = Path(FRONTEND_DIR).resolve()

# Sub-directories the site may serve from, and what is allowed inside each.
# Nesting is permitted WITHIN these directories (vendor/leaflet/images/*.png),
# because a vendored library ships its own asset tree. The extension allowlist
# and the dotfile/traversal rules below still apply at every level.
SITE_DIRS = {
    "shared": {".js"},
    "vendor": {".js", ".css", ".map", ".png", ".svg", ".gif", ".webp"},
}
# data/ is listed by exact filename: the *.backup.json files next to these are
# pre-snap working copies that nothing fetches and that need not be public.
DATA_FILES = frozenset({"accidents.json", "citizen_seed.json"})
# Files served from the site root. Extension-based, so adding a page needs no
# code change, while source and config still cannot leak.
ROOT_EXTENSIONS = frozenset({".html", ".js", ".css", ".ico", ".png", ".jpg", ".jpeg",
                             ".svg", ".webp", ".woff", ".woff2"})


def _resolve_site_file(rel_path: str) -> Path | None:
    """Map a URL path to a file this site publishes, or None.

    Deliberately conservative: it rejects anything it does not positively
    recognise, and confirms the resolved path is still inside SITE_ROOT so no
    encoding trick, symlink or traversal sequence can escape.
    """
    if not rel_path or rel_path.endswith("/"):
        return None

    parts = [p for p in rel_path.split("/") if p]
    # No traversal, no absolute paths, no hidden files or directories anywhere.
    if any(p in {".", ".."} or p.startswith(".") for p in parts):
        return None
    # No Windows drive letters, alternate data streams, or NUL bytes.
    if any("\\" in p or ":" in p or "\x00" in p for p in parts):
        return None

    if len(parts) == 1:
        if Path(parts[0]).suffix.lower() not in ROOT_EXTENSIONS:
            return None
    elif len(parts) == 2 and parts[0] == "data":
        if parts[1] not in DATA_FILES:
            return None
    elif parts[0] in SITE_DIRS:
        # Any depth inside shared/ or vendor/, provided the final component has an
        # allowed extension — a vendored library ships its own asset tree
        # (vendor/leaflet/images/marker-icon.png).
        if Path(parts[-1]).suffix.lower() not in SITE_DIRS[parts[0]]:
            return None
    else:
        return None

    candidate = (SITE_ROOT / Path(*parts)).resolve()
    # Belt and braces: the resolved path must still live under the site root and
    # must be a real file (not a directory, device or dangling symlink).
    if not candidate.is_file():
        return None
    if candidate != SITE_ROOT and SITE_ROOT not in candidate.parents:
        return None
    return candidate


# Registered LAST so it can never shadow an API route, and for GET *and* HEAD so
# there is no method that reaches a different code path.
@app.api_route("/{site_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
def serve_site_file(site_path: str):
    """Serve one allowlisted frontend file, or 404."""
    resolved = _resolve_site_file(site_path)
    if resolved is None:
        raise HTTPException(status_code=404, detail="Not Found")
    return FileResponse(resolved)
