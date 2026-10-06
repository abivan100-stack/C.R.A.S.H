/* Characterisation tests for shared/engine.js — the hotspot engine that four
   pages depend on and that had zero coverage.

   Runs on Node's built-in test runner with zero dependencies:
       node --test tests/js
   The shared modules are plain IIFEs over `typeof window !== 'undefined' ? window : this`,
   so under CommonJS `this` is module.exports and require() picks them up unchanged. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CRASH_ENGINE: CE } = require('../../shared/engine.js');
const { CRASH_CONSTANTS: C } = require('../../shared/constants.js');

const { BBOX, CELL, TOP_N, SUPPRESS, RECENT_MONTHS,
        EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N } = C;

/* A record shaped exactly like a row of data/accidents.json. */
function rec(severity, lat, lng, extra) {
  return Object.assign({
    lat, lng, severity,
    area: 'Guindy', cause: 'Over-speeding', vehicle: 'Car',
    weather: 'clear', datetime: '2025-06-01 14:30',
  }, extra || {});
}

/* --- precompute ---------------------------------------------------------- */

test('precompute derives hour, night flag and weekday from the datetime string', () => {
  const records = [
    rec('fatal', 13.0, 80.2, { datetime: '2025-06-02 14:30' }), // Monday, day
    rec('slight', 13.0, 80.2, { datetime: '2025-06-02 23:15' }), // Monday, night
    rec('slight', 13.0, 80.2, { datetime: '2025-06-02 05:59' }), // Monday, night
  ];
  CE.precompute(records);

  assert.equal(records[0]._h, 14);
  assert.equal(records[0]._night, false);
  assert.equal(records[1]._h, 23);
  assert.equal(records[1]._night, true);
  assert.equal(records[2]._night, true, '05:59 is night; the boundary is 06:00');
  assert.equal(records[0]._dow, 0, 'Monday is index 0 (DOW starts Mon)');
});

test('precompute reports the inclusive month span', () => {
  const records = [
    rec('fatal', 13.0, 80.2, { datetime: '2024-07-01 10:00' }),
    rec('fatal', 13.0, 80.2, { datetime: '2025-06-30 10:00' }),
  ];
  const meta = CE.precompute(records);

  assert.equal(meta.monthCount, 12);
  assert.equal(meta.lastMonth, 11);
  assert.equal(records[0]._month, 0);
  assert.equal(records[1]._month, 11);
});

test('precompute handles a single record without producing a zero-length window', () => {
  const records = [rec('fatal', 13.0, 80.2)];
  assert.equal(CE.precompute(records).monthCount, 1);
});

/* --- gridCells ----------------------------------------------------------- */

test('gridCells applies the documented severity weighting (fatal 3, serious 2, slight 1)', () => {
  const records = [rec('fatal', 13.0, 80.2), rec('serious', 13.0, 80.2), rec('slight', 13.0, 80.2)];
  CE.precompute(records);
  const cells = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1);

  assert.equal(cells.length, 1, 'three points in one cell collapse to one cell');
  assert.equal(cells[0].count, 3);
  assert.equal(cells[0].score, 6, '3 + 2 + 1');
  assert.equal(cells[0].fatal, 1);
  assert.equal(cells[0].serious, 1);
  assert.equal(cells[0].slight, 1);
});

test('gridCells separates points that fall in different cells', () => {
  const records = [rec('fatal', 13.0, 80.2), rec('fatal', 13.0 + CELL * 3, 80.2)];
  CE.precompute(records);
  assert.equal(CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1).length, 2);
});

test('gridCells assigns a cell the area holding the most of its records', () => {
  const records = [
    rec('slight', 13.0, 80.2, { area: 'Adyar' }),
    rec('slight', 13.0, 80.2, { area: 'Guindy' }),
    rec('slight', 13.0, 80.2, { area: 'Guindy' }),
  ];
  CE.precompute(records);
  assert.equal(CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1)[0].area, 'Guindy');
});

test('gridCells centres a cell on the mean of its member coordinates', () => {
  // Both points must sit inside one ~250 m cell, so the offsets stay well under CELL.
  const records = [rec('slight', 13.0, 80.2), rec('slight', 13.0001, 80.2001)];
  CE.precompute(records);
  const cells = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1);

  assert.equal(cells.length, 1, 'both points share a cell');
  assert.ok(Math.abs(cells[0].lat - 13.00005) < 1e-9);
  assert.ok(Math.abs(cells[0].lng - 80.20005) < 1e-9);
});

test('gridCells splits recent from baseline on the RECENT_MONTHS boundary', () => {
  const monthCount = 24;
  const records = [];
  for (let m = 0; m < monthCount; m++) {
    const r = rec('slight', 13.0, 80.2);
    r._month = m;
    r._night = false;
    records.push(r);
  }
  const cell = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, monthCount)[0];

  assert.equal(cell.recent, RECENT_MONTHS, 'exactly the last RECENT_MONTHS months are recent');
  assert.equal(cell.baseline, monthCount - RECENT_MONTHS);
  assert.equal(cell.recent + cell.baseline, cell.count, 'every record lands in exactly one bucket');
});

test('gridCells returns an empty array for no records', () => {
  assert.deepEqual(CE.gridCells([], BBOX, CELL, RECENT_MONTHS, 1), []);
});

/* --- topJunctions -------------------------------------------------------- */

test('topJunctions ranks by score, breaking ties on raw count', () => {
  const cells = [
    { key: 'a', ci: 0, cj: 0, score: 10, count: 4 },
    { key: 'b', ci: 50, cj: 50, score: 30, count: 10 },
    { key: 'c', ci: 90, cj: 90, score: 30, count: 12 },
  ];
  const top = CE.topJunctions(cells, TOP_N, SUPPRESS);

  assert.deepEqual(top.map((c) => c.key), ['c', 'b', 'a']);
});

test('topJunctions normalises the leader to 100 and never emits a zero', () => {
  const cells = [
    { key: 'a', ci: 0, cj: 0, score: 100, count: 40 },
    { key: 'b', ci: 50, cj: 50, score: 1, count: 1 },
  ];
  const top = CE.topJunctions(cells, TOP_N, SUPPRESS);

  assert.equal(top[0].norm, 100);
  assert.ok(top[1].norm >= 1, 'the weakest cell still scores at least 1');
});

test('topJunctions suppresses neighbours so one junction cannot occupy several slots', () => {
  const cells = [
    { key: 'a', ci: 10, cj: 10, score: 50, count: 20 },
    { key: 'b', ci: 11, cj: 10, score: 40, count: 18 }, // adjacent -> suppressed
    { key: 'c', ci: 40, cj: 40, score: 30, count: 12 }, // far away -> kept
  ];
  const top = CE.topJunctions(cells, TOP_N, SUPPRESS);

  assert.deepEqual(top.map((c) => c.key), ['a', 'c']);
});

test('topJunctions caps its output at TOP_N', () => {
  const cells = [];
  for (let i = 0; i < 40; i++) cells.push({ key: 'k' + i, ci: i * 10, cj: 0, score: 100 - i, count: 5 });

  assert.equal(CE.topJunctions(cells, TOP_N, SUPPRESS).length, TOP_N);
});

test('topJunctions does not reorder the caller array', () => {
  const cells = [
    { key: 'a', ci: 0, cj: 0, score: 1, count: 1 },
    { key: 'b', ci: 50, cj: 50, score: 99, count: 9 },
  ];
  CE.topJunctions(cells, TOP_N, SUPPRESS);
  assert.equal(cells[0].key, 'a', 'the input array is sorted on a copy');
});

test('topJunctions on an empty set returns empty rather than dividing by zero', () => {
  assert.deepEqual(CE.topJunctions([], TOP_N, SUPPRESS), []);
});

/* --- computeEmerging ----------------------------------------------------- */

function emergingCell(key, ci, recent, baseline) {
  return { key, ci, cj: 0, recent, baseline, recentScore: recent * 2, areas: { Guindy: recent } };
}

test('computeEmerging ignores cells below the minimum recent volume', () => {
  const quiet = emergingCell('quiet', 0, EMERGE_MIN_RECENT - 1, 0);
  const out = CE.computeEmerging([quiet], RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(out.length, 0);
});

test('computeEmerging ignores cells whose lift is below the threshold', () => {
  // 18 baseline months, 6 recent: a flat cell has lift 1.0, under EMERGE_LIFT.
  const flat = emergingCell('flat', 0, 12, 36);
  const out = CE.computeEmerging([flat], RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(out.length, 0);
});

test('computeEmerging reports lift as the recent-vs-baseline monthly rate ratio', () => {
  // recent 24 over 6 months = 4/month; baseline 18 over 18 months = 1/month -> lift 4.
  const rising = emergingCell('rising', 0, 24, 18);
  const [hit] = CE.computeEmerging([rising], RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(hit.recentRate, 4);
  assert.equal(hit.baseRate, 1);
  assert.equal(hit.lift, 4);
  assert.equal(hit.pct, 300, 'pct is the percentage increase, not the ratio');
});

test('computeEmerging includes the map marker, sparkline and recent severity fields', () => {
  const records = [];
  for (let i = 0; i < 6; i++) records.push(rec('slight', 13.0, 80.2, { _month: i }));
  for (const severity of ['fatal', 'fatal', 'serious', 'serious', 'slight', 'slight', 'slight', 'slight']) {
    records.push(rec(severity, 13.0, 80.2, { _month: 20 }));
  }
  const [cell] = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 24,
    (severity) => C.sevOf(severity).weight);
  const [hit] = CE.computeEmerging([cell], RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(hit.id, cell.key);
  assert.equal(hit.lat, 13.0);
  assert.ok(Math.abs(hit.lng - 80.2) < 1e-9);
  assert.equal(hit.pctIncrease, 300);
  assert.equal(hit.months.length, 24);
  assert.equal(hit.months[20], 8);
  assert.deepEqual([hit.rF, hit.rS, hit.rL], [2, 2, 4]);
});

test('computeEmerging is capped at EMERGE_TOP_N — callers must not treat its length as a total', () => {
  const cells = [];
  for (let i = 0; i < 30; i++) cells.push(emergingCell('c' + i, i * 10, 24 + i, 18));

  const out = CE.computeEmerging(cells, RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.equal(out.length, EMERGE_TOP_N);
  assert.ok(cells.length > EMERGE_TOP_N,
    'many more cells qualify than are returned — see the "emerging count" finding');
});

test('computeEmerging orders by priority, not by raw recent volume', () => {
  const steady = emergingCell('steady-high-volume', 0, 40, 120); // lift 1.0 -> filtered out
  const spike = emergingCell('sharp-spike', 50, 20, 6);          // lift 10
  const out = CE.computeEmerging([steady, spike], RECENT_MONTHS, 24,
    EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  assert.deepEqual(out.map((c) => c.area), ['Guindy']);
  assert.equal(out.length, 1, 'the flat high-volume cell is not "emerging"');
});
