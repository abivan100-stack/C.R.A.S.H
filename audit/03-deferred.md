# Phase 3 — Deferred items

Everything here was found, understood, and deliberately **not** fixed. Each entry
says why, and what it would take. An honest deferral is worth more than a
plausible-looking fix.

---

## A. Deferred by your explicit decision

### F006 — `/health` pings MongoDB and is Render's `healthCheckPath`

**Severity: critical.** `render.yaml` sets `healthCheckPath: /health`, and
`/health` returns 503 when MongoDB is unreachable. So an Atlas outage, or a
free-tier database pause, makes Render mark the entire service unhealthy — taking
down the map, analytics, comparison and simulation, none of which touch the
database.

You reviewed this and chose to leave `/health` exactly as it is, so its response
contract is unchanged. Two things were done instead of a fix:

- A comment in `render.yaml` states the liability at the exact line that causes
  it, so anyone debugging a dark demo finds the reason in seconds.
- `tests/backend/test_startup_resilience.py::test_health_semantics_are_unchanged`
  pins the current behaviour so it cannot drift by accident.

**If you change your mind**, the fix is ~10 lines: return 200 from `/health` when
the process is alive (with the DB state in the body) and move the DB check to
`/health/db`. **Operationally: if the site goes dark, check Atlas first.**

### CI — no GitHub Actions workflow

You chose local `npm test` over CI. The gate exists and is one command; nothing
enforces it on push. If you want it later it is a ~20-line workflow running
`node --test`, `pytest` and `ruff`.

---

## B. Requires action only you can take

### F028 — the MapTiler key is public

`maptiler.js:10` holds a live key, committed to a public repo. **This cannot be
fixed in code.** The browser fetches tiles directly from `api.maptiler.com`, so
the key is delivered to every visitor and is visible in DevTools regardless of
where it is stored — moving it to an env var or the server would only make it
look protected.

**What you need to do:** in your MapTiler account, restrict the key to your
Render domain plus `http://localhost:8000`, and rotate it, since it has been
readable in git history since it was committed. The file now documents this at
the key itself.

---

## C. Deferred on cost/benefit

### F029 — Render free-tier cold starts

The free plan spins down after ~15 minutes idle; the next request waits 30–60s.
This is a plan change, not a code change. Documented in the README runbook:
**load the site a few minutes before demoing.** The boot-resilience fix means the
map now paints from static data rather than waiting on the backend, so a cold
instance no longer blanks the map — it only delays citizen reports.

### F045 / F046 / F047 — the data-generation scripts

`data/_generate_final.py` and `scripts/snap_to_roads.py` write the committed
1.8 MB dataset in place, non-atomically, with CWD-relative paths, and re-running
the generator alone silently destroys the road-snapped coordinates (verified:
regenerating reproduces `accidents.backup.json`, which differs from the live file
in lat/lng for 10,143 of 10,169 records).

**Not fixed because the risk of touching them exceeds the risk of leaving them.**
They are offline, run-by-hand tooling that nobody executes during normal work;
any change invites an accidental run that rewrites the dataset the whole app
depends on, days before a competition. The two-step pipeline
(generate → snap) is now documented in the README so the trap is visible.

If you do want them hardened later: write to a temp file and `os.replace()`,
resolve paths from `__file__`, and re-read + assert the record count after
writing.

### B023 — late-binding closure in `scripts/snap_to_roads.py:158`

A genuine bug: `pct = lambda t, tl: ...` captures the loop variable `n`, so the
printed percentage uses the last file's record count. It affects a **printed
summary statistic only** — never the output data. Silenced in `pyproject.toml`
with a comment pointing here, because fixing it means running the snapper, which
rewrites the dataset (see above).

### Google Fonts remain external

Every other subresource is now vendored. Fonts are left on
`fonts.googleapis.com` because they degrade gracefully — the CSS declares
fallback stacks, so a failure costs typography, not functionality. Unlike
Leaflet, whose absence killed every map.

Related, not fixed: `index.html` loads Newsreader + Roboto while `analytics.html`
and `compare.html` load Space Grotesk + IBM Plex Sans. That contradicts
`DESIGN_LANGUAGE.md`, which specifies Newsreader/Roboto/IBM Plex Mono. It is a
visual inconsistency across pages, not a defect, and changing type on three pages
days before a demo is the wrong trade.

---

## D. Low-severity findings not individually fixed

Of 260 findings, 138 were low severity. The ones fixed were those that fell
inside a file a higher-severity fix already touched. The rest are recorded in
`audit/01-findings.md` and left alone deliberately: churning twelve files for
cosmetics works directly against the demo stability `CLAUDE.md` asks for.

Themes, so you can judge for yourself:

- **Style and modernisation nits in the two offline Python scripts** (~33
  findings). Scoped out in `pyproject.toml` with reasons.
- **Chart.js tooltip/label polish** in `analytics.js` and `compare.js` — Pareto
  accent set differs from the leverage headline set, axis label wording.
- **`dashboard.html` is missing six element IDs `app.js` looks for** (Source
  filter, hospitals layer, citizen counter). They fail silently, so that page
  quietly lacks three controls the SPA has. Worth a look if you demo
  `dashboard.html` rather than `index.html` — **verify which page you present.**
- **`report.js` PDF details** — the emerging table mixes a 6-month count with an
  18-month-normalised lift, printing e.g. "15 recent, 10 prior, +350%".
- **Accessibility** — some interactive controls lack labels; buttons without an
  explicit `type`.
- **`app.js` carries a private duplicate of `CE.computeEmerging`** that analytics
  and report use from the shared module. A refactor risk, not a live bug — but
  it is exactly the shape of the regression that commit `3bea82b` already had to
  fix once.

---

## E. Findings that turned out not to be real

Recorded so nobody re-investigates them.

- **F036's reported mechanism was wrong.** "One old-dated report empties the
  Emerging tab" does not reproduce — `computeEmerging` is robust to it (lift
  stays 42.8, the cell is still detected). The underlying defect was real but
  landed on the per-month KPI instead, and was fixed there.
- **HEAD was reported as covered** on the old `/backend/` block route. It was
  not: `HEAD /backend/.env.example` returned 200, because FastAPI's `APIRoute`
  does not add HEAD the way Starlette's `Route` does. Now moot — the block route
  is gone, replaced by an allowlist.
- **Bot vocabularies were suspected of drifting** from the dataset. They match
  exactly: 30 areas, 11 causes, 8 vehicles, zero mismatches in either direction.
  A test now enforces it.
- **The `.backup.json` files were suspected of being stale duplicates.** They are
  the snapper's genuine pre-snap input; the diff set is exactly `{lat, lng}` with
  ids and order preserved. They should stay.

---

## F. Not verified, and you should check

**The frontend was never opened in a browser during this audit.** Chrome in this
environment could not reach the local dev server — the extension errored while
`curl` returned 200 for `/index.html`, `/app.js` and `/vendor/leaflet/leaflet.js`.

Everything was verified by test suites, static analysis and direct execution of
the engines in Node, which is why the numbers and the security fixes are
trustworthy. But **no one has looked at the rendered page.** Before the
competition, open the app and click through:

1. Map loads, blooms render, the ranked rail is populated.
2. Open a zone dossier — check the "≈ N preventable" figures look sane.
3. Analytics tab — the "Emerging hotspots" KPI should no longer read exactly 6.
4. File a test report — confirm it appears and the copy about sharing is right.
5. Bot tab — open it **immediately** on page load, before the data finishes
   loading, to exercise the F039 retry.
6. Toggle the theme and apply several filters, then check the map still feels
   responsive (the canvas-leak fix).
