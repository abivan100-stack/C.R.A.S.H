/* Bot contract tests (issue #9): filters are validated, counts are code-side. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BOT_EXAMPLES,
  EMPTY_FILTERS,
  buildDigest,
  cleanFilters,
  filterRecords,
  filterSummary,
  hasActiveFilter,
  parseBotFilters,
} from './bot.ts';
import type { AccidentRecord } from './engine.ts';

function rec(overrides: Partial<AccidentRecord> = {}): AccidentRecord {
  return {
    lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-10 09:30',
    weather: 'rain', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar', ...overrides,
  };
}

const records = [
  rec(),
  rec({ severity: 'slight', cause: 'Hit and run', vehicle: 'Bus (MTC/Private)', area: 'Porur', datetime: '2025-06-10 21:00' }),
  rec({ severity: 'serious', area: 'Adyar', datetime: '2025-07-01 12:00', weather: 'clear', cause: 'Over-speeding' }),
];

test('valid filter objects pass through untouched', () => {
  const filters = { area: 'Adyar', severity: 'fatal', timeOfDay: 'night', weather: 'rain', cause: 'Over-speeding', vehicle: 'Car' };
  assert.deepEqual(parseBotFilters(filters), filters);
});

test('a missing filter object means no filter', () => {
  assert.deepEqual(parseBotFilters(null), EMPTY_FILTERS);
  assert.deepEqual(parseBotFilters(undefined), EMPTY_FILTERS);
});

test('invalid values are rejected, not silently dropped', () => {
  for (const bad of [
    { area: 'Atlantis' },
    { severity: 'toString' },
    { severity: 'Fatal' },
    { timeOfDay: 'evening' },
    { weather: 'snow' },
    { cause: '__proto__' },
    { vehicle: 'constructor' },
    { area: 42 },
    { unknownKey: 'x' },
    'not an object',
    [],
  ]) {
    assert.equal(parseBotFilters(bad), null, JSON.stringify(bad));
  }
});

test('cleanFilters keeps only vocabulary values', () => {
  const cleaned = cleanFilters({ severity: 'constructor', area: 'Adyar', timeOfDay: 'night' } as unknown);
  assert.equal(cleaned.severity, null);
  assert.equal(cleaned.area, 'Adyar');
  assert.equal(cleaned.timeOfDay, 'night');
});

test('counts are computed code-side from the applied filters', () => {
  const filters = cleanFilters({ area: 'Adyar' });
  assert.equal(filterRecords(records, filters).length, 2);
  const night = cleanFilters({ timeOfDay: 'night' });
  assert.equal(filterRecords(records, night).length, 1);
  assert.equal(filterRecords(records, cleanFilters({ severity: 'serious', area: 'Adyar' })).length, 1);
});

test('empty filters keep every record and are not "active"', () => {
  assert.equal(filterRecords(records, EMPTY_FILTERS).length, records.length);
  assert.equal(hasActiveFilter(EMPTY_FILTERS), false);
  assert.equal(hasActiveFilter(cleanFilters({ area: 'Adyar' })), true);
});

test('the summary names the applied dimensions', () => {
  assert.equal(filterSummary(cleanFilters({ severity: 'fatal', area: 'Adyar', timeOfDay: 'night' })), 'fatal accidents in Adyar at night');
});

test('the digest is deterministic and data-only', () => {
  const digest = buildDigest(records);
  assert.match(digest, /^Chennai road-accident dataset: 3 recorded accidents/);
  assert.match(digest, /Severity totals: 1 fatal, 1 serious, 1 slight\./);
  assert.match(digest, /Adyar \| 2 \| 1\/1\/0 \| 2\/0 \| 1\/1\/0 \| Over-speeding \| Car/);
  assert.equal(buildDigest(records), digest);
});

test('example questions stay available', () => {
  assert.ok(BOT_EXAMPLES.length >= 4);
});
