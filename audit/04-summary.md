# Phase 4 — Audit summary

Branch `hardening/production-audit`, cut from `main` @ `23962be`.
**Nothing has been pushed** — the `CLAUDE.md` gate holds until you say "no bugs".

---

## Findings

326 raw findings from eight parallel subagents → **260 unique** after dedup.

| Severity | Found | Fixed | Deferred | Not real |
|---|---|---|---|---|
| Critical | 9 | **8** | 1 | 0 |
| High | 40 | **31** | 8 | 1 |
| Medium | 73 | 24 | 49 | 0 |
| Low | 138 | 19 | 119 | 0 |
| **Total** | **260** | **82** | **177** | **1** |

- **Unconfirmed: 0.** Every finding acted on was reproduced first.
- **Corrected: 1.** F036's stated mechanism did not reproduce; the underlying
  defect was real and landed elsewhere. Both recorded.
- **Found during Phase 2, not by the fan-out: 2**, one of them critical (F260).

The deferred count is large and deliberate: 119 of the 177 are low-severity, and
churning twelve files for cosmetics works against the demo stability this project
needs. Every deferral has a stated reason in `audit/03-deferred.md`.

### The eight critical fixes

1. **Stored XSS across 19 sinks** — `POST /report` took any string, every client
   fetched it, and the HTML builders concatenated it straight into `innerHTML`
   and Leaflet popups. Cheapest variants needed no interaction: the ranked rail
   renders on page load, tooltips fire on hover.
2. **Severity key-injection (F260)** — `severity:"toString"` passed the
   `SEV[...]` truthiness guard (it resolves `Object.prototype`), reached the
   engine, and made the top-10 ranking emit `norm: NaN`. Found while verifying,
   missed by all eight subagents.
3. **NaN poisoning** — one report with a `NaN` coordinate made Starlette *raise*,
   permanently 500-ing `GET /reports` for every device.
4. **Repo root served over HTTP** — `/.git/config` returned 200. The `/backend/`
   block meant to protect secrets was bypassable via `HEAD` and `%2e`.
5. **A bad `MONGODB_URI` stopped the site booting** — the client was built at
   import, and parsing (unlike connecting) is not lazy. One typo took down the
   map, which needs no database.
6. **Fetches that never aborted** — all five cleared the abort timer on response
   headers, so a stalled body hung forever and latched notification sync off.
7. **The map waited on optional backend calls** before first paint.
8. **`/ask` was an open, unmetered LLM proxy** on your Anthropic key, with the
   SDK's 10-minute default timeout.

---

## Final verification

All four gates, run together on the final tree:

```
$ node --test "tests/js/**/*.test.js"
ℹ tests 83
ℹ pass 83
ℹ fail 0

$ python -m pytest
255 passed, 1 warning in 24.38s

$ python -m ruff check .
All checks passed!

$ npm run lint:js
all 12 JS files parse
```

**Type-checker: still N/A.** The frontend is untyped vanilla JS by design and the
backend has partial annotations only. Adding one was out of scope; it is the one
production-grade criterion not met.

### Against the production-grade bar

| Criterion | Status |
|---|---|
| Build, tests, lint, type-check pass | **3 of 4** — no type-checker exists |
| No hardcoded secrets; config from env, validated | **Met**, except the MapTiler key, which is public by design and needs a domain restriction from you |
| Every external call has a timeout and defined failure behaviour | **Met** — Mongo 5s, Anthropic 25s, all five frontend fetches abort correctly |
| Every error path handled or intentionally propagated | **Met** — no silent catches remain in shipped code |
| Input validated at trust boundaries | **Met** — `/report` and `/ask` fully constrained |
| Structured logging, correlation IDs, no secrets in logs | **Met** — was zero logging before |
| Health/readiness endpoints | **Partial** — `/health` exists; its DB coupling was kept by your decision |
| Graceful shutdown | **Not done** — the Mongo client is never explicitly closed. Low impact: it is stateless and Render SIGKILLs anyway |
| No dead code, debug prints, TODO/FIXME on critical paths | **Met** — the repo had no TODO/FIXME at all; the `console.table` in `simulate.js` remains (low, deferred) |
| Meaningful coverage on critical paths | **Met** — engine, xlsx, AI validator, report validation, static exposure, fetch timeouts all covered |
| Dependencies pinned | **Met** — all 8 pinned to tested versions |
| README documents build/test/configure/deploy | **Met** — plus a runbook |

---

## Commits, in order

| # | Commit | What |
|---|---|---|
| 1 | `4847dfa` | Record the Phase 0 baseline (found: no Python on the machine at all) |
| 2 | `e8fba5c` | `.gitignore` — tooling caches, de-duplicate |
| 3 | `9e3d7a0` | **The project's first test harness** — 25 pytest + 34 node:test, zero new deps |
| 4 | `c289120` | Consolidated findings register (326 → 260) |
| 5 | `2795d6d` | Triage and ordered fix queue |
| 6 | `4cc2a13` | **security:** escape citizen data in 19 HTML sinks |
| 7 | `1dbc77f` | **security:** stop a crafted severity poisoning the engine (F260) |
| 8 | `f86ee41` | **security:** validate reports at the API boundary |
| 9 | `2dd18aa` | Abort fetches that stall after headers |
| 10 | `917adba` | **security:** serve an allowlist, not the repository |
| 11 | `3e6f653` | Strip XML-illegal control chars from the xlsx export |
| 12 | `5477e41` | **security:** stop leaking internals; add correlated logging |
| 13 | `0fda292` | Lazy Mongo client so a bad URI cannot stop boot |
| 14 | `cf8cee6` | Cost and abuse controls on `/ask` |
| 15 | `14d04fc` | **security:** CORS, dependency pinning, missing env var |
| 16 | `f582533` | Correct four provably-wrong displayed figures |
| 17 | `1e15e7c` | Correct false on-screen claims; align cache-busters |
| 18 | `07216a2` | Vendor Leaflet (SRI-verified) |
| 19 | `e13b062` | Finish the cache-buster bump at the two JS fetch sites |
| 20 | `8a73caf` | Ruff to zero; narrow two blind excepts |
| 21 | `2e64a77` | Poll backoff + visible sync-offline state |
| 22 | `0fd00b4` | Paint the map before waiting on optional calls |
| 23 | `76a5d6c` | Bot map retry; analytics counts shared reports |
| 24 | *(this)* | Docs, runbook, deferred list, summary |

Every commit ran all four gates first. None was committed red.

---

## What I would look at myself

**In priority order.**

1. **Click through the app.** This is the biggest gap. Chrome in this environment
   could not reach the local server (the extension errored while `curl` returned
   200), so **nobody has looked at the rendered page.** The engines, numbers and
   security fixes are verified by execution; the *pixels* are not. The checklist
   is at the end of `audit/03-deferred.md`. The boot-path restructure in `0fd00b4`
   is the single change most worth eyeballing.

2. **Rotate and domain-restrict the MapTiler key.** Only you can. It has been
   readable in public git history since it was committed.

3. **Decide about `/health`.** You kept it as-is, which is defensible — but it
   means an Atlas outage takes the whole site dark, including pages that need no
   database. Know that before demo day: **if the site is dark, check Atlas.**

4. **Confirm which page you demo.** `dashboard.html` is missing six element IDs
   `app.js` looks for, so it silently lacks the Source filter, hospitals layer
   and citizen counter that `index.html` has. If your script says "open the
   dashboard", check which file that means.

5. **Drop the "night and rain increase severity" line** from any script or slide.
   It is documented in two places but is not in the data — measured: 6.2% fatal
   at night vs 6.3% by day, fog *below* baseline. Corrected in `README.md` and
   `CLAUDE.md`. A judge can disprove it in one line of JavaScript.

6. **The preventable-crashes number is now smaller** and that is correct — the
   old figure could exceed the actual crash count. If a slide quotes a specific
   total, re-read it off the app.

### Residual risk

- **No type checker**, so nothing catches a shape mismatch between `app.js` and
  the shared modules except the tests.
- **The rate limiter is in-process** and trusts `X-Forwarded-For`. It is a cost
  guard, not a security control.
- **`app.js` still carries a private duplicate** of `CE.computeEmerging`. Commit
  `3bea82b` already had to fix one regression from exactly this kind of
  duplication.
- **The data-generation scripts remain unsafe to re-run** — the generator alone
  silently destroys road-snapped coordinates. Documented, not fixed, because
  touching them invites the accidental run.
