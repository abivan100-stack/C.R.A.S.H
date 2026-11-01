/* Simulation model tests (issue #12): determinism, horizon math, scenarios. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BBOX, MAX_WINDOW_MONTHS } from './constants.ts';
import { precompute } from './engine.ts';
import type { AccidentRecord } from './engine.ts';
import {
  buildModel,
  normalizeScenario,
  runSimulation,
  scenarioPrevalence,
  summarize,
} from './simulation.ts';

function rec(overrides: Partial<AccidentRecord> = {}): AccidentRecord {
  return {
    lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-10 09:30',
    weather: 'rain', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar', ...overrides,
  };
}

const records: AccidentRecord[] = [];
for (let i = 0; i < 40; i += 1) records.push(rec({ lng: 80.20 + i * 0.0001 }));
for (let i = 0; i < 10; i += 1) records.push(rec({ lat: 13.15, lng: 80.30, weather: 'clear', datetime: '2025-06-11 12:00', severity: 'slight' }));
precompute(records, MAX_WINDOW_MONTHS);
const model = buildModel(records, BBOX, 24);
const bbox = BBOX;

test('scenario inputs normalise and the horizon is clamped to 1-24', () => {
  assert.equal(normalizeScenario({ horizonMonths: 0 }).horizonMonths, 6);
  assert.equal(normalizeScenario({ horizonMonths: 25 }).horizonMonths, 24);
  assert.equal(normalizeScenario({ horizonMonths: 1 }).horizonMonths, 1);
  assert.equal(normalizeScenario({ horizonMonths: '12' as unknown as number }).horizonMonths, 12);
  assert.deepEqual(normalizeScenario({}), { timeOfDay: 'any', weather: 'any', dayType: 'any', horizonMonths: 6 });
});

test('any/any/any matches the whole dataset', () => {
  assert.equal(scenarioPrevalence(normalizeScenario({}), model), 1);
});

test('the same scenario and nonce reproduce the exact projection', () => {
  const a = runSimulation(model, bbox, { horizonMonths: 6 }, 7);
  const b = runSimulation(model, bbox, { horizonMonths: 6 }, 7);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test('a different nonce produces a different sample', () => {
  const a = runSimulation(model, bbox, { horizonMonths: 6 }, 1);
  const b = runSimulation(model, bbox, { horizonMonths: 6 }, 2);
  assert.notDeepEqual(a, b);
});

test('the projected volume scales with the horizon', () => {
  const one = runSimulation(model, bbox, { horizonMonths: 1 }, 3).length;
  const twelve = runSimulation(model, bbox, { horizonMonths: 12 }, 3).length;
  assert.ok(one > 0 && twelve > one);
  assert.ok(twelve / one > 8 && twelve / one < 16, String(twelve / one));
});

test('a weather scenario concentrates the projection on matching cells', () => {
  const rain = runSimulation(model, bbox, { weather: 'rain', horizonMonths: 6 }, 4);
  const clear = runSimulation(model, bbox, { weather: 'clear', horizonMonths: 6 }, 4);
  const rainShare = summarize(rain, model);
  const clearShare = summarize(clear, model);
  const rainCells = new Set(model.cells.slice(0, 1).map((c) => c.cellId));
  let rainOnWetCell = 0;
  for (const p of rain) if (rainCells.has(p.cellId)) rainOnWetCell += 1;
  assert.ok(rainOnWetCell / Math.max(1, rainShare.total) > 0.7, String(rainOnWetCell / rainShare.total));
  assert.ok(clearShare.total < rainShare.total);
});

test('a scenario with no historical match projects nothing', () => {
  assert.deepEqual(runSimulation(model, bbox, { weather: 'fog', horizonMonths: 1 }, 1), []);
});

test('the summary buckets every point exactly once', () => {
  const points = runSimulation(model, bbox, { horizonMonths: 6 }, 5);
  const summary = summarize(points, model);
  assert.equal(summary.total, points.length);
  assert.equal(summary.fatal + summary.serious + summary.slight, points.length);
  assert.ok(summary.topCells.length > 0);
  for (const c of summary.topCells) assert.ok(c.count > 0);
});
