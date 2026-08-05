# Phase 0 — Baseline

Recorded 2026-08-05, before any change. Branch cut from `main` @ `23962be`.

## Repo map

| Aspect | Finding |
|---|---|
| Languages | Python 3.12 (backend + offline data scripts), vanilla JS (ES2020), HTML/CSS |
| Frameworks | FastAPI + Uvicorn (server); Leaflet 1.9.4, Chart.js 4.4.1, jsPDF (browser, vendored) |
| Entry points | `backend/main.py:app` (serves API **and** static site, single origin); `landing.html` at `/`, `index.html` = SPA |
| Build system | **None.** No bundler, no transpile step. `package.json` has only `start` / `start:prod` uvicorn scripts and zero dependencies. |
| Test runner | **None.** No test file, no test config, no `pytest`/`jest`/`vitest` anywhere in the repo. |
| Linter / type-checker | **None configured.** No `pyproject.toml`, `ruff.toml`, `.eslintrc`, `mypy.ini`, `tsconfig.json`. |
| CI | **None.** No `.github/`, no `.gitlab-ci.yml`, no Dockerfile. |
| Dependency manifests | `backend/requirements.txt` (6 deps, **all unpinned**), `package.json` (0 deps), `package-lock.json` (empty tree) |
| Deployment | `render.yaml` — one Render web service, `healthCheckPath: /health` |
| Tracked files | 40 |

## Toolchain

**Blocker found and resolved.** The machine had no Python interpreter — only the
Microsoft Store alias stub at `C:\Users\user\AppData\Local\Microsoft\WindowsApps\python.exe`.
Nothing backend-side could be built, run, or tested. With the user's approval:

```
winget install --id Python.Python.3.12 --scope user   # -> Python 3.12.10
python -m venv .venv
.venv/Scripts/python -m pip install -r backend/requirements.txt
.venv/Scripts/python -m pip install pytest httpx ruff mongomock
```

`.venv/` is already covered by `.gitignore`.

Node v24.18.0 and npm 11.16.0 were already present.

### Versions resolved by the unpinned requirements (2026-08-05)

```
anthropic 0.120.2   fastapi 0.141.1   starlette 1.4.0   pydantic 2.13.4
pymongo 4.17.0      uvicorn 0.52.1    dnspython 2.8.0   python-dotenv 1.2.2
truststore 0.10.4   httpx 0.28.1      certifi 2026.7.22
```

These are whatever was newest on the day of install — see finding on unpinned
dependencies. A fresh Render build resolves different versions than the developer
tested against.

## Baseline commands and raw output

### 1. Build

There is no build step. The closest equivalent is dependency install + import,
both of which succeed.

```
$ .venv/Scripts/python -c "import backend.main as m; print(m.app.routes)"
IMPORT OK
routes: ['/openapi.json', '/docs', '/docs/oauth2-redirect', '/redoc', '/health',
         '/report', '/reports', '/export/xlsx', '/ask', '/backend/{rest:path}', '/', '']
```

### 2. Test suite

```
$ ls **/test_*.py **/*_test.py **/*.test.js **/*.spec.js
(no matches — zero tests exist)
```

**Baseline test result: N/A — there is no test suite.** This is itself the single
largest gap against the production-grade bar.

### 3. Runtime smoke test (FastAPI TestClient, no env vars set)

```
GET /                     -> 200  60211B   (landing.html)
GET /index.html           -> 200 159825B   (SPA)
GET /health               -> 503     43B   {"detail":"MONGODB_URI is not configured."}
GET /reports              -> 500     57B   {"detail":"MONGODB_URI is not configured on the server."}
GET /export/xlsx          -> 500     57B   {"detail":"MONGODB_URI is not configured on the server."}
GET /backend/.env         -> 404     22B   (block route works for GET)
GET /data/accidents.json  -> 200 1831640B
POST /report              -> 500          {"detail":"MONGODB_URI is not configured on the server."}
POST /ask   (empty body)  -> 200          (short-circuits before the AI call)
```

The app starts and serves with **no** environment variables configured. It does not
fail fast; it degrades to a 500 per request. Carried into the findings.

### 4. Linter

No linter is configured, so this is a first run of `ruff` at its default ruleset
to establish a number — not a project-sanctioned gate.

```
$ .venv/Scripts/python -m ruff check --output-format=concise backend/ data/ scripts/
backend\main.py:15:1: I001 Import block is un-sorted or un-formatted
backend\main.py:120:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:131:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:146:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:288:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:405:5:  S110  `try`-`except`-`pass` detected, consider logging the exception
backend\main.py:405:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:411:16: BLE001 Do not catch blind exception: `Exception`
backend\main.py:429:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:438:9:  I001  Import block is un-sorted or un-formatted
backend\main.py:443:12: BLE001 Do not catch blind exception: `Exception`
backend\main.py:474:12: BLE001 Do not catch blind exception: `Exception`
data\_generate_final.py:17:1:   I001  Import block is un-sorted or un-formatted
data\_generate_final.py:112:12: RUF046 Value being cast to `int` is already an integer
data\_generate_final.py:118:49: PIE808 Unnecessary `start` argument in `range`
data\_generate_final.py:181:28: C408 Unnecessary `dict()` call
data\_generate_final.py:185:12:  C408 Unnecessary `dict()` call
data\_generate_final.py:193:1:   I001 Import block is un-sorted or un-formatted
data\_generate_final.py:195:22:  C401 Unnecessary generator
data\_generate_final.py:206:7:   UP031 Use format specifiers instead of percent format
data\_generate_final.py:208:7:   UP031 Use format specifiers instead of percent format
data\_generate_final.py:211:7:   UP031 Use format specifiers instead of percent format
scripts\snap_to_roads.py:24:1:   I001 Import block is un-sorted or un-formatted
scripts\snap_to_roads.py:26:5:   I001 Import block is un-sorted or un-formatted
scripts\snap_to_roads.py:28:1:   S110 `try`-`except`-`pass` detected
scripts\snap_to_roads.py:28:8:   BLE001 Do not catch blind exception: `Exception`
scripts\snap_to_roads.py:154:44: B023 Function definition does not bind loop variable `n`
scripts\snap_to_roads.py:164:34: RUF010 Use explicit conversion flag
Found 28 errors.
```

**Baseline: 28 lint findings.**

### 5. Type-checker

None configured. The backend has partial annotations only; the frontend is
untyped vanilla JS with no JSDoc types and no `tsconfig.json` checkJs setup.
**Baseline: N/A.**

### 6. JS syntax check (the only automated gate that existed in spirit)

```
$ for f in *.js shared/*.js; do node --check "$f"; done
OK  analytics.js          OK  app.js               OK  bot.js
OK  compare.js            OK  intervention-model.js OK  maptiler.js
OK  notifications.js      OK  report.js            OK  simulate.js
OK  shared/constants.js   OK  shared/engine.js     OK  shared/utils.js
```

**All 12 JS files parse. 0 syntax errors.**

## Baseline verdict

The baseline is **green in the narrow sense** — the app imports, every route
responds, and all JS parses — so later verification is meaningful. Nothing was
broken that needed fixing before audit work could begin.

It is **red against the production-grade bar**: zero tests, zero lint config,
zero CI, zero type checking, all dependencies unpinned, and no fail-fast on
missing configuration.

## Notes carried into Phase 1

- `POST /report` returns **500** for a *configuration* error; 503 is the correct
  code (the request was fine, the server isn't ready).
- `starlette 1.4.0` emits `StarletteDeprecationWarning: Using httpx with
  starlette.testclient is deprecated` — a direct consequence of unpinned deps
  resolving a much newer stack than the code was written against.
- `GET /backend/.env` correctly 404s, but the block route is registered with
  `@app.get` only — non-GET methods need checking.
