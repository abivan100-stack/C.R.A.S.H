/* Parity harness for the typed hotspot engine (issue #5).

   Runs the legacy shared/engine.js and the typed port over the same records and
   asserts identical gridding, ranking and emergence output. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  BBOX,
  CELL,
  EMERGE_LIFT,
  EMERGE_MIN_RECENT,
  EMERGE_TOP_N,
  MAX_WINDOW_MONTHS,
  RECENT_MONTHS,
  SUPPRESS,
  TOP_N,
} from './constants.ts';
import { computeEmerging, gridCells, monthMeta, precompute, topJunctions } from './engine.ts';
import type { AccidentRecord, GridCell } from './engine.ts';

const require = createRequire(import.meta.url);
const legacy = (
  require('../../../shared/engine.js') as {
    CRASH_ENGINE: {
      precompute: (r: unknown[], max?: number) => { minYM: number; monthCount: number; lastMonth: number };
      monthMeta: (r: unknown[]) => { min: number; max: number; count: number };
      gridCells: (r: unknown[], b: unknown, c: number, rm: number, mc?: number) => Array<Record<string, unknown>>;
      topJunctions: (cells: unknown[], n: number, s: number) => Array<Record<string, unknown>>;
      computeEmerging: (
        cells: unknown[],
        rm: number,
        mc: number,
        min: number,
        lift: number,
        n: number,
        s: number,
      ) => Array<Record<string, unknown>> & { qualifyingCount: number };
    };
  }
).CRASH_ENGINE;

const dataset = JSON.parse(
  readFileSync(path.join(process.cwd(), 'data', 'accidents.json'), 'utf8'),
) as AccidentRecord[];

function clone(records: readonly AccidentRecord[]): AccidentRecord[] {
  return records.map((r) => ({ ...r }));
}

function legacyCells(records: AccidentRecord[], monthCount: number): Array<Record<string, unknown>> {
  return legacy.gridCells(records as unknown[], BBOX, CELL, RECENT_MONTHS, monthCount);
}

function byKey(cells: ReadonlyArray<Record<string, unknown> | GridCell>): Map<string, Record<string, unknown> | GridCell> {
  return new Map(cells.map((c) => [String((c as { key: string }).key), c as Record<string, unknown> | GridCell]));
}

test('precompute resolves the same analysis window', () => {
  const oldRecords = clone(dataset);
  const newRecords = clone(dataset);
  const oldMeta = legacy.precompute(oldRecords as unknown[], MAX_WINDOW_MONTHS);
  const newMeta = precompute(newRecords, MAX_WINDOW_MONTHS);
  assert.deepEqual(newMeta, oldMeta);
  for (let i = 0; i < oldRecords.length; i += 1) {
    const o = oldRecords[i] as unknown as Record<string, unknown>;
    const n = newRecords[i] as unknown as Record<string, unknown>;
    assert.equal(n._h, o._h);
    assert.equal(n._night, o._night);
    assert.equal(n._dow, o._dow);
    assert.equal(n._ym, o._ym);
    assert.equal(n._month, o._month);
  }
});

test('monthMeta matches the legacy range', () => {
  assert.deepEqual(monthMeta(dataset), legacy.monthMeta(dataset as unknown[]));
  assert.deepEqual(monthMeta([]), legacy.monthMeta([]));
});

test('gridCells produces identical cells on the full dataset', () => {
  const records = clone(dataset);
  const meta = precompute(records, MAX_WINDOW_MONTHS);
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, meta.monthCount);
  const oldCells = legacyCells(records, meta.monthCount);
  assert.equal(cells.length, oldCells.length);
  const newMap = byKey(cells);
  for (const old of oldCells) {
    const key = String(old.key);
    const cell = newMap.get(key) as GridCell;
    assert.ok(cell, `missing cell ${key}`);
    for (const field of ['ci', 'cj', 'count', 'score', 'fatal', 'serious', 'slight', 'night', 'recent', 'baseline', 'recentScore', 'rF', 'rS', 'rL'] as const) {
      assert.equal(cell[field], old[field], `${key}.${field}`);
    }
    assert.equal(cell.area, old.area);
    assert.ok(Math.abs(cell.lat - (old.lat as number)) < 1e-12);
    assert.ok(Math.abs(cell.lng - (old.lng as number)) < 1e-12);
    assert.deepEqual([...cell.months!], old.months as number[]);
    assert.deepEqual({ ...cell.areas }, { ...(old.areas as Record<string, number>) });
    assert.deepEqual({ ...cell.cause }, { ...(old.cause as Record<string, number>) });
  }
});

test('topJunctions ranks the same top ten with identical scores', () => {
  const records = clone(dataset);
  const meta = precompute(records, MAX_WINDOW_MONTHS);
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, meta.monthCount);
  const top = topJunctions(cells, TOP_N, SUPPRESS);
  const oldTop = legacy.topJunctions(legacyCells(records, meta.monthCount), TOP_N, SUPPRESS);
  assert.equal(top.length, oldTop.length);
  top.forEach((cell, i) => {
    const old = oldTop[i] as Record<string, unknown>;
    assert.equal(cell.key, old.key);
    assert.equal(cell.score, old.score);
    assert.equal(cell.count, old.count);
    assert.equal(cell.norm, old.norm);
  });
});

test('computeEmerging flags the same cells with the same scores', () => {
  const records = clone(dataset);
  const meta = precompute(records, MAX_WINDOW_MONTHS);
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, meta.monthCount);
  const emerging = computeEmerging(cells, RECENT_MONTHS, meta.monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  const oldEmerging = legacy.computeEmerging(
    legacyCells(records, meta.monthCount),
    RECENT_MONTHS,
    meta.monthCount,
    EMERGE_MIN_RECENT,
    EMERGE_LIFT,
    EMERGE_TOP_N,
    SUPPRESS,
  );
  assert.equal(emerging.length, oldEmerging.length);
  assert.equal(emerging.qualifyingCount, oldEmerging.qualifyingCount);
  emerging.forEach((hotspot, i) => {
    const old = oldEmerging[i] as Record<string, unknown>;
    assert.equal(hotspot.id, old.id);
    assert.equal(hotspot.area, old.area);
    assert.equal(hotspot.recent, old.recent);
    assert.equal(hotspot.baseline, old.baseline);
    assert.equal(hotspot.lift, old.lift);
    assert.equal(hotspot.priority, old.priority);
    assert.equal(hotspot.pctIncrease, old.pctIncrease);
  });
});

test('prototype probes are inert in both engines', () => {
  const hostile: AccidentRecord[] = [
    ...clone(dataset.slice(0, 500)),
    { lat: 13.05, lng: 80.23, severity: 'toString', datetime: '2025-01-05 15:15', weather: 'clear', cause: 'Hit and run', vehicle: 'Car', area: '__proto__' },
    { lat: 13.051, lng: 80.231, severity: 'constructor', datetime: '2025-02-05 03:15', weather: 'rain', cause: 'constructor', vehicle: 'Car', area: 'constructor' },
  ];
  const oldRecords = clone(hostile);
  const newRecords = clone(hostile);
  const oldMeta = legacy.precompute(oldRecords as unknown[], MAX_WINDOW_MONTHS);
  const newMeta = precompute(newRecords, MAX_WINDOW_MONTHS);
  assert.deepEqual(newMeta, oldMeta);
  const cells = gridCells(newRecords, BBOX, CELL, RECENT_MONTHS, newMeta.monthCount);
  const oldCells = legacyCells(oldRecords, newMeta.monthCount);
  const newMap = byKey(cells);
  for (const old of oldCells) {
    const cell = newMap.get(String(old.key)) as GridCell;
    assert.equal(cell.score, old.score);
    assert.equal(cell.count, old.count);
    assert.equal(Number.isFinite(cell.score), true);
    assert.deepEqual({ ...cell.areas }, { ...(old.areas as Record<string, number>) });
  }
});

test('the engine imports without a DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof precompute, 'function');
});
