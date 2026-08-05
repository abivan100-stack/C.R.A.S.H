"""Regression tests for F017 and F018 — the static host must publish the site, not the repo.

Before the fix the app did `app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True))`,
which served the entire repository root. Verified reachable over HTTP against the
running app: /.git/config (200, 411 bytes), /.git/HEAD (200) and /.venv/pyvenv.cfg (200).

The `/backend/{rest:path}` guard meant to protect the secrets directory was itself
incomplete in two ways, both reproduced:
  * `HEAD /backend/.env.example` returned 200 — FastAPI's APIRoute registers only
    the methods you name, unlike Starlette's Route which adds HEAD alongside GET.
  * `GET /%2e/backend/.env.example` returned 200 — the literal prefix never matched,
    so the request fell straight through to StaticFiles.
"""

import pytest

# Every path that must NOT be served, whatever the method or encoding.
FORBIDDEN = [
    # Version control — the original critical exposure.
    "/.git/config",
    "/.git/HEAD",
    "/.git/index",
    # Secrets and server source.
    "/backend/.env",
    "/backend/.env.example",
    "/backend/main.py",
    "/backend/requirements.txt",
    "/backend/README.md",
    # Virtualenv and tooling.
    "/.venv/pyvenv.cfg",
    "/.gitignore",
    "/.gitattributes",
    "/pyproject.toml",
    "/package.json",
    "/package-lock.json",
    "/render.yaml",
    # Project docs and internal working files.
    "/CLAUDE.md",
    "/README.md",
    "/DESIGN_LANGUAGE.md",
    "/audit/01-findings.md",
    "/tests/backend/conftest.py",
    "/scripts/snap_to_roads.py",
    "/data/_generate_final.py",
    # Pre-snap working datasets that nothing fetches.
    "/data/accidents.backup.json",
    "/data/citizen_seed.backup.json",
]

# Encoding and traversal variants of the same target.
BYPASS_ATTEMPTS = [
    "//backend/.env.example",
    "/./backend/.env.example",
    "/%2e/backend/.env.example",
    "/%2E/backend/.env.example",
    "/backend/../backend/.env.example",
    "/data/../backend/.env.example",
    "/data/..%2fbackend/.env.example",
    "/shared/../../backend/.env.example",
    "/%2e%2e/backend/.env.example",
    "/....//backend/.env.example",
    "/shared/..%5cbackend%5c.env.example",
]


@pytest.mark.parametrize("path", FORBIDDEN)
def test_forbidden_paths_are_not_served(client, path):
    response = client.get(path)
    assert response.status_code == 404, f"{path} is exposed ({len(response.content)} bytes)"


@pytest.mark.parametrize("path", FORBIDDEN)
def test_forbidden_paths_are_not_served_over_head(client, path):
    """HEAD was the original bypass: it fell through to a different code path."""
    response = client.head(path)
    assert response.status_code == 404, f"{path} is exposed to HEAD"


@pytest.mark.parametrize("path", BYPASS_ATTEMPTS)
def test_encoding_and_traversal_bypasses_are_blocked(client, path):
    for method in ("get", "head"):
        response = getattr(client, method)(path)
        assert response.status_code == 404, f"{method.upper()} {path} bypassed the allowlist"


def test_no_method_reaches_a_different_code_path(client):
    """Every verb on a secret path must be refused, not just GET."""
    for method in ("get", "head", "post", "put", "patch", "delete", "options"):
        response = getattr(client, method)("/backend/.env.example")
        assert response.status_code in (404, 405), f"{method.upper()} returned {response.status_code}"
        assert b"MONGODB_URI" not in response.content


def test_directory_listings_are_not_served(client):
    for path in ("/data/", "/shared/", "/vendor/", "/backend/", "/"):
        response = client.get(path)
        assert response.status_code in (200, 404)
        # "/" is the landing page; nothing else may return a listing.
        if path != "/":
            assert b"Index of" not in response.content


# --- the site itself must still work -----------------------------------------

@pytest.mark.parametrize(
    "path",
    [
        "/landing.html", "/index.html", "/dashboard.html", "/analytics.html", "/compare.html",
        "/app.js", "/analytics.js", "/bot.js", "/compare.js", "/simulate.js",
        "/report.js", "/notifications.js", "/maptiler.js", "/intervention-model.js",
        "/shared/constants.js", "/shared/utils.js", "/shared/engine.js",
        "/vendor/chart.umd.js", "/vendor/leaflet-heat.js",
        "/vendor/jspdf.umd.min.js", "/vendor/jspdf.plugin.autotable.min.js",
        "/data/accidents.json", "/data/citizen_seed.json",
        # Vendored Leaflet ships its own nested asset tree. This caught a real
        # bug: the allowlist originally permitted only depth-2 paths, so
        # vendoring Leaflet would have 404'd and shipped a broken map.
        "/vendor/leaflet/leaflet.js", "/vendor/leaflet/leaflet.css",
        "/vendor/leaflet/images/marker-icon.png", "/vendor/leaflet/images/layers.png",
    ],
)
def test_every_asset_the_site_actually_loads_is_still_served(client, path):
    response = client.get(path)
    assert response.status_code == 200, f"{path} is no longer served — the site is broken"
    assert len(response.content) > 0


def test_cache_busted_urls_still_resolve(client):
    """The pages request assets as e.g. app.js?v=phase21."""
    assert client.get("/app.js", params={"v": "phase21"}).status_code == 200
    assert client.get("/data/accidents.json", params={"v": "9"}).status_code == 200


def test_the_home_page_is_the_landing_page(client):
    response = client.get("/")
    assert response.status_code == 200
    assert b"<title>" in response.content


def test_api_routes_still_win_over_the_catch_all(client):
    """The allowlist route is a catch-all; it must not shadow the API."""
    assert client.get("/health").status_code == 503          # reached the API, not a 404 file miss
    assert client.post("/report", json={}).status_code == 422
    assert client.post("/ask", json={"question": ""}).status_code == 200


@pytest.mark.parametrize(
    "path",
    [
        "/vendor/../backend/.env.example",
        "/vendor/leaflet/../../backend/main.py",
        "/shared/../.git/config",
        "/vendor/.hidden/secret.js",
        "/vendor/leaflet/../../../etc/passwd",
        "/shared/deep/nested/secret.py",
        "/vendor/x.py",
        "/vendor/leaflet/images/../../../backend/main.py",
    ],
)
def test_nesting_inside_asset_directories_cannot_be_used_to_escape(client, path):
    """Allowing nested paths under vendor/ must not weaken the traversal guards."""
    assert client.get(path).status_code == 404


def test_no_page_loads_leaflet_from_a_cdn(client):
    """A CDN or venue-wifi hiccup must not be able to kill every map (F027)."""
    for page in ("/index.html", "/landing.html", "/dashboard.html"):
        body = client.get(page).text
        assert "unpkg.com" not in body, f"{page} still loads Leaflet from unpkg"


def test_unknown_paths_404_cleanly(client):
    for path in ("/nope.html", "/shared/nope.js", "/data/nope.json", "/deep/nested/path.js"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.json()["detail"] == "Not Found"
