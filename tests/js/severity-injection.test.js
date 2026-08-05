/* Regression tests for F260 — a crafted `severity` string poisoning the engine.

   POST /report accepts any string for `severity`. The frontend guard was
   `SEV[r.severity]`, a truthiness test, which ALSO resolves inherited
   Object.prototype members — so severity:"toString" passed validation. It then
   reached shared/engine.js, where two separate bugs compounded:

     defWeight:  DEFAULT_WEIGHT[s] || 1   -> returned Object.prototype.toString,
                 a *function*, which was then added to cell.score
     gridCells:  c[a.severity] = ... + 1  -> wrote an attacker-named key straight
                 onto the accumulator, which also holds count/score/key/ci/lat

   Result: one unauthenticated POST made topJunctions emit `norm: NaN`, which
   flows into the bloom radius and the displayed risk score — corrupting the
   top-10 ranking the whole project rests on. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CRASH_ENGINE: CE } = require('../../shared/engine.js');
const { CRASH_CONSTANTS: C } = require('../../shared/constants.js');

const { BBOX, CELL, TOP_N, SUPPRESS, RECENT_MONTHS } = C;

/* Every key an attacker could try to collide with on the cell accumulator,
   plus the inherited members that defeated the old truthiness guard. */
const HOSTILE = [
  'toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__',
  'count', 'score', 'key', 'ci', 'cj', 'lat', 'lng', 'night', 'recent',
  'baseline', 'recentScore', 'sumLat', 'sumLng', 'months', 'areas',
];

function rec(severity, lat, lng) {
  return {
    lat, lng, severity,
    area: 'Guindy', cause: 'Over-speeding', vehicle: 'Car',
    weather: 'clear', datetime: '2025-06-01 14:30',
    _night: false, _month: 0,
  };
}

/* --- the guard ----------------------------------------------------------- */

test('isSeverity rejects inherited Object.prototype members', () => {
  for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.equal(C.isSeverity(key), false, `${key} must not pass as a severity`);
  }
});

test('isSeverity accepts exactly the three real severities', () => {
  assert.deepEqual(C.SEVERITIES, ['fatal', 'serious', 'slight']);
  for (const s of C.SEVERITIES) assert.equal(C.isSeverity(s), true);
  assert.equal(C.isSeverity('catastrophic'), false);
  assert.equal(C.isSeverity(''), false);
  assert.equal(C.isSeverity(null), false);
  assert.equal(C.isSeverity(undefined), false);
});

test('sevOf falls back to slight instead of returning a function', () => {
  assert.equal(C.sevOf('fatal').weight, 3);
  for (const key of HOSTILE) {
    const descriptor = C.sevOf(key);
    assert.equal(typeof descriptor, 'object', `sevOf(${key}) returned a ${typeof descriptor}`);
    assert.equal(typeof descriptor.weight, 'number');
    assert.equal(typeof descriptor.color, 'string');
  }
});

/* --- the engine ---------------------------------------------------------- */

test('a crafted severity cannot overwrite any cell accumulator field', () => {
  for (const key of HOSTILE) {
    const records = [rec('fatal', 13.0, 80.2), rec(key, 13.0, 80.2)];
    const [cell] = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1);

    assert.equal(cell.count, 2, `count corrupted by severity:${key}`);
    assert.equal(typeof cell.score, 'number', `score is no longer a number (severity:${key})`);
    assert.ok(Number.isFinite(cell.score), `score is not finite (severity:${key})`);
    assert.equal(cell.score, 4, `score should be 3 (fatal) + 1 (unknown) for severity:${key}`);
    assert.equal(cell.key, '90_77', `key overwritten by severity:${key}`);
    assert.equal(typeof cell.lat, 'number', `lat overwritten by severity:${key}`);
    assert.equal(cell.fatal, 1);
    assert.equal(cell.serious, 0);
    assert.equal(cell.slight, 0);
  }
});

test('a crafted severity cannot make the ranking score non-numeric', () => {
  // The exact reproduction from the audit: a quiet cell plus one crafted report,
  // against a genuinely dangerous junction.
  const records = [];
  for (let i = 0; i < 20; i++) records.push(rec('fatal', 13.0, 80.2));
  for (let i = 0; i < 3; i++) records.push(rec('slight', 13.05, 80.25));
  records.push(rec('toString', 13.05, 80.25));

  const cells = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1);
  const top = CE.topJunctions(cells, TOP_N, SUPPRESS);

  for (const cell of top) {
    assert.ok(Number.isFinite(cell.score), `score is not finite: ${cell.score}`);
    assert.ok(Number.isFinite(cell.norm), `norm is NaN — the original F260 symptom`);
    assert.ok(cell.norm >= 1 && cell.norm <= 100, `norm out of range: ${cell.norm}`);
  }
  assert.equal(top[0].score, 60, 'the real hotspot still ranks first with its true score');
});

test('a caller weightFn returning a non-number cannot poison the score', () => {
  const records = [rec('fatal', 13.0, 80.2), rec('slight', 13.0, 80.2)];
  const cells = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1,
    (s) => (s === 'fatal' ? 3 : undefined));   // a buggy caller

  assert.ok(Number.isFinite(cells[0].score), 'a bad weightFn made the score NaN');
});

test('unknown severities still count toward the incident total', () => {
  // Behaviour preserved: an unrecognised severity is weighted 1, not dropped,
  // so no legitimate record silently disappears from the map.
  const records = [rec('fatal', 13.0, 80.2), rec('mystery', 13.0, 80.2)];
  const [cell] = CE.gridCells(records, BBOX, CELL, RECENT_MONTHS, 1);

  assert.equal(cell.count, 2);
  assert.equal(cell.score, 4);
});
