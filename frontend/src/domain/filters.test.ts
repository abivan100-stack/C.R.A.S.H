/* Live filter tests (issue #14). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_FILTERS, activeFilterCount, filterNote, filterRecords, sanitizeFilters } from './filters.ts';
import type { AccidentRecord } from './engine.ts';

function rec(overrides: Partial<AccidentRecord> = {}): AccidentRecord {
  return {
    lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-10 09:30',
    weather: 'rain', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar',
    _h: 9, _night: false, _dow: 1, _ym: 24600, _month: 0, ...overrides,
  };
}

const records = [
  rec(),
  rec({ severity: 'slight', citizen: true, weather: 'clear', cause: 'Hit and run', _dow: 5, _night: true, _h: 20, datetime: '2025-06-14 20:00' }),
  rec({ severity: 'serious', _dow: 0, weather: 'fog', cause: 'Signal jumping', _night: true, _h: 21, datetime: '2025-06-10 21:00' }),
];

test('the default filters keep every record', () => {
  assert.equal(filterRecords(records, DEFAULT_FILTERS).length, 3);
  assert.equal(activeFilterCount(DEFAULT_FILTERS), 0);
});

test('each dimension filters independently', () => {
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, source: 'citizen' }).length, 1);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, source: 'official' }).length, 2);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, sev: 'fs' }).length, 2);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, sev: 'f' }).length, 1);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, time: 'night' }).length, 2);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, time: 'day' }).length, 1);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, weather: 'fog' }).length, 1);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, dow: 5 }).length, 1);
  assert.equal(filterRecords(records, { ...DEFAULT_FILTERS, cause: 'Signal jumping' }).length, 1);
});

test('dimensions compose', () => {
  const filtered = filterRecords(records, { ...DEFAULT_FILTERS, time: 'night', sev: 'fs', weather: 'fog' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.cause, 'Signal jumping');
  assert.equal(activeFilterCount({ ...DEFAULT_FILTERS, time: 'night', sev: 'fs', weather: 'fog' }), 3);
});

test('hostile persisted filters are neutralised, not applied', () => {
  const bad = sanitizeFilters({ cause: '__proto__' as never, weather: 'snow' as never, dow: 99, sev: 'x' as never });
  assert.deepEqual(bad, DEFAULT_FILTERS);
  const ok = sanitizeFilters({ cause: 'Hit and run', weather: 'rain', dow: 2 });
  assert.equal(ok.cause, 'Hit and run');
  assert.equal(ok.weather, 'rain');
  assert.equal(ok.dow, 2);
});

test('the filter note reports the visible count', () => {
  assert.match(filterNote(DEFAULT_FILTERS, 900, 1000), /900 of 1,000/);
  assert.match(filterNote({ ...DEFAULT_FILTERS, sev: 'f' }, 12, 1000), /12 of 1,000 incidents match/);
});
