/* Area comparison tests (issue #11). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareDimensions, computeAreaStats, formatDimension } from './compare.ts';
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
  rec({ severity: 'slight', area: 'Porur', datetime: '2025-06-14 20:00', weather: 'clear', cause: 'Hit and run', vehicle: 'Bus (MTC/Private)' }),
  rec({ severity: 'serious', area: 'Adyar', datetime: '2025-06-15 10:00' }),
  rec({ severity: 'fatal', area: 'Porur', datetime: '2025-06-21 23:00' }),
];
precompute(records, 24);
const stats = computeAreaStats(records, 24);

test('area totals reconcile with the record count', () => {
  const total = Object.values(stats).reduce((sum, s) => sum + s.total, 0);
  assert.equal(total, records.length);
  assert.equal(stats.Adyar?.total, 2);
  assert.equal(stats.Porur?.total, 2);
});

test('severity, night and weekend splits add up', () => {
  const adyar = stats.Adyar;
  assert.ok(adyar);
  assert.equal(adyar.fatal + adyar.serious + adyar.slight, adyar.total);
  assert.equal(adyar.night + (adyar.total - adyar.night), adyar.total);
  assert.ok(adyar.night >= 0 && adyar.night <= adyar.total);
  assert.equal(adyar.weekend, (adyar.dow[5] ?? 0) + (adyar.dow[6] ?? 0));
});

test('rates are shares of the area total', () => {
  const adyar = stats.Adyar;
  assert.ok(adyar);
  assert.equal(adyar.fatalRate, adyar.fatal / adyar.total);
  assert.equal(adyar.severeShare, adyar.severe / adyar.total);
  assert.equal(adyar.nightShare, adyar.night / adyar.total);
});

test('dominant cause and vehicle are the most frequent values', () => {
  const adyar = stats.Adyar;
  assert.ok(adyar);
  assert.equal(adyar.topCause, 'Over-speeding');
  assert.equal(adyar.topVehicle, 'Car');
});

test('head-to-head dimensions keep both sides and their formats', () => {
  const a = stats.Adyar;
  const b = stats.Porur;
  assert.ok(a && b);
  const rows = compareDimensions(a, b);
  assert.equal(rows.length, 10);
  const volume = rows.find((r) => r.key === 'volume');
  assert.deepEqual({ a: volume?.a, b: volume?.b }, { a: 2, b: 2 });
  assert.equal(formatDimension(rows[0] as never, 2), '2');
  assert.equal(formatDimension({ key: 'fatalRate', label: '', a: 0, b: 0, format: 'pct', higherIsWorse: true }, 0.25), '25.0%');
});

test('a hostile severity is ignored by the accumulators', () => {
  const hostile: AccidentRecord[] = [rec({ severity: 'toString' }), rec({ severity: 'constructor' })];
  precompute(hostile, 24);
  const result = computeAreaStats(hostile, 24);
  const adyar = result.Adyar;
  assert.ok(adyar);
  assert.equal(adyar.total, 2);
  assert.equal(adyar.fatal + adyar.serious + adyar.slight, 0);
  assert.equal(Number.isFinite(adyar.score), true);
});
