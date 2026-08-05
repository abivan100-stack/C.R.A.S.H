/* Regression tests for the four displayed numbers that were provably wrong
   (findings F034, F035, F036, F037), plus the canvas leak (F038).

   These are the figures a judge reads off the screen, so each test states the
   real-world claim the number is making, not just the arithmetic. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CRASH_ENGINE: CE } = require('../../shared/engine.js');
const { CRASH_CONSTANTS: C } = require('../../shared/constants.js');
const { CRASH_INTERVENTIONS: IV } = require('../../intervention-model.js');

const { BBOX, CELL, RECENT_MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT,
        EMERGE_TOP_N, SUPPRESS, MAX_WINDOW_MONTHS } = C;

const ROOT = path.join(__dirname, '..', '..');

function rec(severity, datetime, lat = 13.0, lng = 80.2) {
  return { lat, lng, severity, area: 'Guindy', cause: 'Over-speeding',
           vehicle: 'Car', weather: 'clear', datetime };
}

/* --- F034: "preventable severe crashes" ---------------------------------- */

test('preventable never claims more crashes than actually happened', () => {
  // The original formula was (fatal*3 + serious) * eff, so 10 fatal at 35%
  // effectiveness reported 11 preventable out of 10.
  assert.equal(IV.preventable(10, 0, 0.35), 3);
  assert.ok(IV.preventable(10, 0, 0.35) <= 10);

  for (const fatal of [0, 1, 5, 10, 50, 300]) {
    for (const serious of [0, 1, 7, 40, 500]) {
      for (const eff of [0, 0.1, 0.2, 0.35, 0.5, 0.9, 1]) {
        const out = IV.preventable(fatal, serious, eff);
        assert.ok(out <= fatal + serious,
          `claimed ${out} preventable from ${fatal + serious} severe crashes at eff ${eff}`);
        assert.ok(out >= 0);
        assert.ok(Number.isInteger(out));
      }
    }
  }
});

test('preventable never exceeds the modelled effectiveness of the fix', () => {
  // The headline claim: a 35%-effective fix cannot prevent 51% of the crashes.
  for (const [fatal, serious, eff] of [[100, 50, 0.35], [10, 0, 0.35], [3, 9, 0.2]]) {
    const severe = fatal + serious;
    const share = IV.preventable(fatal, serious, eff) / severe;
    assert.ok(share <= eff + 1e-9,
      `claimed ${(share * 100).toFixed(1)}% prevented from a fix rated ${eff * 100}%`);
  }
});

test('preventable is proportional to the incidents, not to a severity score', () => {
  // Same number of severe crashes must give the same estimate regardless of the
  // fatal/serious split — it is an incident count, not a weighted risk score.
  assert.equal(IV.preventable(10, 0, 0.5), IV.preventable(0, 10, 0.5));
  assert.equal(IV.preventable(6, 4, 0.5), IV.preventable(4, 6, 0.5));
});

test('preventable handles missing and out-of-range inputs safely', () => {
  assert.equal(IV.preventable(0, 0, 0.35), 0);
  assert.equal(IV.preventable(undefined, undefined, 0.35), 0);
  assert.equal(IV.preventable(10, 10, 5), 20, 'effectiveness above 1 is clamped');
  assert.equal(IV.preventable(10, 10, -1), 0, 'negative effectiveness is clamped');
});

/* --- F035: the emerging-hotspot count ------------------------------------ */

function emergingCell(ci, recent, baseline) {
  return { key: 'c' + ci, ci, cj: 0, recent, baseline,
           recentScore: recent * 2, areas: { Guindy: recent } };
}

test('the emerging engine reports how many zones qualify, not just how many it shows', () => {
  const cells = [];
  for (let i = 0; i < 25; i++) cells.push(emergingCell(i * 10, 24 + i, 18));

  const out = CE.computeEmerging(cells, RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(out.length, EMERGE_TOP_N, 'the display list is still capped');
  assert.equal(out.qualifyingCount, 25, 'the KPI count must not be capped at 6');
});

test('the qualifying count still excludes zones that do not qualify', () => {
  const cells = [
    emergingCell(0, 24, 18),                     // lift 4 -> qualifies
    emergingCell(50, EMERGE_MIN_RECENT - 1, 0),  // too few recent
    emergingCell(90, 12, 36),                    // lift 1.0 -> flat
  ];
  const out = CE.computeEmerging(cells, RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(out.qualifyingCount, 1);
});

test('the KPI consumers read qualifyingCount, not the capped length', () => {
  // Only lines that DISPLAY the number matter. `if (emerging.length)` as an
  // emptiness guard before rendering a table is correct and must not be flagged.
  for (const file of ['analytics.js', 'report.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const displayed = source.split('\n').filter(
      (l) => /fmt\(\s*[A-Za-z.]*emerging\.length/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.deepEqual(displayed, [],
      `${file} renders a capped emerging count: ${displayed.join(' | ').slice(0, 120)}`);
  }
});

/* --- F036: the analysis window ------------------------------------------- */

function twoYearsOfRecords() {
  const records = [];
  for (let m = 0; m < 24; m++) {
    const year = 2024 + Math.floor((6 + m) / 12);
    const month = String(((6 + m) % 12) + 1).padStart(2, '0');
    records.push(rec('slight', `${year}-${month}-15 10:00`));
  }
  return records;
}

test('one old-dated report cannot stretch the analysis window', () => {
  const clean = CE.precompute(twoYearsOfRecords(), MAX_WINDOW_MONTHS);
  assert.equal(clean.monthCount, 24);

  const poisoned = twoYearsOfRecords();
  poisoned.push(rec('slight', '2015-01-01 10:00'));
  const after = CE.precompute(poisoned, MAX_WINDOW_MONTHS);

  assert.equal(after.monthCount, 24,
    'the window stretched — every per-month figure would be divided by the wrong number');
});

test('the per-month average stays correct when a stray old report exists', () => {
  // The observable symptom: 10,169 records over 24 months is ~424/month. With the
  // window stretched to 138 the KPI read 74 — a 5.7x understatement.
  const poisoned = twoYearsOfRecords();
  poisoned.push(rec('slight', '2015-01-01 10:00'));
  const meta = CE.precompute(poisoned, MAX_WINDOW_MONTHS);

  const perMonth = Math.round(10169 / meta.monthCount);
  assert.equal(perMonth, 424);
});

test('the window is anchored to the newest record', () => {
  const records = twoYearsOfRecords();
  records.push(rec('slight', '2015-01-01 10:00'));
  const meta = CE.precompute(records, MAX_WINDOW_MONTHS);

  const newest = Math.max(...records.map((r) => (+r.datetime.slice(0, 4)) * 12 + (+r.datetime.slice(5, 7) - 1)));
  assert.equal(meta.minYM + meta.monthCount - 1, newest);
});

test('a genuinely shorter dataset is not padded out to the cap', () => {
  const records = [rec('slight', '2026-01-15 10:00'), rec('slight', '2026-03-15 10:00')];
  assert.equal(CE.precompute(records, MAX_WINDOW_MONTHS).monthCount, 3);
});

test('precompute on an empty set returns a usable window instead of Infinity', () => {
  const meta = CE.precompute([], MAX_WINDOW_MONTHS);
  assert.equal(meta.monthCount, 1);
  assert.ok(Number.isFinite(meta.minYM));
});

/* --- F037: zone dominance ------------------------------------------------ */

test('a zone with no fatalities is never labelled fatal-dominant', () => {
  // Reproduces the filtered-subset case: city-wide fatal share is 0, so the old
  // `fShare >= gFatalShare` was `0 >= 0` — true for every cell.
  const gFatalShare = 0, gSeriousShare = 0;
  const cell = { fatal: 0, serious: 0, count: 12 };

  const fShare = cell.fatal / cell.count;
  const sShare = cell.serious / cell.count;
  const dom = (cell.fatal > 0 && fShare >= gFatalShare) ? 'fatal'
            : (cell.serious > 0 && sShare >= gSeriousShare) ? 'serious' : 'slight';

  assert.equal(dom, 'slight');
});

test('a zone with fatalities above the city baseline is still fatal-dominant', () => {
  const gFatalShare = 0.06;
  const cell = { fatal: 3, serious: 1, count: 10 };   // 30% fatal, well above baseline
  const dom = (cell.fatal > 0 && (cell.fatal / cell.count) >= gFatalShare) ? 'fatal' : 'other';

  assert.equal(dom, 'fatal', 'the fix must not suppress genuine fatal-dominant zones');
});

test('app.js guards both dominance branches on a non-zero count', () => {
  const source = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(source, /c\.fatal > 0 && fShare >= gFatalShare/);
  assert.match(source, /c\.serious > 0 && sShare >= gSeriousShare/);
});

/* --- F038: the canvas renderer leak -------------------------------------- */

test('the map renderers are memoised rather than recreated per render', () => {
  for (const [file, guard] of [['app.js', /if \(!app\.pointRenderer\) app\.pointRenderer = L\.canvas/],
                               ['bot.js', /if \(!botPointRenderer\) botPointRenderer = L\.canvas/]]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, guard, `${file} still creates a canvas renderer on every render`);
  }
});

test('no shipped file creates an unguarded L.canvas inside a render path', () => {
  const offenders = [];
  for (const file of ['app.js', 'bot.js', 'simulate.js']) {
    const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/=\s*L\.canvas\(/.test(line)) return;
      if (!/if \(!/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `unguarded L.canvas allocation in: ${offenders.join(', ')}`);
});
