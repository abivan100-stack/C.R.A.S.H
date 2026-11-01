/* PDF data + intervention model tests (issue #13). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_WINDOW_MONTHS } from './constants.ts';
import { precompute } from './engine.ts';
import type { AccidentRecord } from './engine.ts';
import { authorityFor, pickIntervention, preventable } from './interventions.ts';
import { cityReportData, zoneReportData } from './reportData.ts';
import { asciiSafe } from '../lib/pdf.ts';

function rec(overrides: Partial<AccidentRecord> = {}): AccidentRecord {
  return {
    lat: 13.05, lng: 80.23, severity: 'fatal', datetime: '2025-06-10 09:30',
    weather: 'rain', cause: 'Over-speeding', vehicle: 'Car', area: 'Adyar', ...overrides,
  };
}

const records: AccidentRecord[] = [
  rec(),
  rec({ severity: 'serious', area: 'Porur', cause: 'Hit and run', datetime: '2025-06-14 21:00' }),
  rec({ severity: 'slight', area: 'Adyar', cause: 'Over-speeding', datetime: '2025-06-15 12:00', weather: 'clear' }),
];
precompute(records, MAX_WINDOW_MONTHS);
const city = cityReportData(records, 24, { min: 24600, max: 24601, count: 24 });

test('city export numbers are the same as the on-screen aggregates', () => {
  assert.equal(city.total, 3);
  assert.deepEqual(city.sev, { fatal: 1, serious: 1, slight: 1 });
  assert.equal(Object.values(city.cause).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(city.veh).reduce((a, b) => a + b, 0), 3);
  assert.equal(city.top.length, 1); // both Adyar/Port records share a cell only when close
});

test('the intervention queue is ranked and never overstates preventable harm', () => {
  for (const row of city.queue) {
    assert.ok(row.prevent <= row.fatal + row.serious);
    if (row.prevent < 0) throw new Error('negative preventable');
  }
  for (let i = 1; i < city.queue.length; i += 1) {
    assert.ok((city.queue[i - 1] as { prevent: number }).prevent >= (city.queue[i] as { prevent: number }).prevent);
  }
});

test('preventable rounds down and clamps to the severe count', () => {
  assert.equal(preventable(10, 0, 0.35), 3);
  assert.equal(preventable(0, 0, 0.9), 0);
  assert.equal(preventable(1, 1, 0.99), 1);
  assert.equal(preventable(2, 0, 5), 2);
});

test('interventions follow cause, night share and the safe fallback', () => {
  assert.match(pickIntervention('Over-speeding').fix, /Speed humps/);
  assert.match(pickIntervention('Hit and run').fix, /CCTV/);
  assert.match(pickIntervention('Poor visibility', 0.9).fix, /CCTV/);
  assert.equal(pickIntervention('constructor').fix, 'Junction redesign and signage review');
  assert.equal(pickIntervention('__proto__').cost, 'High');
});

test('authority mapping is own-property only', () => {
  assert.equal(authorityFor('Pothole / bad road').name, 'Greater Chennai Corporation');
  assert.equal(authorityFor('Hit and run').name, 'Tamil Nadu Police');
  assert.equal(authorityFor('constructor').name, 'Greater Chennai Traffic Police');
});

test('zone data reconciles its splits', () => {
  const zone = zoneReportData(records);
  assert.equal(zone.total, 3);
  assert.equal(zone.sev.fatal + zone.sev.serious + zone.sev.slight, 3);
  assert.equal(zone.weather.clear + zone.weather.rain + zone.weather.fog, 3);
  assert.equal(zone.hour.reduce((a, b) => a + b, 0), 3);
  assert.equal(zone.dow.reduce((a, b) => a + b, 0), 3);
  assert.ok(zone.peakHour >= 0 && zone.peakHour < 24);
  assert.equal(zone.preventable <= zone.sev.fatal + zone.sev.serious, true);
});

test('the PDF sanitiser maps every non-ASCII mark to ASCII', () => {
  assert.equal(asciiSafe('a ≈ b — c – d “e” ‘f’ × g · h °'), "a ~ b - c - d \"e\" 'f' x g - h ");
  assert.equal(asciiSafe('Adyar'), 'Adyar');
  assert.equal(asciiSafe('தமிழ்'), '');
});
