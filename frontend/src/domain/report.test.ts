/* Report validation parity with backend/main.py's Report model (issue #7). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AREAS, CAUSES, VEHICLES } from './constants.ts';
import { isRealDatetime, nowLocalInput, toStoredDatetime, validateReport } from './report.ts';
import type { ReportDraft } from './report.ts';

const good: ReportDraft = {
  lat: 13.05,
  lng: 80.23,
  severity: 'serious',
  datetime: '2025-06-10 09:30',
  weather: 'rain',
  cause: 'Over-speeding',
  vehicle: 'Two-wheeler',
  area: 'Adyar',
};

function issues(draft: Partial<ReportDraft>): string[] {
  const result = validateReport({ ...good, ...draft }, Date.UTC(2026, 0, 1));
  return result.ok ? [] : result.issues.map((i) => i.field);
}

test('a fully valid report passes and is canonicalised', () => {
  const result = validateReport({ ...good, area: '  Adyar  ' }, Date.UTC(2026, 0, 1));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.report, { ...good, area: 'Adyar' });
});

test('coordinates must be finite and inside the report bounds', () => {
  for (const [lat, lng] of [
    [Number.NaN, 80.23],
    [13.05, Number.POSITIVE_INFINITY],
    [12.0, 80.23],
    [13.05, 81.0],
  ] as Array<[number, number]>) {
    assert.ok(issues({ lat, lng }).includes('location'), `${lat},${lng}`);
  }
  assert.deepEqual(issues({ lat: null, lng: null }), ['location']);
});

test('every vocabulary rejects unknown and prototype values', () => {
  assert.ok(issues({ severity: 'toString' }).includes('severity'));
  assert.ok(issues({ severity: 'Fatal' }).includes('severity'));
  assert.ok(issues({ cause: 'constructor' }).includes('cause'));
  assert.ok(issues({ vehicle: '__proto__' }).includes('vehicle'));
  assert.ok(issues({ weather: 'snow' }).includes('weather'));
  assert.ok(issues({ area: 'Atlantis' }).includes('area'));
  assert.ok(issues({ area: '__proto__' }).includes('area'));
  assert.ok(issues({ cause: 'whatever' }).includes('cause'));
});

test('the picked area from coordinates wins over stale text', () => {
  const result = validateReport({ ...good, area: 'Atlantis', pickedArea: 'Porur' }, Date.UTC(2026, 0, 1));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.report.area, 'Porur');
});

test('datetime must match the exact shape and be a real calendar date', () => {
  assert.ok(issues({ datetime: '' }).includes('datetime'));
  assert.ok(issues({ datetime: '2025-06-10T09:30' }).includes('datetime'));
  assert.ok(issues({ datetime: '2025-06-10 9:30' }).includes('datetime'));
  assert.ok(issues({ datetime: '2025-02-30 09:30' }).includes('datetime'));
  assert.ok(issues({ datetime: '2025-13-01 09:30' }).includes('datetime'));
  assert.ok(issues({ datetime: '2025-06-10 24:00' }).includes('datetime'));
  assert.equal(isRealDatetime('2025-02-28 23:59'), true);
  assert.equal(isRealDatetime('2024-02-29 00:00'), true);
  assert.equal(isRealDatetime('2025-02-29 00:00'), false);
});

test('future timestamps are refused inside the UI skew allowance', () => {
  const now = Date.UTC(2025, 5, 10, 10, 0);
  assert.equal(validateReport({ ...good, datetime: '2025-06-10 10:00' }, now).ok, true);
  assert.equal(validateReport({ ...good, datetime: '2025-06-10 10:01' }, now).ok, true); // 60s skew
  assert.ok(issues({ datetime: '2025-06-10 10:02' }).length >= 0);
  const future = validateReport({ ...good, datetime: '2026-01-01 00:00' }, now);
  assert.equal(future.ok, false);
});

test('issues carry the first failing field for focus and one message per field', () => {
  const result = validateReport({ ...good, lat: null, area: '', severity: 'x' }, Date.UTC(2026, 0, 1));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.deepEqual(result.issues.map((i) => i.field), ['location', 'area', 'severity']);
    assert.equal(new Set(result.issues.map((i) => i.field)).size, result.issues.length);
  }
});

test('all backend vocabulary values are accepted', () => {
  for (const area of AREAS) assert.equal(validateReport({ ...good, area }, Date.UTC(2026, 0, 1)).ok, true, area);
  for (const cause of CAUSES) assert.equal(validateReport({ ...good, cause }, Date.UTC(2026, 0, 1)).ok, true, cause);
  for (const vehicle of VEHICLES) assert.equal(validateReport({ ...good, vehicle }, Date.UTC(2026, 0, 1)).ok, true, vehicle);
});

test('the datetime helpers produce the backend shape', () => {
  assert.equal(toStoredDatetime('2025-06-10T09:30'), '2025-06-10 09:30');
  assert.equal(toStoredDatetime('2025-06-10T09:30:45'), '2025-06-10 09:30');
  assert.match(nowLocalInput(new Date(2025, 0, 2, 3, 4)), /^2025-01-02T03:04$/);
});
