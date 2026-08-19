"""Regression tests for F022 and F024 — error responses must not leak, and failures must be logged.

Before the fix, six handlers interpolated raw exception text into the HTTP
response. Verified against a running app with a bad URI configured:

    GET /health -> 503
    {"detail":"MongoDB unreachable: nonexistent-cluster.abc123.mongodb.net:27017:
     [Errno 11001] getaddrinfo failed ... Topology Description: <ServerDescription
     ('nonexistent-cluster.abc123.mongodb.net', 27017) server_type: Unknown ..."}

That is the Atlas hostname, cluster identifier and internal driver topology handed
to any anonymous caller on a public endpoint. Meanwhile the backend had no logging
at all, so the only record of a failure was the text that must not be sent.
"""

import logging

import pytest

# NOT a real credential shape on purpose: RFC 2606 reserved domain, so this can
# never be mistaken for (or match a scanner's pattern for) a live Atlas URI.
SECRET_URI = "mongodb://placeholderuser:placeholderpass@fixture-cluster.example:27017/?directConnection=true"


@pytest.fixture
def broken_db(app_module, monkeypatch):
    """An app whose every database call raises, carrying credentials in the message."""

    class ExplodingCollection:
        def find(self, *a, **k):
            raise RuntimeError(f"connection refused to {SECRET_URI}")

        def insert_one(self, *a, **k):
            raise RuntimeError(f"connection refused to {SECRET_URI}")

    class ExplodingClient:
        admin = type("Admin", (), {"command": staticmethod(
            lambda *a, **k: (_ for _ in ()).throw(RuntimeError(f"ping failed: {SECRET_URI}")))})()

        def __getitem__(self, _name):
            return {"citizen_reports": ExplodingCollection()}

    monkeypatch.setattr(app_module, "_client", ExplodingClient())
    from fastapi.testclient import TestClient
    with TestClient(app_module.app, raise_server_exceptions=False) as test_client:
        yield test_client


# --- nothing sensitive reaches the client -------------------------------------

@pytest.mark.parametrize("method,path", [("get", "/health"), ("get", "/reports"), ("get", "/export/xlsx")])
def test_error_bodies_do_not_leak_connection_details(broken_db, method, path):
    response = getattr(broken_db, method)(path)

    assert response.status_code >= 400
    body = response.text
    for leak in ["placeholderpass", "placeholderuser", "fixture-cluster.example",
                 "ServerDescription", "Topology", "Traceback", "connection refused"]:
        assert leak not in body, f"{path} leaked {leak!r}: {body[:300]}"


def test_report_insert_failure_does_not_leak(broken_db, valid_report):
    response = broken_db.post("/report", json=valid_report)
    assert response.status_code >= 400
    assert "placeholderpass" not in response.text
    assert "fixture-cluster.example" not in response.text


def test_error_bodies_still_say_something_useful(broken_db):
    """Generic must not mean useless — the user needs to know what failed."""
    body = broken_db.get("/reports").json()
    assert "detail" in body
    assert "report" in body["detail"].lower()


# --- correlation --------------------------------------------------------------

def test_every_response_carries_a_request_id(client):
    response = client.get("/health")
    assert response.headers.get("X-Request-ID")
    assert len(response.headers["X-Request-ID"]) <= 64


def test_error_details_quote_the_request_id_so_a_user_report_can_be_traced(broken_db):
    response = broken_db.get("/reports")
    request_id = response.headers["X-Request-ID"]
    assert request_id in response.json()["detail"]


def test_request_ids_differ_between_requests(client):
    first = client.get("/health").headers["X-Request-ID"]
    second = client.get("/health").headers["X-Request-ID"]
    assert first != second


def test_a_caller_supplied_request_id_is_echoed_when_it_is_well_formed(client):
    response = client.get("/health", headers={"X-Request-ID": "abc123def456"})
    assert response.headers["X-Request-ID"] == "abc123def456"


@pytest.mark.parametrize(
    "hostile",
    [
        "id with spaces",
        "id\nInjected: log-line",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "x" * 200,
        "id;rm -rf /",
    ],
)
def test_a_hostile_request_id_is_replaced_not_echoed(client, hostile):
    """The ID lands in log lines, so it must not carry newlines or markup."""
    response = client.get("/health", headers={"X-Request-ID": hostile})
    returned = response.headers["X-Request-ID"]

    assert returned != hostile
    assert returned.isalnum()
    assert len(returned) <= 64


# --- the detail is logged, not discarded --------------------------------------

def test_the_real_cause_is_written_to_the_log(broken_db, caplog):
    with caplog.at_level(logging.ERROR, logger="crash"):
        broken_db.get("/reports")

    assert caplog.records, "the failure was swallowed — nothing was logged"
    combined = "\n".join(r.getMessage() for r in caplog.records)
    assert "reports query failed" in combined
    # The operator DOES need the real cause; it just must not go to the client.
    assert "connection refused" in combined


def test_log_records_carry_the_request_id(broken_db, caplog):
    with caplog.at_level(logging.ERROR, logger="crash"):
        response = broken_db.get("/reports")

    request_id = response.headers["X-Request-ID"]
    assert any(getattr(r, "request_id", None) == request_id for r in caplog.records), \
        "no log record was tagged with the request ID, so logs cannot be correlated"


def test_the_config_summary_never_contains_secret_values(app_module, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secret-value")
    summary = app_module._safe_config_summary()

    assert summary == {"mongodb_configured": False, "anthropic_configured": True}
    assert "sk-ant-secret-value" not in str(summary)
