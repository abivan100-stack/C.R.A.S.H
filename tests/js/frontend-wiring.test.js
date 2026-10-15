/* Source-level regression tests for frontend wiring that a browser-only file
   cannot be unit-tested on directly (app.js, report.js need window + Leaflet +
   jsPDF). They assert the property that actually broke, the way the xss-sinks and
   poll-backoff suites do. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* --- app.js ------------------------------------------------------------------- */

test('the Emerging dossier headline counts every qualifying cell, not the top-6 list', () => {
  const src = read('app.js');
  assert.match(src, /list\.qualifyingCount != null \? list\.qualifyingCount : list\.length/,
    'the Emerging headline is back to list.length, structurally capped at EMERGE_TOP_N (6)');
});

test('the City dossier treats a Source filter as active', () => {
  /* currentRecords() returns the citizen/official subset under a Source filter, so the
     count is filtered — but the label said "all data" because anyFilter omitted source. */
  const src = read('app.js');
  const line = src.split('\n').find((l) => l.includes('const anyFilter ='));
  assert.ok(line, 'anyFilter not found');
  const body = src.split('const anyFilter =')[1].split(';')[0];
  assert.match(body, /app\.filters\.source !== 'all'/, `anyFilter omits the Source filter: ${line.trim()}`);
});

test('selectHotspot resolves against the full-data cells as well as the filtered set', () => {
  /* Under an active filter an Emerging/Strategy row's cell may be absent from the
     filtered set; the dossier updated but the map never panned (dead-button feel). */
  const src = read('app.js');
  assert.match(src, /const h = app\.cellById\[id\] \|\| app\.cellByIdFull\[id\]/,
    'selectHotspot no longer falls back to cellByIdFull — the map will not pan under a filter');
});

/* --- report.js ---------------------------------------------------------------- */

test('the city PDF uses the anchored month count, not the raw date span', () => {
  /* precompute() anchors the window to the newest record and clamps to
     MAX_WINDOW_MONTHS; monthMeta() reports the raw oldest->newest span. Passing the
     latter to gridCells/computeEmerging indexed a field the records never had a
     length for — a stray old report emptied the Emerging table and skewed "Per month". */
  const src = read('report.js');
  assert.doesNotMatch(src, /CE\.gridCells\(records, BBOX, CELL, RECENT_MONTHS, mm\.count/,
    'report.js passes monthMeta().count to gridCells again (the F036 defect)');
  assert.doesNotMatch(src, /computeEmerging\(cells, RECENT_MONTHS, mm\.count/,
    'report.js passes monthMeta().count to computeEmerging again');
  assert.match(src, /const pre = CE\.precompute\(/, 'the precompute() result is not captured');
  assert.match(src, /CE\.gridCells\(records, BBOX, CELL, RECENT_MONTHS, pre\.monthCount/);
  assert.match(src, /computeEmerging\(cells, RECENT_MONTHS, pre\.monthCount/);
  assert.match(src, /Math\.round\(d\.total \/ d\.monthCount\)/,
    'the "Per month" KPI divides by the raw span again');
  assert.match(src, /monthCount: pre\.monthCount/, 'cityData does not expose the anchored month count');
});

test('ymRange guards a non-finite month range instead of printing "NaN"', () => {
  const src = read('report.js');
  assert.match(src, /function ymRange\(mm\) \{ if \(!isFinite\(mm\.min\) \|\| !isFinite\(mm\.max\)\)/);
});

/* --- compare.js --------------------------------------------------------------- */

test('compare.js merges seed + shared + local reports like analytics.js does', () => {
  /* Compare loaded only accidents.json, so once any citizen report existed the same
     area showed a different total on compare.html than on analytics.html / the map. */
  const src = read('compare.js');
  assert.match(src, /function validReport\(r\)/, 'compare.js has no report validator');
  assert.match(src, /function loadCitizen\(\)/, 'compare.js does not read local reports');
  assert.match(src, /function loadSeed\(arr\)/, 'compare.js does not read the seed reports');
  assert.match(src, /function fetchSharedReports\(\)/, 'compare.js does not fetch shared reports');
  assert.match(src, /function mergeReports\(shared, local\)/, 'compare.js does not de-duplicate reports');
  assert.match(src, /DATA = data\.concat\(loadSeed\(seed\)\)\.concat\(mergeReports\(shared, loadCitizen\(\)\)\)/,
    'compare.js still assigns the raw accidents.json without merging citizen reports');
});

test('compare.js bounds report coordinates, like the other two validators', () => {
  const src = read('compare.js');
  for (const bound of ['latMin', 'latMax', 'lngMin', 'lngMax']) {
    assert.match(src, new RegExp('REPORT_BOUNDS\\.' + bound + '\\b'),
      `compare.js validReport does not check REPORT_BOUNDS.${bound}`);
  }
});
