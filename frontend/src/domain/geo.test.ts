/* Geo helpers (area centroids, nearest area, distances). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { areaCentroids, haversineKm, metersBetween, nearestArea, uniqueAreas } from './geo.ts';
import type { AccidentRecord } from './engine.ts';

function rec(lat: number, lng: number, area: string): AccidentRecord {
  return { lat, lng, severity: 'slight', datetime: '2025-01-01 00:00', weather: 'clear', cause: 'Hit and run', vehicle: 'Car', area };
}

const records = [rec(13.0, 80.2, 'Adyar'), rec(13.2, 80.4, 'Adyar'), rec(12.9, 80.0, 'Porur')];

test('centroids average the area records', () => {
  const centroids = areaCentroids(records);
  assert.ok(Math.abs((centroids.Adyar?.[0] ?? 0) - 13.1) < 1e-12);
  assert.ok(Math.abs((centroids.Adyar?.[1] ?? 0) - 80.3) < 1e-12);
  assert.ok(Math.abs((centroids.Porur?.[0] ?? 0) - 12.9) < 1e-12);
  assert.ok(Math.abs((centroids.Porur?.[1] ?? 0) - 80.0) < 1e-12);
  assert.deepEqual(uniqueAreas(records), ['Adyar', 'Porur']);
});

test('nearest area follows the closest record, not a centroid', () => {
  assert.equal(nearestArea(records, 12.91, 80.01), 'Porur');
  assert.equal(nearestArea(records, 13.19, 80.39), 'Adyar');
  assert.equal(nearestArea([], 13, 80), null);
});

test('distance helpers agree at small scales', () => {
  /* 0.001 degrees of latitude is ~111 m */
  const metres = metersBetween(13.0, 80.2, 13.001, 80.2);
  assert.ok(Math.abs(metres - 111.32) < 0.5, String(metres));
  const km = haversineKm(13.0, 80.2, 13.001, 80.2);
  assert.ok(Math.abs(km - 0.111) < 0.001, String(km));
});
