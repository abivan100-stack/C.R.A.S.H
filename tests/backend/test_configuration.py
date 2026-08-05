"""Tests for findings F023, F025 and F026 — CORS, dependency pinning, deployment config.

These assert facts about how the service is configured, because all three defects
were invisible at runtime in development and only bite in production:
  * CORS wildcard: harmless-looking on a single-origin app, but it lets any site
    read /reports and /export/xlsx from a visitor's browser.
  * Unpinned dependencies: the app works until a deploy resolves a new version.
  * A missing env var in the blueprint: the bot is simply dead, with no error.
"""

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


# --- CORS (F023) --------------------------------------------------------------

def test_no_cors_headers_are_granted_by_default(client):
    """Single-origin app: the browser never needs a CORS grant."""
    response = client.get("/reports", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in {k.lower() for k in response.headers}


def test_a_cross_origin_preflight_is_not_granted_by_default(client):
    response = client.options(
        "/report",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert "access-control-allow-origin" not in {k.lower() for k in response.headers}


def _code_lines(path):
    """Source lines with comments stripped — the comments here DESCRIBE the old
    wildcard and the URI format, so a naive substring search matches the very
    documentation explaining why they are gone."""
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0]
        if line.strip():
            yield line


def test_the_wildcard_is_gone_from_the_source(app_module):
    code = "\n".join(_code_lines(app_module.__file__))
    assert 'allow_origins=["*"]' not in code
    assert "allow_origins=['*']" not in code


def test_extra_origins_can_still_be_granted_explicitly(monkeypatch):
    """The escape hatch must actually work if someone deploys a separate frontend."""
    import importlib
    import sys

    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://crash.example,https://other.example")
    monkeypatch.delenv("MONGODB_URI", raising=False)
    monkeypatch.setattr("dotenv.load_dotenv", lambda *a, **k: False)
    sys.modules.pop("backend.main", None)
    module = importlib.import_module("backend.main")

    from fastapi.testclient import TestClient
    with TestClient(module.app) as client:
        response = client.get("/index.html", headers={"Origin": "https://crash.example"})
        assert response.headers.get("access-control-allow-origin") == "https://crash.example"
        # An origin NOT on the list still gets nothing.
        denied = client.get("/index.html", headers={"Origin": "https://evil.example"})
        assert denied.headers.get("access-control-allow-origin") is None

    sys.modules.pop("backend.main", None)


def test_credentials_are_never_allowed(app_module):
    """This API has no cookies or sessions; allowing credentials would be all risk."""
    code = "\n".join(_code_lines(app_module.__file__))
    assert "allow_credentials=True" not in code


# --- dependency pinning (F025) ------------------------------------------------

REQUIREMENTS = ROOT / "backend" / "requirements.txt"


def _requirement_lines():
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.split("#", 1)[0].strip()
        if line:
            yield line


def test_every_dependency_is_pinned_to_an_exact_version():
    unpinned = [line for line in _requirement_lines() if "==" not in line]
    assert unpinned == [], f"unpinned dependencies would make builds non-reproducible: {unpinned}"


def test_pins_are_exact_not_ranges():
    for line in _requirement_lines():
        assert re.fullmatch(r"[A-Za-z0-9_.\-]+==[0-9][A-Za-z0-9_.\-]*", line), \
            f"not an exact pin: {line!r}"


def test_the_pinned_versions_are_the_ones_actually_installed():
    """The pins must match the stack the suite just ran against, or they prove nothing."""
    from importlib.metadata import version

    for line in _requirement_lines():
        name, pinned = line.split("==")
        assert version(name) == pinned, \
            f"{name} is pinned to {pinned} but {version(name)} is installed and under test"


def test_the_critical_transitive_packages_are_pinned():
    """starlette and pydantic are where an upstream break actually reaches this code."""
    pinned = {line.split("==")[0].lower() for line in _requirement_lines()}
    assert {"starlette", "pydantic"} <= pinned


# --- deployment blueprint (F026) ----------------------------------------------

RENDER_YAML = ROOT / "render.yaml"


def test_the_blueprint_declares_every_environment_variable_the_code_reads(app_module):
    """A variable the code reads but the blueprint omits fails silently in production."""
    source = Path(app_module.__file__).read_text(encoding="utf-8")
    read_by_code = set(re.findall(r'os\.environ\.get\(\s*"([A-Z_]+)"', source))
    declared = set(re.findall(r"- key:\s*([A-Z_]+)", RENDER_YAML.read_text(encoding="utf-8")))

    # Variables with a working default need not be declared; secrets must be.
    required = {"MONGODB_URI", "ANTHROPIC_API_KEY"} & read_by_code
    assert required <= declared, f"read by main.py but missing from render.yaml: {required - declared}"


def test_secrets_are_marked_sync_false_and_never_given_a_value():
    text = RENDER_YAML.read_text(encoding="utf-8")
    for secret in ("MONGODB_URI", "ANTHROPIC_API_KEY"):
        block = text.split(f"- key: {secret}", 1)[1].split("- key:", 1)[0]
        assert "sync: false" in block, f"{secret} is not marked sync: false"
        assert "value:" not in block, f"{secret} has a literal value in the blueprint"


@pytest.mark.parametrize("secret", ["mongodb+srv://", "sk-ant-", "AKIA"])
def test_no_credential_shaped_string_is_committed_in_config(secret):
    """Comments are stripped first: they legitimately mention the URI *format*
    while explaining why the real value must never be committed."""
    for path in (RENDER_YAML, REQUIREMENTS, ROOT / "package.json"):
        code = "\n".join(_code_lines(path))
        assert secret not in code, f"{secret!r} appears in {path.name}"
