# Audit — data layer and offline data-generation scripts

Scope: `data/_generate_final.py`, `scripts/snap_to_roads.py`, `data/accidents.json`,
`data/accidents.backup.json`, `data/citizen_seed.json`, `data/citizen_seed.backup.json`,
cross-checked against `backend/main.py:313-331` (`BOT_AREAS` / `BOT_CAUSES` / `BOT_VEHICLES`)
and `shared/constants.js:39-51`.

**Headline: the data files themselves are clean.** 10,169 accident records, zero duplicate
ids, zero schema violations, zero out-of-box coordinates, zero unparseable dates, and the
`cause` / `vehicle` / `area` vocabularies match `backend/main.py` and `shared/constants.js`
**exactly, with no mismatches in either direction**. Every defect below is in the scripts,
the docs, or the file-hygiene around the data — not in the record contents.

## Findings

| # | File:lines | Defect | Failure scenario | Severity | Confidence | Proposed fix |
|---|---|---|---|---|---|---|
| 1 | `data/_generate_final.py:189-190` + `scripts/snap_to_roads.py:151-152` | Re-running the generator **silently destroys the road-snapped coordinates**. Measured: regenerating reproduces `accidents.backup.json` exactly, but differs from the live `accidents.json` in `lat`/`lng` for 10,143 of 10,169 records. Nothing in either script, in `CLAUDE.md`, or in a README states that `_generate_final.py` must always be followed by `snap_to_roads.py`. | Anyone tweaks `COUNT_SCALE` or an area row, runs the generator, commits — and every accident point jumps back off the road network onto buildings, parks and water. The demo map degrades and nobody knows why. | High | High | Add a one-line pipeline note at the top of both scripts, and make `_generate_final.py` write `accidents.backup.json` (the pre-snap original) rather than `accidents.json`, so the snapper's own input is the generator's output. |
| 2 | `data/_generate_final.py:189` | Output path `open("accidents.json", "w")` is **relative to the current working directory**, not to the script. Verified: executing the module from a scratch dir wrote `accidents.json` into that scratch dir, leaving `data/accidents.json` untouched. Contrast `scripts/snap_to_roads.py:35-37`, which correctly derives paths from `__file__`. | Run `python data/_generate_final.py` from the repo root and it writes `./accidents.json` at the root. The console prints a perfect-looking report, the real dataset is unchanged, and the stray file gets committed. | High | High | `OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "accidents.json")`. |
| 3 | `data/_generate_final.py:171-190`; `scripts/snap_to_roads.py:151-152` | **Non-atomic, un-backed-up in-place writes of committed data.** Both scripts `open(path, "w")` then `json.dump` straight into a 1.8 MB tracked file. A `KeyboardInterrupt`, disk-full, or exception mid-dump leaves `data/accidents.json` truncated and unparseable. The generator additionally takes no backup at all before clobbering. | Ctrl-C during a regen the night before the demo → `accidents.json` is half-written JSON → every page fails at `fetch('./data/accidents.json')` (`app.js:1676`, `analytics.js:437`, `compare.js:397`, `index.html:1411`) and the whole app is blank until someone `git checkout`s the file. | High | High | Write to `path + ".tmp"` then `os.replace(tmp, path)` in both scripts. |
| 4 | `CLAUDE.md:47-49` vs `data/_generate_final.py:172-182` | **The documented correlation "night and rain increase severity" is not implemented and is not present in the data.** Severity is fixed per area by the `f/s/l` columns (line 174) and is chosen *before* time and weather; only `cause` and `vehicle` are conditioned on severity. Measured fatal share: night 6.2% vs day 6.3%; rain 6.5% vs clear 6.2%; **fog 5.9% (lower than clear)**. | A judge asks the bot "are night crashes more deadly in your data?" The bot reads the digest and correctly answers "no difference", contradicting the team's own pitch and the README's realism claims. | High | High | Either implement it (multiply the fatal/serious split by a night/rain factor before the severity loop) or delete the claim from `CLAUDE.md` and `README.md`. Deleting is the demo-safe option this close to the competition. |
| 5 | `app.js:1690`, `analytics.js:448` | **Stale cache-buster on `citizen_seed.json`.** It is fetched as `?v=1`, introduced in commit `e691243`; the file's *contents* have changed twice since (`307687f`, `bc679e6` — the road-snapping commits), and both files' coordinates now differ from the backups in all 300 records. `accidents.json` was correctly bumped to `?v=9`. | A returning visitor's browser (or Render's CDN) serves the cached pre-snap `citizen_seed.json` while serving the new `accidents.json`. Citizen markers sit off-road while official ones sit on-road, in the same view. | Medium | High | Bump to `?v=2` in both files. |
| 6 | `scripts/snap_to_roads.py:50` vs `:137-138` | The comment calls `SEARCH_R = 300.0` a "**hard cap** — a point never moves farther than this", but the `else` branch at line 138 falls back to the globally-nearest edge with no distance limit. Measured: `citizen_seed` record `cs104` (Adyar) moved **411.1 m**, from `13.002858,80.239257` to `13.003854,80.242911`. | A point silently relocates 400 m into a different junction's catchment. In `citizen_seed` this is one record; on a re-run against a sparser graph it could be many, quietly shifting which cell the hotspot engine ranks. | Medium | High | Either honour the cap (leave the point unmoved when no road is within `SEARCH_R`) or fix the comment and log every over-cap move. |
| 7 | `scripts/snap_to_roads.py:74-84` | `load_original()` treats *whatever is currently on disk* as "the true original" whenever the backup is absent, and copies it to `*.backup.json`. The backups are the script's only recovery path and there is no marker distinguishing snapped from unsnapped data. | Someone deletes the (1.9 MB) backups to slim the repo, or clones a fork where they were gitignored, then runs the script. It snaps already-snapped data, writes a *snapped* file as the new "original", and the pristine generator output is unrecoverable. Repeated runs compound the displacement. | Medium | High | Refuse to run when the backup is missing (`sys.exit` with instructions to regenerate), or stamp a `"_snapped": true` sentinel and bail if it is already present. |
| 8 | `backend/requirements.txt` (whole file) vs `scripts/snap_to_roads.py:24-33` | **Undeclared, unpinned dependencies.** The snapper imports `numpy`, `osmnx`, `shapely` (needs 2.x — `STRtree.query` returns *indices* in 2.x and *geometries* in 1.8, and line 130 indexes into `geoms`), `pyproj`, plus `networkx` transitively. None appear in `backend/requirements.txt`, and there is no `scripts/requirements.txt`. | A teammate tries to re-snap on a fresh machine: either `ModuleNotFoundError`, or — worse — an old shapely silently makes `cand` a list of geometries and `weights[cand]` raises deep inside the loop. | Medium | High | Add `scripts/requirements.txt` with pinned `osmnx`, `shapely>=2`, `numpy`, `pyproj`. Keep it out of `backend/requirements.txt` so Render never installs the heavy geo stack. |
| 9 | `scripts/snap_to_roads.py:90-97` + `.gitignore:22-25` | **Not reproducible over time.** The docstring promises "same input always yields the same output", but that only holds while the local `chennai_drive.graphml` cache survives — and it is deliberately gitignored. On a fresh clone the graph is re-downloaded from live OSM, which changes continuously, so the same input yields different coordinates. | Six months from now someone re-snaps for a v2 dataset and gets a different map from the one in the presentation PDFs, with no way to reproduce the original. | Medium | High | Either commit the `.graphml` (it is a one-time artefact) or record the OSM extract date + `osmnx` version in a small `scripts/SNAP_PROVENANCE.txt`, and soften the docstring claim. |
| 10 | `scripts/snap_to_roads.py:90-97` | **Unbounded network call with no timeout, retry, or error handling.** `ox.graph_from_bbox` is called once, bare; `ox.settings.requests_timeout` is never set (relies on the osmnx default), there is no retry, and `main()` has no `try/except`. The Overpass API routinely returns 429/504 for a bbox this size. | The first run behind the school/office network hangs or dies with a raw traceback partway through. If it dies *after* `load_original` created the backups but before the writes, the state is confusing though not corrupt. | Medium | High | Set `ox.settings.requests_timeout = 300`, wrap the download in a 3-attempt retry with backoff, and wrap `main()` in `try/except` with a readable message. |
| 11 | `data/citizen_seed.json` (all 300 records) vs `CLAUDE.md:88-89` | **The citizen-seed schema does not match either documented model.** Measured keys: `id, lat, lng, severity, datetime, weather, cause, vehicle, area, citizen, seed` — two undocumented fields (`citizen: true`, `seed: true`, constant across all 300), `id` is a **string** (`"cs1"`…) not a number, and there is **no `created_at`**, which the documented MongoDB citizen-report model requires. | Any code that sorts or compares report ids numerically, or reads `created_at` for the notification feed, gets `NaN`/`undefined` for seeded reports. `app.js:1801,1807` currently paper over this by re-stamping the flags at load time. | Medium | High | Document the seed schema in `CLAUDE.md` as its own third model, or add `created_at` and drop the two flags from the file (they are set in code anyway). |
| 12 | `data/accidents.json` (post-snap coordinates) | **Marker pile-ups introduced by snapping.** Distinct coordinates fell from 10,168/10,169 pre-snap to **9,500/10,169** post-snap. Worst offenders: **88 records on the single point `12.943137,80.232703` (Thoraipakkam)**, 21 at `12.941598,80.232741`, 17 at `13.114014,80.154433` (Ambattur). 329 records sit on a coordinate shared by 5+ others. | 88 markers stack on one pixel: the top one is clickable, the other 87 are invisible. A judge clicking Thoraipakkam sees one incident where the analytics panel claims 349. | Medium | High | Add a tiny deterministic jitter *along the snapped edge* (a few metres of `g.interpolate` offset per duplicate) so points spread down the road instead of collapsing onto one node. |
| 13 | `data/accidents.backup.json` (1.79 MB), `data/citizen_seed.backup.json` (61 KB) | Both backups **are tracked in git and are served publicly**: `backend/main.py:505` mounts the whole project root via `StaticFiles(directory=FRONTEND_DIR)`, so `https://<host>/data/accidents.backup.json` is downloadable. They are *not* stale garbage — they are the snapper's genuine pre-snap input, differing from the live files only in `lat`/`lng` (verified: field-diff set is exactly `{lat, lng}`, record order and ids preserved) — but nothing on disk says so. | ~1.9 MB of near-duplicate data in every clone and every deploy; a judge or reviewer poking at the URL finds a second, subtly different dataset and asks which one is real. | Low | High | Keep them (the snapper needs them) but move to `data/originals/` with a two-line `README` explaining the pipeline, and exclude that folder from the static mount. |
| 14 | `data/_generate_final.py:24` | Stale comment: "Base counts sum to 7291". **Measured base sum is 7,422.** | Someone recomputes `COUNT_SCALE` from the stale figure and lands on the wrong total. | Low | High | Update the number, or compute it at runtime. |
| 15 | `data/_generate_final.py:3` | Docstring says "~29 real Chennai junctions/areas". **`AREAS` has exactly 30 entries** (measured), matching the 30 in `BOT_AREAS`. | Trivial, but it is the kind of number a judge checks against the slide deck. | Low | High | Say "30". |
| 16 | `CLAUDE.md:44` vs `data/_generate_final.py:20` | `CLAUDE.md` documents `random.seed(42)`; the script actually uses **`random.seed(131313)`**. The script *is* fully deterministic — re-running it reproduced `accidents.backup.json` exactly — so this is purely a doc error. | Anyone trying to reproduce the dataset from the docs gets a completely different 10,169 records. | Low | High | Correct `CLAUDE.md` to `131313`. |
| 17 | `CLAUDE.md:40-43` and `README.md:194` vs measured data | Doc drift on the dataset description: docs say "~10,000 records" (actual **10,169**) and "15+ real Chennai junctions" (actual **30 areas**), and name **Kathipara** and **Anna Salai** as anchor junctions — **neither exists as an `area` value** in the dataset (Kathipara is folded into `Guindy`). | A judge filters for "Anna Salai" in the bot or the area dropdown and gets nothing, having just been told it is one of the anchor junctions. | Low | High | Update both docs to "10,169 records across 30 areas" and drop or re-label Kathipara / Anna Salai. |
| 18 | `data/citizen_seed.json` (area distribution) | `Kattankulathur` is the **only** one of the 30 `BOT_AREAS` with no citizen-seed record (29 of 30 areas covered). Not a vocabulary mismatch — the value is valid and present in `accidents.json` (180 records) — just uneven seeding. | "Show me citizen reports in Kattankulathur" returns empty while every other area returns something. Minor inconsistency in a live demo. | Low | Medium | Add 2-3 seed records for Kattankulathur, or leave it and be ready to explain it. |
| 19 | `data/accidents.json` `datetime` (all 10,169) | Datetimes use the **space-separated, second-less, timezone-less** shape `####-##-## ##:##` (e.g. `"2024-07-01 08:00"`). `Date.parse` on a non-ISO string is implementation-defined per ECMA-262; V8 and current Safari accept it, older Safari/JSC returns `NaN`. It also parses as *local* time, so the same record shifts date across timezones. | On an older iPad in the judging room, every chart that goes through `new Date(r.datetime)` yields `Invalid Date` and the analytics page renders empty. Currently works everywhere tested. | Low | Medium | Emit `"2024-07-01T08:00"` from the generator (one character), or keep the string slicing the code already uses (`r.datetime.slice(0,10)`) and never hand the raw string to `Date`. |
| 20 | `shared/constants.js:34-51` | `shared/constants.js` defines `CAUSES` and `VEHICLES` but has **no `AREAS` array**; the 30-area vocabulary exists only in `backend/main.py:313-319`. The two vocabularies that *are* duplicated (`CAUSES`, `VEHICLES`) are hand-maintained copies in three places — the generator (`_generate_final.py:32-36`), the backend, and `shared/constants.js`. All three currently agree exactly. | Add a 31st area or a 12th cause and the copies drift silently; the bot then rejects a filter for a value that exists in the data. | Low | High | Add `AREAS` to `shared/constants.js` and have `backend/main.py` read all three vocabularies from a single small JSON file (or at minimum add a cross-reference comment in each of the three locations). |
| 21 | `data/_generate_final.py:189-228` | No `if __name__ == "__main__":` guard, and `from collections import Counter, defaultdict` sits mid-file at line 193. Importing the module for inspection executes the full generation *and the file write* as a side effect. | Exactly the trap this audit hit: importing the module to count `AREAS` wrote an `accidents.json` into the working directory. | Low | High | Wrap generation + reporting in `main()` behind the guard; move the import to the top. |
| 22 | `data/_generate_final.py:189` | `open(..., "w")` with no `encoding=`. On Windows this is cp1252. Currently safe only because `json.dump` defaults to `ensure_ascii=True`. | Someone adds `ensure_ascii=False` for readability and a non-ASCII area name silently mangles or raises `UnicodeEncodeError`. | Low | Medium | `encoding="utf-8"`. |
| 23 | `data/_generate_final.py:176-180` | The night/day split is decided twice: `rand_dt` picks the hour from a night or day pool based on `night_frac` (lines 117-121), then line 178 *re-derives* `is_night` from the resulting hour string. Correct today only because the two pools happen to partition exactly at 06:00/18:00. | Widen the "night" pool to 17:00 and the cause weighting silently desynchronises from the intent, with no test to catch it. | Low | High | Have `rand_dt` return `(dt_string, is_night)` and use it directly. |
| 24 | `data/_generate_final.py:91-96` | `sample()`'s fallback after 25 rejected draws returns the bbox-clamped area **centre** — an exact, repeatable coordinate rather than a sample. Never fires today (sigmas are 0.00065/0.0026 and every centre is well inside the box). | Move an area near the bbox edge or widen a sigma and that area quietly grows a pile of identical points at its centre. | Low | Medium | Fall back to a truncated resample or raise, rather than returning the centre. |
| 25 | `.gitignore:6-16` vs `:27-31` | Duplicate entries: `venv/`, `__pycache__/`, `*.pyc`, `.env` are each listed twice, in two separate blocks with different comments. Harmless, but suggests two ignore files were merged without review. | None functionally. Noise. | Low | High | Delete the second block. |
| 26 | `scripts/snap_to_roads.py:130,133` | Per-point `pt.buffer(SEARCH_R)` builds a 300 m polygon for each of 10,469 points, and line 133 computes distances in a Python list comprehension. Works, but is the reason a re-snap takes minutes. | None correctness-wise; just slow enough that people avoid re-running it. | Low | High | `tree.query(pt, predicate="dwithin", distance=SEARCH_R)` (shapely 2.0+) and vectorised `shapely.distance`. |
| 27 | `data/_generate_final.py`, `scripts/snap_to_roads.py` | Neither script has any `try/except`, any input validation, or any post-write verification that the file it just wrote re-parses and still has the expected record count. | Silent partial success. Nothing fails loudly. | Low | High | After each write, re-read and assert `len(json.load(...)) == expected`. |

**Checked and clean — no defect found:** no hardcoded API keys, credentials, or hardcoded
service endpoints in either script (`ANTHROPIC_API_KEY` is env-only at `backend/main.py:309`);
no machine-specific absolute paths in `snap_to_roads.py` (it correctly derives everything from
`__file__` at lines 35-37); `snap_to_roads.py` is genuinely idempotent when its backups are
present (it always snaps *from* the backup, so re-running is a no-op); `_generate_final.py` is
genuinely deterministic (a re-run byte-for-byte reproduced `accidents.backup.json`); and
`snap_to_roads.py` preserves record order, ids, and every non-coordinate field exactly.

---

## Validation commands and raw output

All commands run from `C:\Users\user\Documents\abivan-works\C.R.A.S.H`.

### A. Full schema / vocabulary / range sweep of all four JSON files

Script: a Node validator walking every record and checking key set, id uniqueness, enum
membership, coordinate bounds, and `Date.parse`.

```
node validate.js     # per file: count, dupIds, missingKeys, extraKeys, enums, ranges
```

Key output:

```
accidents.json         count 10169   dupIds []   missingKeys []   extraKeys []
  severities  fatal 637 | serious 3256 | slight 6276          badSev 0
  weathers    clear 6815 | fog 478 | rain 2876                badWx  0
  causes      11 distinct   vehicles 8 distinct   areas 30 distinct
  ids         1..10169, all numeric, zero duplicates
  nullLL 0    outOfBox 0
  latRange [12.821448, 13.125272]   lngRange [80.042446, 80.275041]
  badDateCount 0   dateRange ["2024-07-01 08:00", "2026-06-30 19:39"]

accidents.backup.json  count 10169   (identical schema/enum/count profile)
  latRange [12.821555, 13.125088]   lngRange [80.042423, 80.275179]

citizen_seed.json      count 300     dupIds []   missingKeys []
  extraKeys   citizen(300), seed(300)      badIdTypeCount 300  (ids are strings)
  severities  fatal 12 | serious 90 | slight 198             badSev 0
  weathers    clear 201 | fog 20 | rain 79                   badWx  0
  areas       29 distinct
  nullLL 0    outOfBox 0
  badDateCount 0   dateRange ["2024-07-02 01:55", "2026-06-29 08:43"]

citizen_seed.backup.json  count 300  (identical schema/enum/count profile)
```

Documented field set `id, lat, lng, severity, datetime, weather, cause, vehicle, area`:
**present on all 10,169 accident records with zero extra and zero missing keys.** The
citizen-seed files carry two extra keys (`citizen`, `seed`) — finding #11.

Bounding box `lat 12.6-13.4, lng 79.9-80.4`: **zero violations across all four files.**
Date range: **exactly Jul 2024 - Jun 2026**, all 24 months present, no gaps, zero records
dated after today (2026-08-05), zero `Date.parse` failures.

### B. Vocabulary cross-check vs `backend/main.py:313-328` and `shared/constants.js:39-47`

```
== VOCAB CROSS-CHECK ==
areas in accidents.json: 30 | in citizen_seed.json: 29 | BOT_AREAS: 30
data area NOT in BOT_AREAS : []
BOT_AREAS NOT in accidents : []
BOT_AREAS NOT in citizen   : [ 'Kattankulathur' ]
cause  data-not-in-BOT: [] | BOT-not-in-data: []
veh    data-not-in-BOT: [] | BOT-not-in-data: []
```

`shared/constants.js` `CAUSES` (11) and `VEHICLES` (8) are string-for-string identical to
`BOT_CAUSES` / `BOT_VEHICLES` and to `CAUSES` / `VEHICLES` in `_generate_final.py:32-36`.
`shared/constants.js` has **no `AREAS` array** (finding #20).
`shared/constants.js:50` `BBOX {12.80, 13.22, 80.03, 80.32}` matches
`_generate_final.py:27-28` `LAT_MIN/LAT_MAX/LNG_MIN/LNG_MAX` exactly, and all measured
coordinates fall inside it.

**Net vocabulary mismatches: one — `Kattankulathur` absent from `citizen_seed.json` only.**

### C. Backup vs live diff

```
== BACKUP vs LIVE ==
accidents.json: records differing=10143/10169, identical=26, coords unchanged=26
  fields that differ: [lat, lng] | max coord delta 297 m | id order preserved: true
  byte-identical files: false
citizen_seed.json: records differing=300/300, identical=0, coords unchanged=0
  fields that differ: [lat, lng] | max coord delta 406 m | id order preserved: true
  byte-identical files: false
```

Conclusion: the `.backup.json` files are **not stale duplicates** — they are the genuine
pre-snap originals and the snapper's required input (`snap_to_roads.py:77-84`). They should
stay in the repo but be relocated and labelled (finding #13).

### D. Snap displacement (haversine, live vs backup)

```
accidents.json  | snap dist mean 34.6  median 18.5  max 299.7 m | moved >300m: 0 | >500m: 0
citizen_seed.json | snap dist mean 49.2 median 21.6 max 411.1 m | moved >300m: 1 | >500m: 0

citizen_seed farthest snaps:
  cs104  Adyar          411.1 m   13.002858,80.239257 -> 13.003854,80.242911
  cs249  Thoraipakkam   283.5 m
  cs54   Adyar          264.9 m
```

`cs104` exceeds the `SEARCH_R = 300.0` "hard cap" asserted at `snap_to_roads.py:50` —
finding #6, produced by the unbounded fallback at line 138.

### E. Post-snap coordinate collisions

```
== COORD COLLISIONS (post-snap) ==
distinct coords: 9500 of 10169 records
top-5 stacked points: [ ['12.943137,80.232703', 88], ['12.941598,80.232741', 21],
                        ['13.114014,80.154433', 17], ['12.943391,80.233255', 14],
                        ['13.006599,80.241352', 14] ]
distinct coords in backup (pre-snap): 10168
stacked 88 records at 12.943137,80.232703 area Thoraipakkam
stacked 21 records at 12.941598,80.232741 area Thoraipakkam
stacked 17 records at 13.114014,80.154433 area Ambattur
records sharing a coord with >=5 others: 329
```

Finding #12.

### F. Generator determinism, area count, base sum, and output path

Ran `data/_generate_final.py` via `importlib` from a scratch directory
(Python 3.12.7 at `C:\Users\user\AppData\Local\Programs\Python\Python312\python.exe`):

```
AREAS count: 30 (docstring says '~29 real Chennai junctions/areas')
base severity sum: 7422 (line 24 comment claims 7291)
generated records: 10169
wrote file to CWD: ...\scratchpad\accidents.json  exists: True     <-- finding #2
regen == committed backup (full)      : True                        <-- deterministic
regen == committed backup (no coords) : True
regen == live accidents.json (full)   : False                       <-- finding #1
regen == live accidents.json (nocoord): True

--- generator stdout ---
total: 10169 | areas: 30 | COUNT_SCALE: 1.37
causes: 11 min: ('Vehicle defect', 350)
top cause: ('Over-speeding', 2561) | top vehicle: ('Two-wheeler', 4248)
severity: {'slight': 6276, 'serious': 3256, 'fatal': 637}
realism checks: hit-and-run at night: 61% vs 51%
```

The generator is **fully reproducible** (`random.seed(131313)`, `_generate_final.py:20`) and
its output is exactly `accidents.backup.json`. But it also wrote a stray `accidents.json`
into the scratch directory purely as an import side effect — findings #2 and #21.

### G. Documented correlations, measured

```
CLAUDE.md claim: "night and rain increase severity"
  fatal share  night: 6.2% (n=5190)   day:   6.3% (n=4979)
  fatal share  rain : 6.5% (n=2876)   clear: 6.2% (n=6815)
  fatal share  fog  : 5.9% (n=478)
  fatal+serious night: 38.8%   day:   37.7%
  fatal+serious rain : 39.9%   clear: 37.6%
overall fatal share: 6.3%
two-wheeler share:  41.8%
```

Claims that **hold**: over-speeding is the top cause (2,561 / 25.2%); two-wheelers ~40%
(41.8%); hit-and-run skews night (61% vs 51% baseline); potholes skew rain/fog; lorries skew
fatal. Claim that **fails**: "night and rain increase severity" — flat, and fog is *below*
baseline. Finding #4.

### H. Cache-buster and static-exposure checks

```
$ grep -rn "citizen_seed.json?v=\|accidents.json?v=" --include=*.js --include=*.html .
./analytics.js:437:  fetch('./data/accidents.json?v=9')
./analytics.js:448:  fetch('./data/citizen_seed.json?v=1')
./app.js:1676:       fetch('./data/accidents.json?v=9')
./app.js:1690:       fetch('./data/citizen_seed.json?v=1')
./compare.js:397:    fetch('./data/accidents.json?v=9')
./index.html:1411:   fetch('./data/accidents.json?v=9')

$ git log --oneline -S"citizen_seed.json?v=1" -- app.js analytics.js
e691243 feat: add citizen accident reporting with localStorage persistence ...

$ git log --oneline -- data/citizen_seed.json
bc679e6 fix: bias road-snapping toward highways so major roads carry more crashes
307687f fix: snap all accident points onto real Chennai roads (in-place, all views)
e691243 feat: add citizen accident reporting ...
```

`?v=1` was set in `e691243`; the file changed twice afterwards without a bump — finding #5.

```
$ grep -n "StaticFiles\|FRONTEND_DIR" backend/main.py
42:  FRONTEND_DIR = os.path.dirname(BASE_DIR)      # the site root
505: app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
```

The mount is the project root, so `data/*.backup.json` is publicly reachable — finding #13.

### I. Dependency declaration

```
$ cat backend/requirements.txt
fastapi / uvicorn / pymongo / dnspython / python-dotenv / anthropic / truststore
```

No `osmnx`, `numpy`, `shapely`, or `pyproj` anywhere in the repo, and no
`scripts/requirements.txt` — finding #8.
