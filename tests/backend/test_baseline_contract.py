"""Characterisation tests for the backend's CURRENT, correct behaviour.

These lock in the contract that must survive the hardening work: route wiring,
the single-origin static mount, the xlsx package shape, and the AI filter
normaliser's "the AI translates, the code counts" guarantee. They all pass
against the pre-hardening code — regression tests for defects live alongside
their fix, so the suite is never committed red.
"""

import io
import zipfile

import pytest


# --- Routing and the single-origin static host -------------------------------

def test_home_serves_the_landing_page(client):
    """`/` is the marketing landing page, not the SPA."""
    response = client.get("/")
    assert response.status_code == 200
    assert "<title>" in response.text


def test_spa_is_reachable_at_index_html(client):
    response = client.get("/index.html")
    assert response.status_code == 200
    assert len(response.content) > 1000


def test_static_dataset_is_served(client):
    """The ~10k dataset is a static file; the backend never queries it."""
    response = client.get("/data/accidents.json")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")


def test_html_responses_are_marked_no_cache(client):
    """The HTML shell must revalidate so a deploy is never served stale."""
    assert client.get("/").headers.get("cache-control") == "no-cache"


def test_api_routes_win_over_the_static_mount(client):
    """/health must hit the API, not fall through to a file lookup."""
    response = client.get("/health")
    assert response.status_code == 503
    assert response.json()["detail"] == "MONGODB_URI is not configured."


# --- Behaviour with no configuration -----------------------------------------

def test_unconfigured_db_routes_do_not_crash(client):
    """Every DB route degrades to a clean JSON error, never a stack trace."""
    for path in ("/reports", "/export/xlsx"):
        response = client.get(path)
        assert response.status_code >= 400
        assert "detail" in response.json()


def test_ask_with_empty_question_short_circuits(client):
    """An empty question is answered locally without ever calling Anthropic."""
    response = client.post("/ask", json={"question": "", "digest": ""})
    assert response.status_code == 200
    assert response.json()["filters"] is None
    assert response.json()["answer"]


def test_ask_without_api_key_is_503_not_500(client):
    """A missing key is a configuration problem, and says so."""
    response = client.post("/ask", json={"question": "which area is worst?"})
    assert response.status_code == 503
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


# --- Reports round-trip -------------------------------------------------------

def test_report_round_trips_through_the_collection(db_client, valid_report):
    post = db_client.post("/report", json=valid_report)
    assert post.status_code == 200
    assert post.json()["status"] == "ok"
    assert post.json()["id"]

    listed = db_client.get("/reports").json()
    assert len(listed) == 1
    assert listed[0]["area"] == "Guindy"
    # The BSON ObjectId must never leak as a raw object.
    assert isinstance(listed[0]["_id"], str)


def test_report_rejects_a_missing_field(db_client, valid_report):
    del valid_report["severity"]
    assert db_client.post("/report", json=valid_report).status_code == 422


def test_report_rejects_a_non_numeric_coordinate(db_client, valid_report):
    valid_report["lat"] = "not-a-number"
    assert db_client.post("/report", json=valid_report).status_code == 422


# --- xlsx export --------------------------------------------------------------

def test_xlsx_export_is_a_valid_office_package(db_client, valid_report):
    db_client.post("/report", json=valid_report)
    response = db_client.get("/export/xlsx")

    assert response.status_code == 200
    assert response.headers["x-report-count"] == "1"
    assert "citizen_reports.xlsx" in response.headers["content-disposition"]

    with zipfile.ZipFile(io.BytesIO(response.content)) as package:
        assert package.testzip() is None
        assert set(package.namelist()) == {
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/workbook.xml",
            "xl/_rels/workbook.xml.rels",
            "xl/worksheets/sheet1.xml",
        }


def test_xlsx_writes_coordinates_as_numbers_and_text_as_inline_strings(db_client, valid_report):
    db_client.post("/report", json=valid_report)
    response = db_client.get("/export/xlsx")
    with zipfile.ZipFile(io.BytesIO(response.content)) as package:
        sheet = package.read("xl/worksheets/sheet1.xml").decode()

    assert "<v>13.0067</v>" in sheet          # lat is a real number
    assert 'inlineStr' in sheet               # text columns are inline strings
    assert "Guindy" in sheet


def test_xlsx_escapes_xml_metacharacters(app_module):
    """A field containing markup must not break out of its cell."""
    sheet = app_module._worksheet_xml(
        app_module._rows_from_documents([{"_id": "1", "area": "A & B <tag>", "lat": 1.0}])
    )
    assert "A &amp; B &lt;tag&gt;" in sheet
    assert "<tag>" not in sheet


def test_xlsx_export_of_an_empty_collection_still_builds(db_client):
    response = db_client.get("/export/xlsx")
    assert response.status_code == 200
    assert response.headers["x-report-count"] == "0"


# --- "The AI translates, the code counts" ------------------------------------

def test_canon_is_case_insensitive_and_rejects_unknown_values(app_module):
    assert app_module._canon("guindy", app_module.BOT_AREAS) == "Guindy"
    assert app_module._canon("  VELACHERY  ", app_module.BOT_AREAS) == "Velachery"
    assert app_module._canon("Atlantis", app_module.BOT_AREAS) is None
    assert app_module._canon(None, app_module.BOT_AREAS) is None
    assert app_module._canon(42, app_module.BOT_AREAS) is None


def test_normalize_filters_always_returns_the_six_key_shape(app_module):
    expected = {"area", "severity", "timeOfDay", "weather", "cause", "vehicle"}
    for hostile in (None, "nonsense", 42, [], {"area": {"$ne": None}}):
        assert set(app_module._normalize_filters(hostile)) == expected


def test_normalize_filters_drops_values_outside_the_vocabulary(app_module):
    result = app_module._normalize_filters(
        {
            "area": "Nowhere",
            "severity": "catastrophic",
            "timeOfDay": "dusk",
            "weather": "hail",
            "cause": "aliens",
            "vehicle": "spaceship",
        }
    )
    assert all(value is None for value in result.values())


def test_normalize_filters_keeps_valid_values(app_module):
    result = app_module._normalize_filters(
        {"area": "adyar", "severity": "FATAL", "timeOfDay": "night",
         "weather": "rain", "cause": "over-speeding", "vehicle": "car"}
    )
    assert result == {
        "area": "Adyar", "severity": "fatal", "timeOfDay": "night",
        "weather": "rain", "cause": "Over-speeding", "vehicle": "Car",
    }


def test_normalize_filters_cannot_pass_through_a_mongo_operator(app_module):
    """A model that emits an injection payload must be neutralised to None."""
    result = app_module._normalize_filters({"area": {"$where": "sleep(5000)"}})
    assert result["area"] is None


@pytest.mark.parametrize(
    "raw",
    [
        '{"answer": "hi", "filters": null}',
        '```json\n{"answer": "hi", "filters": null}\n```',
        'Sure!\n{"answer": "hi", "filters": null}\nHope that helps.',
    ],
)
def test_parse_ask_json_tolerates_fences_and_stray_prose(app_module, raw):
    assert app_module._parse_ask_json(raw)["answer"] == "hi"


def test_parse_ask_json_returns_none_for_unparseable_text(app_module):
    assert app_module._parse_ask_json("no json at all") is None
    assert app_module._parse_ask_json("") is None
    assert app_module._parse_ask_json(None) is None


# --- Vocabulary integrity -----------------------------------------------------

def test_bot_vocabularies_match_the_shipped_dataset(app_module):
    """The AI's allowed values must equal what is actually in accidents.json,
    or a valid filter can select nothing (or a real value can never be filtered)."""
    import json
    import pathlib

    dataset = json.loads(
        (pathlib.Path(app_module.FRONTEND_DIR) / "data" / "accidents.json").read_text(encoding="utf-8")
    )
    assert {row["area"] for row in dataset} == set(app_module.BOT_AREAS)
    assert {row["cause"] for row in dataset} == set(app_module.BOT_CAUSES)
    assert {row["vehicle"] for row in dataset} == set(app_module.BOT_VEHICLES)
    assert {row["severity"] for row in dataset} == app_module.BOT_SEVERITY
    assert {row["weather"] for row in dataset} == app_module.BOT_WEATHER
