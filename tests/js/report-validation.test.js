/* Regression tests for the frontend/backend validation gap.

   POST /report validates area, cause, vehicle, severity AND weather against
   fixed vocabularies. The two frontend validators did not: app.js's
   isValidReport and analytics.js's validReport only checked
   `typeof x === 'string'`, and neither looked at `weather` at all.

   That gap mattered because those validators gate two sources the backend never
   saw — localStorage, and Mongo documents written before the backend validators
   existed — and because the values do not stay inert. area and cause become
   object KEYS in the grid/dossier accumulators, and weather indexes a fixed
   {clear,rain,fog} map. Verified consequences:

     area:"__proto__"   assigning c.areas["__proto__"] is silently ignored, so
                        Object.keys(c.areas) comes back EMPTY and
                        computeHotspots' `Object.entries(...)[0][0]` throws —
                        killing the whole ranking engine.
     weather:"hail"     analytics.js computeAgg does wsev[a.weather][a.severity]++
                        against a 3-key map -> TypeError inside the async boot(),
                        buildAll() never runs, every chart renders blank.
     cause:"<img ...>"  reached the zone dossier's innerHTML unescaped.

   These tests pin the vocabularies to the shipped dataset (which
   tests/backend/test_baseline_contract.py already pins to backend/main.py, so
   the two ends cannot drift apart silently), prove the hostile values are now
   rejected, and prove the crash they used to cause no longer reproduces. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CRASH_CONSTANTS: C } = require('../../shared/constants.js');
const { CRASH_ENGINE: CE } = require('../../shared/engine.js');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const readText = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const DATASET = readJson('data/accidents.json');
const SEED = readJson('data/citizen_seed.json');

/* The tightened validator, mirrored here field for field. The real ones live
   inside app.js / analytics.js, which need `window` + Leaflet + a DOM to load;
   the source-level test at the bottom is what proves those two stay in step. */
function isValidReport(r) {
  return !!(r && typeof r === 'object' &&
    typeof r.lat === 'number' && isFinite(r.lat) &&
    typeof r.lng === 'number' && isFinite(r.lng) &&
    C.isSeverity(r.severity) &&
    typeof r.datetime === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(r.datetime) &&
    C.isCause(r.cause) && C.isVehicle(r.vehicle) &&
    C.isArea(r.area) && C.isWeather(r.weather));
}

const good = (over) => Object.assign({
  lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-01 14:30',
  weather: 'clear', cause: 'Over-speeding', vehicle: 'Car', area: 'Guindy',
}, over || {});

/* --- the vocabularies match the data that ships ---------------------------- */

test('every vocabulary equals the distinct values in the shipped dataset', () => {
  const distinct = (field) => [...new Set(DATASET.map((r) => r[field]))].sort();
  assert.deepEqual(distinct('area'), [...C.AREAS].sort(), 'AREAS drifted from accidents.json');
  assert.deepEqual(distinct('cause'), [...C.CAUSES].sort(), 'CAUSES drifted from accidents.json');
  assert.deepEqual(distinct('vehicle'), [...C.VEHICLES].sort(), 'VEHICLES drifted from accidents.json');
  assert.deepEqual(distinct('weather'), [...C.WEATHERS].sort(), 'WEATHERS drifted from accidents.json');
  assert.deepEqual(distinct('severity'), [...C.SEVERITIES].sort(), 'SEVERITIES drifted from accidents.json');
});

test('the tightened validator accepts every shipped seed report unchanged', () => {
  /* If this fails, the fix is dropping real data rather than hostile data. */
  const rejected = SEED.filter((r) => !isValidReport(r));
  assert.deepEqual(rejected, [], `${rejected.length} of ${SEED.length} seed reports would now be dropped`);
  assert.ok(SEED.length > 0, 'the seed file is empty — this test would pass vacuously');
});

/* --- the hostile values are rejected --------------------------------------- */

test('a vocabulary value that is an Object.prototype member is rejected', () => {
  /* The whole class the old `typeof x === "string"` check waved through. */
  for (const poison of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(isValidReport(good({ area: poison })), false, `area:"${poison}" was accepted`);
    assert.equal(isValidReport(good({ cause: poison })), false, `cause:"${poison}" was accepted`);
    assert.equal(isValidReport(good({ vehicle: poison })), false, `vehicle:"${poison}" was accepted`);
    assert.equal(isValidReport(good({ weather: poison })), false, `weather:"${poison}" was accepted`);
  }
});

test('weather is validated at all — the field the old check never looked at', () => {
  assert.equal(isValidReport(good({ weather: 'hail' })), false, 'unknown weather accepted');
  assert.equal(isValidReport(good({ weather: undefined })), false, 'missing weather accepted');
  assert.equal(isValidReport(good({ weather: '' })), false, 'empty weather accepted');
  for (const w of C.WEATHERS) assert.equal(isValidReport(good({ weather: w })), true, `${w} rejected`);
});

test('an HTML payload in a vocabulary field is rejected before it reaches a sink', () => {
  const payload = '<img src=x onerror=alert(1)>';
  for (const field of ['area', 'cause', 'vehicle', 'weather']) {
    assert.equal(isValidReport(good({ [field]: payload })), false, `${field} accepted a script payload`);
  }
});

test('NaN coordinates are rejected — they pass typeof === "number"', () => {
  assert.equal(isValidReport(good({ lat: NaN })), false);
  assert.equal(isValidReport(good({ lng: Infinity })), false);
});

/* --- the downstream crashes no longer reproduce ---------------------------- */

test('area:"__proto__" no longer reaches the top-area lookup that threw', () => {
  /* Reproduces computeHotspots' finalize step in app.js. Before the fix this
     record passed validation, produced a cell whose .areas had no own keys, and
     `Object.entries(c.areas).sort(...)[0][0]` threw a TypeError. */
  const hostile = good({ area: '__proto__' });
  assert.equal(isValidReport(hostile), false, 'the record must never reach the engine');

  const accepted = [hostile, good()].filter(isValidReport);
  CE.precompute(accepted, C.MAX_WINDOW_MONTHS);
  const cells = CE.gridCells(accepted, C.BBOX, C.CELL, C.RECENT_MONTHS, 24, (s) => C.sevOf(s).weight);
  for (const cell of cells) {
    assert.ok(Object.keys(cell.areas).length > 0, 'a cell reached the engine with no own area key');
    assert.doesNotThrow(() => Object.entries(cell.areas).sort((a, b) => b[1] - a[1])[0][0]);
  }
});

test('an unknown weather no longer reaches the fixed {clear,rain,fog} accumulator', () => {
  /* Reproduces analytics.js computeAgg's inner loop, which blanked the page. */
  const accepted = [good({ weather: 'hail' }), good({ weather: undefined }), good()].filter(isValidReport);
  assert.equal(accepted.length, 1, 'only the well-formed record should survive');

  const wsev = { clear: {}, rain: {}, fog: {} };
  for (const w of C.WEATHERS) for (const s of C.SEVERITIES) wsev[w][s] = 0;
  assert.doesNotThrow(() => {
    for (const a of accepted) wsev[a.weather][a.severity]++;
  }, 'computeAgg would still throw and blank the analytics page');
  assert.equal(wsev.clear.fatal, 1);
});

/* --- both real validators stay in step ------------------------------------- */

test('app.js and analytics.js both check all four vocabularies', () => {
  /* The two validators are deliberate duplicates (analytics.html runs standalone),
     so this is what stops one being tightened and the other forgotten. */
  const CHECKS = ['isCause', 'isVehicle', 'isArea', 'isWeather'];
  for (const [file, fn] of [['app.js', 'isValidReport'], ['analytics.js', 'validReport']]) {
    const lines = readText(file).split('\n');
    const start = lines.findIndex((l) => l.includes('function ' + fn + '('));
    assert.notEqual(start, -1, `${fn} not found in ${file}`);
    /* Take whole lines until the first that is only a closing brace. Brace-counting
       or indexOf('}') both trip over the `{4}` quantifier in the datetime regex. */
    let end = start;
    while (end < lines.length && !/^\s*\}\s*$/.test(lines[end])) end++;
    const body = lines.slice(start, end + 1).join('\n');
    assert.ok(body.includes('r.datetime'), `extracted an incomplete body for ${fn} in ${file}`);
    for (const check of CHECKS) {
      assert.match(body, new RegExp('\\b' + check + '\\('), `${file} ${fn}() does not call ${check}()`);
    }
    assert.match(body, /\bisSeverity\(/, `${file} ${fn}() does not call isSeverity()`);
    assert.doesNotMatch(body, /typeof\s+r\.(area|cause|vehicle|weather)\s*===?\s*'string'/,
      `${file} ${fn}() still type-checks a vocabulary field instead of validating it`);
  }
});
