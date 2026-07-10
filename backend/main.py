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
import json
import math
import os
import zipfile
from xml.sax.saxutils import escape as xml_escape

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
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
BOT_AREAS = [
    "Adyar", "Ambattur", "Anna Nagar", "Avadi", "Chromepet", "Egmore", "Guindy",
    "Kattankulathur", "Koyambedu", "Maduravoyal", "Medavakkam", "Mylapore", "Nandanam",
    "Nungambakkam", "Padi", "Pallavaram", "Perambur", "Perungudi", "Poonamallee",
    "Porur", "Saidapet", "Sholinganallur", "T. Nagar", "Tambaram", "Teynampet",
    "Thiruvanmiyur", "Thoraipakkam", "Vadapalani", "Vandalur", "Velachery",
]
BOT_CAUSES = [
    "Over-speeding", "Wrong-side driving", "Signal jumping", "Drunken driving",
    "Mobile phone use", "Hit and run", "Pothole / bad road", "Pedestrian crossing error",
    "Improper overtaking", "Vehicle defect", "Poor visibility",
]
BOT_VEHICLES = [
    "Two-wheeler", "Car", "Auto-rickshaw", "Bus (MTC/Private)", "Lorry / Truck",
    "LCV / Van", "Bicycle", "Unknown (fled)",
]
BOT_SEVERITY = {"fatal", "serious", "slight"}
BOT_TIME = {"day", "night"}
BOT_WEATHER = {"clear", "rain", "fog"}
BOT_INTENT = {"count", "summary", "help", "out_of_scope"}

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


class AskRequest(BaseModel):
    question: str
    digest: str = ""     # frontend-computed statistical summary of the full dataset


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
        return {k: None for k in ("area", "severity", "timeOfDay", "weather", "cause", "vehicle")}

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
    try:
        return json.loads(s)
    except Exception:
        pass
    start, end = s.find("{"), s.rfind("}")   # last-ditch: grab the outermost {...}
    if start != -1 and end > start:
        try:
            return json.loads(s[start:end + 1])
        except Exception:
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
        raise HTTPException(status_code=503, detail=f"anthropic SDK is not installed: {exc}")
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
        http_client = httpx.Client(verify=ctx)
    except Exception:
        http_client = None   # truststore absent (e.g. prod with standard CAs) — use SDK default
    _anthropic_client = (
        Anthropic(api_key=ANTHROPIC_API_KEY, http_client=http_client)
        if http_client is not None else Anthropic(api_key=ANTHROPIC_API_KEY)
    )
    return _anthropic_client


@app.post("/ask")
def ask(req: AskRequest):
    """Answer a question about the Chennai accident data using the frontend-supplied digest.

    Returns {"answer": <natural-language text>, "filters": <subset for the map, or null>}.
    Missing key/SDK -> 503; a failed AI call -> 502 (the frontend shows 'bot unavailable').
    Non-JSON model output degrades to showing the raw text so an answer is never lost.
    """
    question = (req.question or "").strip()
    if not question:
        return {"answer": "Ask me anything about the Chennai road-accident data — e.g. “which area has the most fatal accidents?”", "filters": None}
    digest = (req.digest or "")[:20000]   # cap the payload; it's our own computed summary
    client = _get_anthropic()             # clean 503 if key/SDK missing
    system = ASK_SYSTEM_PROMPT + "\n\nDATA SUMMARY:\n" + (digest or "(no data summary was provided)")
    try:
        msg = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=700,
            system=system,
            messages=[{"role": "user", "content": question[:1000]}],
        )
        text = "".join(getattr(b, "text", "") for b in msg.content if getattr(b, "type", None) == "text")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"AI request failed: {exc}")
    parsed = _parse_ask_json(text)
    if isinstance(parsed, dict) and isinstance(parsed.get("answer"), str) and parsed["answer"].strip():
        return {"answer": parsed["answer"].strip(), "filters": _normalize_filters(parsed.get("filters"))}
    # not JSON (or no 'answer') -> show the model's raw text so we never lose an answer
    return {"answer": (text or "").strip() or "Sorry, I couldn't find an answer for that.", "filters": None}


# --- Static frontend (single-origin) ------------------------------------------
# Serve the existing static site from THIS same server, so the whole app lives on
# one URL (http://localhost:8000/) — no separate frontend port, no cross-origin hop.
# The API routes above are matched first; every other path falls through to a file.

# Safety: never expose the backend folder (it holds .env) over HTTP. This 404s any
# request under /backend/ and is registered before the catch-all mount below.
@app.get("/backend/{rest:path}", include_in_schema=False)
def _block_backend(rest: str):
    raise HTTPException(status_code=404, detail="Not Found")


# The site HOME ("/") is the marketing landing page. Registered BEFORE the static
# mount so it wins over StaticFiles' html=True (which would otherwise serve
# index.html at "/"). index.html — the live app — stays reachable at /index.html.
@app.get("/", include_in_schema=False)
def home():
    """Serve the editorial landing page as the site home."""
    return FileResponse(os.path.join(FRONTEND_DIR, "landing.html"))


# Mounted LAST so it can't shadow the API routes. html=True serves index.html at "/".
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
