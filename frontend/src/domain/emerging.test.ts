/* Emerging-hotspot threshold semantics (issue #6).

   Locks the exact qualify rules: minimum recent count, rate lift versus the
   prior window, zero-baseline handling, raw qualify count, and non-max
   suppression of the display list. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeEmerging, gridCells, precompute, topJunctions } from './engine.ts';
import type { AccidentRecord, GridCell } from './engine.ts';
import { BBOX, CELL, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N, RECENT_MONTHS, SUPPRESS } from './constants.ts';

function cell(overrides: Partial<GridCell> & Pick<GridCell, 'key' | 'ci' | 'cj'>): GridCell {
  return {
    count: 0, score: 0, fatal: 0, serious: 0, slight: 0, night: 0,
    areas: Object.create(null) as Record<string, number>,
    cause: Object.create(null) as Record<string, number>,
    recent: 0, baseline: 0, recentScore: 0,
    rF: 0, rS: 0, rL: 0, sumLat: 0, sumLng: 0, months: null,
    area: '', lat: 13, lng: 80,
    ...overrides,
  };
}

const MONTHS = 24;

test('a cell one report below the recent minimum is excluded', () => {
  const below = cell({ key: 'a', ci: 0, cj: 0, recent: EMERGE_MIN_RECENT - 1, baseline: 1, recentScore: 100 });
  const at = cell({ key: 'b', ci: 5, cj: 5, recent: EMERGE_MIN_RECENT, baseline: 1, recentScore: 100 });
  const list = computeEmerging([below, at], RECENT_MONTHS, MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  assert.deepEqual(list.map((h) => h.id), ['b']);
});

test('the lift threshold is inclusive and the qualifying count is raw', () => {
  /* recent 8 over 6 months vs baseline 2 over 18 months: lift = (8/6)/(2/18) = 12 */
  const surging = cell({ key: 's', ci: 1, cj: 1, recent: 8, baseline: 2, recentScore: 24 });
  /* recent 9 over 6 months vs baseline 18 over 18 months: lift = 1.5 exactly */
  const boundary = cell({ key: 'e', ci: 4, cj: 4, recent: 9, baseline: 18, recentScore: 27 });
  /* recent 8 over 6 months vs baseline 18 over 18 months: lift = 1.33, excluded */
  const flat = cell({ key: 'f', ci: 7, cj: 7, recent: 8, baseline: 18, recentScore: 24 });
  const list = computeEmerging(
    [surging, boundary, flat],
    RECENT_MONTHS, MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS,
  );
  assert.deepEqual(list.map((h) => h.id).sort(), ['e', 's']);
  assert.equal(list.qualifyingCount, 2);
  assert.equal(list.length <= EMERGE_TOP_N, true);
});

test('zero prior baseline counts as a lift of 3, never Infinity', () => {
  const fresh = cell({ key: 'n', ci: 2, cj: 2, recent: EMERGE_MIN_RECENT, baseline: 0, recentScore: 16 });
  const list = computeEmerging([fresh], RECENT_MONTHS, MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  const [hotspot] = list;
  assert.ok(hotspot);
  assert.equal(hotspot.lift, 3);
  assert.equal(hotspot.pctIncrease, 200);
  assert.equal(Number.isFinite(hotspot.priority), true);
});

test('the display list is capped at six while the count stays raw', () => {
  const cells = Array.from({ length: 12 }, (_, i) =>
    cell({ key: `c${i}`, ci: i * 4, cj: i * 4, recent: 20, baseline: 1, recentScore: 100 - i }),
  );
  const list = computeEmerging(cells, RECENT_MONTHS, MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  assert.equal(list.length, EMERGE_TOP_N);
  assert.equal(list.qualifyingCount, 12);
  /* sorted by priority, best first */
  for (let i = 1; i < list.length; i += 1) assert.ok((list[i - 1] as { priority: number }).priority >= (list[i] as { priority: number }).priority);
});

test('neighbouring emerging cells are de-clustered by non-max suppression', () => {
  const a = cell({ key: 'x', ci: 10, cj: 10, recent: 30, baseline: 0, recentScore: 90 });
  const b = cell({ key: 'y', ci: 11, cj: 11, recent: 28, baseline: 0, recentScore: 84 });
  const c = cell({ key: 'z', ci: 30, cj: 30, recent: 25, baseline: 0, recentScore: 75 });
  const list = computeEmerging([a, b, c], RECENT_MONTHS, MONTHS, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  assert.deepEqual(list.map((h) => h.id), ['x', 'z']);
  assert.equal(list.qualifyingCount, 3);
});

test('emerging flags on real data match the engine pipeline end to end', () => {
  const now = new Date();
  const stamp = (monthsAgo: number): string => {
    const d = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-10 09:00`;
  };
  const records: AccidentRecord[] = [];
  for (let i = 0; i < 20; i += 1) {
    records.push({ lat: 13.0, lng: 80.2, severity: 'fatal', datetime: stamp(1), weather: 'clear', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar' });
  }
  for (let i = 0; i < 6; i += 1) {
    records.push({ lat: 13.05, lng: 80.25, severity: 'slight', datetime: stamp(10), weather: 'rain', cause: 'Hit and run', vehicle: 'Bus (MTC/Private)', area: 'Egmore' });
  }
  const meta = precompute(records);
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, meta.monthCount);
  const top = topJunctions(cells, 10, SUPPRESS);
  assert.equal(top.length, 2);
  const emerging = computeEmerging(cells, RECENT_MONTHS, meta.monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  assert.equal(emerging.length, 1);
  assert.equal(emerging[0]?.area, 'Adyar');
  assert.equal(emerging.qualifyingCount, 1);
});
