"""Regression tests for F016 and F007 — validating citizen reports at the boundary.

POST /report is public and unauthenticated. Whatever it accepts is stored and then
rendered on every visitor's map, so this is the trust boundary that matters most.

Before the fix the model was type-only (`lat: float`, `severity: str`, …) and
accepted NaN coordinates, 100 kB strings, XML control characters and HTML payloads.
The NaN case was the worst: the stdlib JSON parser accepts a bare `NaN` token, but
Starlette's serialiser raises `ValueError: Out of range float values are not JSON
compliant`, so ONE poisoned report permanently 500'd GET /reports for every client.
"""

import json

import pytest


def post(client, report, **overrides):
    body = dict(report)
    body.update(overrides)
    return client.post("/report", json=body)


def post_raw(client, report, **overrides):
    """POST a hand-built JSON body.

    Needed for the non-finite cases: `json=` goes through json.dumps, which
    refuses NaN, so a well-behaved HTTP client physically cannot send one. An
    attacker using curl can — Python's json.loads accepts the bare `NaN`,
    `Infinity` and `-Infinity` tokens on the server side. That asymmetry is
    exactly why this vector was reachable in production but invisible in
    ordinary testing.
    """
    body = dict(report)
    body.update(overrides)
    raw = json.dumps(body)   # allow_nan=True by default: emits bare NaN / Infinity
    return client.post("/report", content=raw, headers={"Content-Type": "application/json"})


# --- coordinates --------------------------------------------------------------

@pytest.mark.parametrize("token", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_coordinates_are_rejected(db_client, valid_report, token):
    """The F007 poisoning vector: NaN/Inf must never reach the database."""
    value = float(token)
    assert post_raw(db_client, valid_report, lat=value).status_code == 422
    assert post_raw(db_client, valid_report, lng=value).status_code == 422


def test_the_raw_body_really_does_carry_a_bare_nan_token(valid_report):
    """Guards the test itself: if json.dumps ever stopped emitting bare NaN,
    the test above would pass vacuously."""
    assert "NaN" in json.dumps({**valid_report, "lat": float("nan")})


def test_the_validation_error_response_does_not_echo_the_rejected_value(db_client, valid_report):
    """Found while fixing F007: adding validation alone was NOT enough.

    FastAPI's default 422 body includes the offending input under "input". For a
    NaN that made the *error response* raise "Out of range float values are not
    JSON compliant", so a correctly-rejected report still produced a 500. The
    custom handler reports the field and reason only.
    """
    response = post_raw(db_client, valid_report, lat=float("nan"))

    assert response.status_code == 422
    body = response.json()
    assert body["detail"] == "Validation failed"
    assert body["errors"][0]["field"] == "lat"
    assert "finite" in body["errors"][0]["message"].lower()
    assert "input" not in json.dumps(body), "the rejected value is echoed back"


def test_validation_errors_never_reflect_attacker_content(db_client, valid_report):
    """A rejected XSS payload must not come back in the error body."""
    payload = "<img src=x onerror=alert(1)>"
    response = post(db_client, valid_report, area=payload)

    assert response.status_code == 422
    assert payload not in response.text


def test_coordinates_outside_chennai_are_rejected(db_client, valid_report):
    for lat, lng in [(0.0, 0.0), (51.5, -0.12), (13.0, 9999.0), (-13.0, 80.2), (90.0, 180.0)]:
        assert post(db_client, valid_report, lat=lat, lng=lng).status_code == 422


def test_coordinates_inside_chennai_are_accepted(db_client, valid_report):
    for lat, lng in [(13.0067, 80.2206), (12.9165, 80.1235), (13.1067, 80.0950)]:
        assert post(db_client, valid_report, lat=lat, lng=lng).status_code == 200


def test_a_poisoned_report_cannot_break_the_reports_listing(db_client, valid_report):
    """End-to-end proof of the F007 fix: after every hostile attempt, /reports still serves."""
    post_raw(db_client, valid_report, lat=float("nan"))
    post_raw(db_client, valid_report, lng=float("inf"))
    for hostile in [
        {"severity": "<img src=x onerror=alert(1)>"},
        {"cause": "A" * 100_000},
        {"weather": "\x00\x08"},
        {"area": "'; return db.dropDatabase(); var x='"},
    ]:
        post(db_client, valid_report, **hostile)

    listing = db_client.get("/reports")
    assert listing.status_code == 200
    assert listing.json() == [], "a hostile report was stored despite validation"


# --- controlled vocabularies --------------------------------------------------

@pytest.mark.parametrize(
    "field,bad",
    [
        ("severity", "catastrophic"),
        ("severity", "toString"),          # the F260 inherited-member vector
        ("severity", "constructor"),
        ("severity", "count"),
        ("severity", "<img src=x onerror=alert(1)>"),
        ("weather", "hail"),
        ("weather", "\x00"),
        ("cause", "aliens"),
        ("cause", "<script>alert(1)</script>"),
        ("vehicle", "spaceship"),
        ("area", "Atlantis"),
        ("area", "</div><script>alert(1)</script>"),
    ],
)
def test_values_outside_the_vocabulary_are_rejected(db_client, valid_report, field, bad):
    assert post(db_client, valid_report, **{field: bad}).status_code == 422


def test_every_documented_vocabulary_value_is_accepted(db_client, valid_report, app_module):
    """The validator must not reject data the app itself produces."""
    for severity in sorted(app_module.SEVERITIES):
        assert post(db_client, valid_report, severity=severity).status_code == 200
    for weather in sorted(app_module.WEATHERS):
        assert post(db_client, valid_report, weather=weather).status_code == 200
    for cause in app_module.CAUSES:
        assert post(db_client, valid_report, cause=cause).status_code == 200
    for vehicle in app_module.VEHICLES:
        assert post(db_client, valid_report, vehicle=vehicle).status_code == 200
    for area in app_module.AREAS:
        assert post(db_client, valid_report, area=area).status_code == 200


def test_vocabularies_are_a_single_source_of_truth(app_module):
    """The AI's filter vocabulary and the report validator must never drift apart."""
    assert app_module.BOT_AREAS is app_module.AREAS
    assert app_module.BOT_CAUSES is app_module.CAUSES
    assert app_module.BOT_VEHICLES is app_module.VEHICLES
    assert app_module.BOT_SEVERITY is app_module.SEVERITIES
    assert app_module.BOT_WEATHER is app_module.WEATHERS


# --- datetime -----------------------------------------------------------------

@pytest.mark.parametrize(
    "bad",
    [
        "not-a-date",
        "2025-13-01 10:00",     # month 13
        "2025-02-30 10:00",     # never existed
        "2025-06-01T10:00",     # ISO 'T' — the frontend converts this to a space
        "2025-06-01 25:00",     # hour 25
        "2025-06-01",           # no time
        "",
        "2099-01-01 10:00",     # future: would stretch the analysis window
        "1970-01-01 00:00",     # implausibly old: the F036 KPI-inflation vector
    ],
)
def test_malformed_or_implausible_datetimes_are_rejected(db_client, valid_report, bad):
    assert post(db_client, valid_report, datetime=bad).status_code == 422


def test_a_well_formed_recent_datetime_is_accepted(db_client, valid_report):
    assert post(db_client, valid_report, datetime="2025-06-01 14:30").status_code == 200


# --- shape --------------------------------------------------------------------

def test_unknown_fields_are_rejected(db_client, valid_report):
    """extra='forbid' — a client cannot smuggle arbitrary keys into the document."""
    assert post(db_client, valid_report, citizen=True).status_code == 422
    assert post(db_client, valid_report, __proto__={"admin": True}).status_code == 422


@pytest.mark.parametrize("field", ["lat", "lng", "severity", "datetime", "weather", "cause", "vehicle", "area"])
def test_every_field_is_required(db_client, valid_report, field):
    body = dict(valid_report)
    del body[field]
    assert db_client.post("/report", json=body).status_code == 422


def test_surrounding_whitespace_is_stripped_not_rejected(db_client, valid_report):
    response = post(db_client, valid_report, area="  Guindy  ")
    assert response.status_code == 200
    assert db_client.get("/reports").json()[0]["area"] == "Guindy"


# --- unconfigured server ------------------------------------------------------

def test_missing_database_is_503_not_500(client, valid_report):
    """A configuration gap is not the caller's fault (finding D7)."""
    response = client.post("/report", json=valid_report)
    assert response.status_code == 503
    assert "database" in response.json()["detail"].lower()


def test_validation_runs_before_the_database_is_touched(client, valid_report):
    """A malformed body is 422 even with no DB configured — fail on the input first."""
    assert client.post("/report", json={**valid_report, "severity": "bogus"}).status_code == 422
