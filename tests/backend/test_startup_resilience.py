"""Regression tests for F008 — a bad MONGODB_URI must not take the whole site down.

The module used to build its MongoClient at import time, with a comment claiming
that was safe because the driver connects lazily. Connecting is lazy; PARSING is
not. Verified by execution:

    MONGODB_URI="mongodb+srv://u:p@bad host/db"
    -> pymongo.errors.ConfigurationError raised inside the constructor, at import,
       before uvicorn could bind a port.

So one typo in a Render environment variable took down the map, the analytics,
the comparison view and the simulation — none of which touch MongoDB at all.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient

# URIs that a tired human could plausibly paste into a Render env var.
BAD_URIS = [
    "mongodb+srv://user:pass@bad host/db",   # a literal space — the reproduced crash
    "not-a-uri-at-all",
    "http://wrong-scheme-entirely",
    "mongodb+srv://",
    "mongodb://",
    "   ",
]


@pytest.fixture
def app_with_uri(monkeypatch):
    """Import the app fresh with a given MONGODB_URI."""
    def _load(uri):
        monkeypatch.setenv("MONGODB_URI", uri)
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
        sys.modules.pop("backend.main", None)
        return importlib.import_module("backend.main")

    yield _load
    sys.modules.pop("backend.main", None)


@pytest.mark.parametrize("uri", BAD_URIS)
def test_a_malformed_uri_does_not_prevent_import(app_with_uri, uri):
    module = app_with_uri(uri)
    assert module.app is not None


@pytest.mark.parametrize("uri", BAD_URIS)
def test_the_static_site_still_serves_with_a_malformed_uri(app_with_uri, uri):
    """The whole point: the map does not need the database."""
    module = app_with_uri(uri)
    with TestClient(module.app) as client:
        for path in ("/", "/index.html", "/app.js", "/data/accidents.json"):
            assert client.get(path).status_code == 200, f"{path} died because of a bad URI"


@pytest.mark.parametrize("uri", BAD_URIS)
def test_report_routes_degrade_to_a_service_error_not_a_crash(app_with_uri, uri):
    module = app_with_uri(uri)
    with TestClient(module.app) as client:
        response = client.get("/reports")
        assert response.status_code in (500, 503)
        assert "detail" in response.json()


def test_a_broken_uri_is_not_reparsed_on_every_request(app_with_uri):
    """The parse failure is remembered, so a hot path does not re-raise per request."""
    module = app_with_uri("mongodb+srv://user:pass@bad host/db")
    with TestClient(module.app) as client:
        client.get("/reports")
        assert module._client_error is not None
        first = module._client_error
        client.get("/reports")
        assert module._client_error is first, "the URI was parsed again"


def test_the_uri_is_never_written_to_the_log(app_with_uri, caplog):
    import logging

    secret = "mongodb+srv://reportuser:sup3rs3cret@bad host/db"
    module = app_with_uri(secret)
    with caplog.at_level(logging.DEBUG):
        with TestClient(module.app) as client:
            client.get("/reports")

    combined = "\n".join(record.getMessage() for record in caplog.records)
    assert "sup3rs3cret" not in combined
    assert "reportuser" not in combined


def test_an_absent_uri_is_still_handled(app_with_uri, monkeypatch):
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    sys.modules.pop("backend.main", None)
    module = importlib.import_module("backend.main")

    with TestClient(module.app) as client:
        assert client.get("/index.html").status_code == 200
        assert client.get("/health").status_code == 503
        assert client.get("/reports").status_code == 503


def test_health_semantics_are_unchanged(app_with_uri):
    """/health is render.yaml's healthCheckPath and was deliberately left alone.

    It still returns 503 when the database is unavailable (finding F006, kept by
    explicit decision and recorded in audit/03-deferred.md). This test exists so
    the behaviour is not changed by accident later.
    """
    module = app_with_uri("mongodb+srv://user:pass@bad host/db")
    with TestClient(module.app) as client:
        response = client.get("/health")
    assert response.status_code == 503
