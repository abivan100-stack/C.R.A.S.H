/* Analytics aggregation tests (issue #10). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregate, paretoSeries } from './analytics.ts';
import { MAX_WINDOW_MONTHS } from './constants.ts';
import { precompute } from './engine.ts';
import type { AccidentRecord } from './engine.ts';

function rec(overrides: Partial<AccidentRecord> = {}): AccidentRecord {
  return {
    lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-10 09:30',
    weather: 'rain', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar', ...overrides,
  };
}

const records: AccidentRecord[] = [
  rec(),
  rec({ severity: 'serious', area: 'Porur', cause: 'Hit and run', vehicle: 'Bus (MTC/Private)', datetime: '2025-06-10 21:00', weather: 'clear' }),
  rec({ severity: 'slight', area: 'Adyar', datetime: '2025-07-01 12:00', weather: 'clear', cause: 'Over-speeding' }),
];
precompute(records, MAX_WINDOW_MONTHS);
const agg = aggregate(records, 2);

test('severity totals reconcile with the record count', () => {
  assert.equal(agg.total, 3);
  assert.deepEqual(agg.sev, { fatal: 1, serious: 1, slight: 1 });
  assert.equal(agg.sev.fatal + agg.sev.serious + agg.sev.slight, agg.total);
});

test('every dimension covers the whole dataset', () => {
  assert.equal(Object.values(agg.cause).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(agg.veh).reduce((a, b) => a + b, 0), 3);
  assert.equal(agg.weather.clear + agg.weather.rain + agg.weather.fog, 3);
  assert.equal(agg.hour.reduce((a, b) => a + b, 0), 3);
  assert.equal(agg.dow.reduce((a, b) => a + b, 0), 3);
  assert.equal(agg.heat.flat().reduce((a, b) => a + b, 0), 3);
});

test('weather severity splits match the weather mix', () => {
  for (const w of ['clear', 'rain', 'fog'] as const) {
    const split = agg.wsev[w];
    assert.equal(split.fatal + split.serious + split.slight, agg.weather[w]);
  }
  assert.equal(agg.weather.fatal + agg.weather.serious + agg.weather.slight, 3);
});

test('the causality vocabulary is pre-seeded with zeroes', () => {
  assert.equal(Object.keys(agg.cause).length >= 11, true);
  assert.equal(agg.cause['Hit and run'], 1);
  assert.equal(agg.cause['Wrong-side driving'], 0);
});

test('leverage uses fatal plus serious over the top ten cells', () => {
  assert.equal(agg.sevCity, 2);
  assert.equal(agg.sevTop <= agg.sevCity, true);
  assert.equal(agg.leveragePct, Math.round((100 * agg.sevTop) / agg.sevCity));
});

test('the pareto cumulative curve ends at or below 100 percent', () => {
  const series = paretoSeries(agg);
  assert.equal(series.severe.length, series.cumulative.length);
  const last = series.cumulative[series.cumulative.length - 1] ?? 0;
  assert.ok(last <= 100.0001, String(last));
  assert.ok(last > 0);
});

test('an empty dataset aggregates to zeroes without throwing', () => {
  const empty = aggregate([], 1);
  assert.equal(empty.total, 0);
  assert.equal(empty.leveragePct, 0);
  assert.equal(empty.avgPerMonth, 0);
  assert.equal(paretoSeries(empty).labels.length, 0);
});

test('an unknown severity cannot poison the severity buckets', () => {
  const hostile: AccidentRecord[] = [
    rec({ severity: 'toString' }),
    rec({ severity: 'constructor' }),
    rec({ severity: 'fatal' }),
  ];
  precompute(hostile, MAX_WINDOW_MONTHS);
  const result = aggregate(hostile, 1);
  assert.deepEqual(result.sev, { fatal: 1, serious: 0, slight: 0 });
  assert.equal(Number.isFinite(result.sevCity), true);
});
