# Phase 2 — Triage and ordered fix queue

Input: `audit/01-findings.md`, 260 findings (9 critical / 40 high / 73 medium / 138 low).

## Ranking method

Ordered by **severity × blast radius × confidence**, with two tie-breakers that
matter for this specific project:

1. **Demo safety.** `CLAUDE.md` states this must work live in front of judges with
   no network hiccups. A defect that breaks the app mid-demo outranks a defect of
   equal severity that only degrades it.
2. **Cheapness of the exploit.** A stored-XSS sink that fires on *hover* or on
   *page load* outranks one that needs a click.

## What is in scope for Phase 3

- **All 9 critical and all 40 high findings** — fixed or explicitly deferred with a reason.
- **Medium findings that are cheap and safe** — folded into the commit that already
  touches that file.
- **Low findings** — mostly deferred to `audit/03-deferred.md`. 138 low-severity items
  is not a good use of the remaining budget, and churning 12 files for cosmetics
  works against demo stability. Lows that are one-line and zero-risk get swept up.

---

## FLAGGED — needs your decision before I touch it

These change what a judge actually sees on screen, or an API contract. I have **not**
acted on any of them. Everything else proceeds without approval.

| # | Finding | What changes on screen | My recommendation |
|---|---|---|---|
| D1 | **F034** — "preventable severe crashes" prints `(fatal×3 + serious) × eff`, a severity-weighted score, as an incident **count**. Top-10 total claims 566 of 1,391 actual severe crashes = 40.7%, above the model's own best-case 35% effectiveness; Maduravoyal claims 51% from a fix rated 0.35 | Every "≈ N preventable" number drops, on the map dossier, analytics, compare and the PDF | **Fix it.** The number is currently indefensible if a judge checks the arithmetic — it can exceed the actual crash count. Suggested: `round((fatal + serious) × eff)`, capped at `fatal + serious` |
| D2 | **F035** — the "Emerging hotspots" KPI renders `emerging.length`, which is structurally capped at `EMERGE_TOP_N = 6`. 25 cells actually qualify | KPI changes from a stuck "6" to the true count | **Fix it.** Return the full candidate count alongside the capped display list |
| D3 | **F037** — with a filter that yields zero fatals, `fShare >= gFatalShare` is `0 >= 0`, so **every** zone is labelled "Fatal-dominant" and painted fatal-red while showing 0 fatalities | Zone colours and labels change under fatal-free filters | **Fix it.** This is a plain bug, not a judgement call — guard the zero case |
| D4 | **F036** — one old-dated citizen report inflates `monthCount` 24 → 138, so the "avg per month" KPI reads **74 instead of 424** | KPI becomes stable; a deliberately old report no longer moves it | **Fix it.** Anchor the window to `max(_ym)` over a fixed 24-month horizon |
| D5 | `landing.html:442,455,482,776` states **7,291 incidents** in four places; the dataset holds **10,169**. The hardcoded severity bar overstates the fatal share ~2× | The landing page's headline statistics change | **Fix it.** A judge who opens the dataset will find the discrepancy |
| D6 | `index.html:1000` tells users "Reports are saved in this browser only — **nothing is uploaded**" while `handleSubmit` POSTs them to shared MongoDB | Report-tab copy becomes accurate | **Fix it.** This is a factual misstatement about where personal data goes. I'd rewrite it to say reports sync to the shared map |
| D7 | **F020** — `POST /report` returns **500** when `MONGODB_URI` is unset. It's a configuration problem, not a request failure | Status code only; the JSON body is unchanged | **Fix it** (500 → 503). Low risk, but it *is* an API contract change |
| D8 | **F023** — `allow_origins=["*"]` on an app that is deliberately single-origin | Nothing, unless you open the app from a different origin than the API | **Fix it.** Restrict to same-origin. Tell me if you ever open `index.html` off a `file://` path or a second domain, because that would break |
| D9 | **F027** — Leaflet CSS+JS load from `unpkg.com` while Chart.js, jsPDF and leaflet-heat are all vendored locally. No CDN → no map, on every page | Nothing visually; adds ~150 KB of vendored JS+CSS to the repo | **Fix it.** This is the single most likely live-demo failure and it directly contradicts the project's own "vendor everything" stance |
| D10 | **F028** — a live MapTiler API key is hardcoded at `maptiler.js:10` in a public repo | Nothing, if you rotate the key | **You must act, I cannot.** Rotate the key in your MapTiler account and restrict it to your Render domain. I can move it to a config file, but a browser-delivered map key is always public — domain restriction is the only real control |

---

## Fix queue — ordered, grouped into commits

Each group is one commit. `[V]` = already reproduced by a running command in Phase 2.

### Tier 1 — Critical, exploitable, cheap to trigger

| # | Commit | Findings | Notes |
|---|---|---|---|
| 1 | `security: escape citizen-report data in every HTML sink` | F001, F002, F003, F009–F015 (19 sinks) | `CU.escapeHtml` already exists and is already used correctly by `bot.js`/`notifications.js`. Purely mechanical, behaviour-preserving for all legitimate data. Regression test asserts a payload renders inert |
| 2 | `security: stop the severity string writing arbitrary cell keys` | **F260** `[V]` | Accumulate into a whitelisted `sev` sub-object; replace `SEV[x]` truthiness guards with `hasOwnProperty`. Test asserts `norm` stays numeric under a crafted severity |
| 3 | `security: validate citizen reports at the API boundary` | F016 `[V]`, F007 `[V]` | Pydantic: enum literals for severity/weather/cause/vehicle/area, `Field(ge/le)` Chennai bounds, finite-float guard, length caps, datetime format. Kills the NaN hard-500 and most of the XSS payload surface at source |
| 4 | `fix: abort fetches that stall mid-body` | F004 `[V]` | Move `clearTimeout` into `finally` at all 5 sites. Reproduced against a real stalling server |

### Tier 2 — Critical/high availability and exposure

| # | Commit | Findings | Notes |
|---|---|---|---|
| 5 | `fix: serve only the frontend, not the whole repo` | F017 `[V]`, F018 `[V]` | Replace the repo-root mount with an explicit allowlist of the site's own files/dirs. Closes `/.git/config`, `/.venv/*`, the `HEAD` bypass and the `%2e` bypass in one change |
| 6 | `fix: decouple the health check from MongoDB` | F006, F008 `[V]` | `/health` returns 200 when the *process* is healthy; DB state moves to `/health/db`. Build the MongoClient lazily so a malformed URI can no longer stop uvicorn booting. **Requires updating `render.yaml`'s `healthCheckPath` reasoning — same commit** |
| 7 | `security: stop returning raw exception text to clients` | F022 `[V]` | Generic client-facing messages; full detail goes to the log. Stops `/health` leaking the Atlas hostname and topology |
| 8 | `fix: strip XML-illegal control characters from the xlsx export` | F021 `[V]` | Sanitise in `_worksheet_xml`; test asserts the sheet parses with `ET.fromstring` |
| 9 | `feat: structured logging with request IDs` | F024 | `logging` config, a request-ID middleware, log on every failure path. Explicitly never logs the URI, the API key, or full question text |
| 10 | `fix: fail fast and loudly on missing configuration` | part of F025/F026 | Startup validation that reports exactly which env vars are missing, without aborting the static site |

### Tier 3 — High, resilience and correctness

| # | Commit | Findings | Notes |
|---|---|---|---|
| 11 | `fix: harden the /ask endpoint` | F019 | Explicit Anthropic timeout, per-IP rate limit, digest size cap, question length cap |
| 12 | `fix: never block the map on an optional backend call` | F005, F043 | Render from the static dataset first; fold in shared reports when they arrive |
| 13 | `fix: retry the notification poll with backoff and surface failure` | F040, F041, F042 | Bounded exponential backoff, visible "sync offline" state, baseline seeded from boot data |
| 14 | `fix: reuse one canvas renderer instead of leaking one per render` | F038 | `simulate.js:669` already does this correctly — copy that pattern into `app.js` and `bot.js` |
| 15 | `fix: guard the zero-fatal case in zone dominance` | **D3 / F037** | Flagged above |
| 16 | `fix: anchor the analysis window to a fixed horizon` | **D4 / F036** `[V]` | Flagged above |
| 17 | `fix: report the true emerging-hotspot count` | **D2 / F035** `[V]` | Flagged above |
| 18 | `fix: correct the preventable-crashes arithmetic` | **D1 / F034** | Flagged above |
| 19 | `fix: guard the bot map against the ready race` | F039 | |
| 20 | `fix: include shared reports in the analytics totals` | F044 | |

### Tier 4 — Configuration, deployment, docs

| # | Commit | Findings | Notes |
|---|---|---|---|
| 21 | `chore: pin every backend dependency` | F025 | Pin to the versions this audit actually tested against |
| 22 | `chore: declare ANTHROPIC_API_KEY in the Render blueprint` | F026 | One-line, prevents a silently dead bot |
| 23 | `chore: vendor Leaflet` | **D9 / F027** | Flagged above |
| 24 | `fix: align cache-busters across pages` | F103 `[V]` | `citizen_seed.json?v=1`→`9`, `app.js` and `report.js` disagree between index and dashboard, several assets have none |
| 25 | `fix: correct the landing-page statistics` | **D5** | Flagged above |
| 26 | `fix: correct the report-form privacy copy` | **D6** | Flagged above |
| 27 | `docs: runbook + correct the stale claims` | F048 | README build/test/configure/deploy runbook; correct `CLAUDE.md`'s "night and rain increase severity", which the data does not support (fatal share: night 6.2% vs day 6.3%, rain 6.5% vs clear 6.2%, fog 5.9%) |
| 28 | `test: guard the data-generation scripts` | F045, F046, F047 | Atomic writes, `__file__`-relative paths, a post-write re-parse assertion, and a loud warning that re-running destroys road-snapped coordinates |

### Deferred — see `audit/03-deferred.md`

- **F028** (MapTiler key) — requires you to rotate it; I cannot.
- **F029** (Render free-tier cold start) — a plan change, not a code change. I'll document the warm-up step in the runbook.
- **F030 tail** (CI) — I'll add a GitHub Actions workflow only if you want one; it needs no decision but also runs nothing you can't run locally with `npm test`.
- Most of the 138 low findings, individually listed with reasons.

## Verification gate for every commit

```
node --test "tests/js/**/*.test.js"     # JS suite
python -m pytest                        # backend suite
python -m ruff check .                  # lint
npm run lint:js                         # all 12 JS files parse
```

No commit lands red.
