/* Report storage boundary (issue #7): persistence, dedupe and shape guards. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  CITIZEN_STORAGE_KEY,
  mergeCitizenReports,
  readLocalReports,
  reportSignature,
  writeLocalReports,
  type CitizenRecord,
} from './api.ts';

const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  configurable: true,
});

const base: CitizenRecord = {
  lat: 13.05,
  lng: 80.23,
  severity: 'serious',
  datetime: '2025-06-10 09:30',
  weather: 'rain',
  cause: 'Over-speeding',
  vehicle: 'Two-wheeler',
  area: 'Adyar',
  citizen: true,
};

beforeEach(() => store.clear());

test('an offline report persists and reads back', () => {
  writeLocalReports([base]);
  assert.ok(store.has(CITIZEN_STORAGE_KEY));
  const back = readLocalReports();
  assert.equal(back.length, 1);
  assert.deepEqual(
    { ...back[0], citizen: undefined },
    { ...base, citizen: undefined },
  );
});

test('malformed stored reports are dropped, not trusted', () => {
  store.set(CITIZEN_STORAGE_KEY, JSON.stringify([
    base,
    { lat: 'x', lng: 80.2 } as unknown as CitizenRecord,
    null,
    { ...base, datetime: 12345 } as unknown as CitizenRecord,
  ]));
  assert.equal(readLocalReports().length, 1);
  store.set(CITIZEN_STORAGE_KEY, 'not json');
  assert.deepEqual(readLocalReports(), []);
});

test('shared and local copies of the same report count once', () => {
  const shared: CitizenRecord = { ...base, id: 'm1', shared: true };
  const local: CitizenRecord = { ...base, id: 'c1' };
  const merged = mergeCitizenReports([shared], [local]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, 'm1');
  assert.equal(reportSignature(shared), reportSignature(local));
});

test('distinct reports all survive the merge, shared first', () => {
  const shared: CitizenRecord = { ...base, id: 'm1', shared: true };
  const local: CitizenRecord = { ...base, id: 'c1', lat: 13.06 };
  const merged = mergeCitizenReports([shared], [local]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0]?.shared, true);
});

test('the stored payload is exactly the eight backend fields', () => {
  writeLocalReports([base]);
  const stored = JSON.parse(store.get(CITIZEN_STORAGE_KEY) as string) as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(stored[0] ?? {}).sort(), ['area', 'cause', 'datetime', 'lat', 'lng', 'severity', 'vehicle', 'weather']);
});
