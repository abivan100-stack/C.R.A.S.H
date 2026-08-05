"""Shared pytest fixtures for the CRASH backend suite.

The app builds its MongoClient at import time from MONGODB_URI, so every test
that touches a DB route swaps `backend.main._client` for an in-memory
mongomock client. Nothing here ever dials a real network service.
"""

import importlib
import sys

import mongomock
import pytest


@pytest.fixture
def app_module(monkeypatch):
    """Import backend.main fresh with no environment configured.

    Re-imported per test so module-level state (the Mongo client, the cached
    Anthropic client) never leaks between tests.
    """
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    # Stop python-dotenv from loading a developer's real backend/.env.
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    sys.modules.pop("backend.main", None)
    module = importlib.import_module("backend.main")
    yield module
    sys.modules.pop("backend.main", None)


@pytest.fixture
def client(app_module):
    """TestClient over an app with NO MongoDB and NO Anthropic key configured."""
    from fastapi.testclient import TestClient

    with TestClient(app_module.app) as test_client:
        yield test_client


@pytest.fixture
def mongo_collection(app_module, monkeypatch):
    """Point the app at an empty in-memory collection and hand it back."""
    fake = mongomock.MongoClient()
    monkeypatch.setattr(app_module, "_client", fake)
    return fake[app_module.DB_NAME][app_module.COLLECTION_NAME]


@pytest.fixture
def db_client(app_module, mongo_collection):
    """TestClient over an app backed by the in-memory Mongo collection."""
    from fastapi.testclient import TestClient

    with TestClient(app_module.app) as test_client:
        yield test_client


@pytest.fixture
def valid_report():
    """A well-formed citizen report matching the documented 8-field schema."""
    return {
        "lat": 13.0067,
        "lng": 80.2206,
        "severity": "serious",
        "datetime": "2025-06-01 14:30",
        "weather": "clear",
        "cause": "Over-speeding",
        "vehicle": "Two-wheeler",
        "area": "Guindy",
    }
