/* Parity harness for the typed domain core (issue #4).

   Proves the TypeScript vocabularies accept and reject exactly what the legacy
   frontend constants and the backend validation accept and reject, so the two
   ends cannot drift apart during the migration. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import {
  AREAS,
  BBOX,
  CAUSES,
  CELL,
  CHART_COLORS,
  DOW,
  EMERGE_LIFT,
  EMERGE_MIN_RECENT,
  EMERGE_TOP_N,
  HIGH_RISK_MIN,
  MAX_WINDOW_MONTHS,
  MON,
  RECENT_MONTHS,
  REPORT_BOUNDS,
  SELECT_ZOOM,
  SEGMENTS,
  SEV,
  SEVERITIES,
  SUPPRESS,
  TOP_N,
  VEHICLES,
  WEATHERS,
  isArea,
  isCause,
  isSeverity,
  isVehicle,
  isWeather,
  sevOf,
} from './constants.ts';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(process.cwd());
const legacy = (require('../../../shared/constants.js') as { CRASH_CONSTANTS: Record<string, unknown> })
  .CRASH_CONSTANTS;

function backendList(source: string, name: string): string[] {
  const block = source.match(new RegExp(`^${name} = \\[([\\s\\S]*?)^\\]`, 'm'));
  assert.ok(block, `backend/main.py is missing the ${name} list`);
  return [...(block[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v): v is string => Boolean(v));
}

function backendSet(source: string, name: string): string[] {
  const block = source.match(new RegExp(`^${name} = frozenset\\(\\{([^}]*)\\}\\)`, 'm'));
  assert.ok(block, `backend/main.py is missing the ${name} set`);
  return [...(block[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v): v is string => Boolean(v)).sort();
}

test('vocabularies are identical to the legacy constants', () => {
  assert.equal(JSON.stringify(AREAS), JSON.stringify(legacy.AREAS));
  assert.equal(JSON.stringify(CAUSES), JSON.stringify(legacy.CAUSES));
  assert.equal(JSON.stringify(VEHICLES), JSON.stringify(legacy.VEHICLES));
  assert.equal(JSON.stringify(WEATHERS), JSON.stringify(legacy.WEATHERS));
  assert.equal(JSON.stringify(SEVERITIES), JSON.stringify(legacy.SEVERITIES));
});

test('severity descriptors keep every legacy field', () => {
  for (const key of SEVERITIES) {
    const typed = SEV[key];
    const old = (legacy.SEV as Record<string, Record<string, unknown>>)[key]!;
    assert.equal(typed.color, old.color);
    assert.equal(typed.label, old.label);
    assert.equal(typed.weight, old.weight);
    assert.equal(typed.c, old.c);
    assert.equal(typed.l, old.l);
    assert.equal(typed.w, old.w);
  }
});

test('tuning numbers and bounds match the legacy constants', () => {
  assert.deepEqual(BBOX, legacy.BBOX);
  assert.deepEqual(REPORT_BOUNDS, legacy.REPORT_BOUNDS);
  const numbers: Array<[number, unknown]> = [
    [CELL, legacy.CELL],
    [TOP_N, legacy.TOP_N],
    [SUPPRESS, legacy.SUPPRESS],
    [HIGH_RISK_MIN, legacy.HIGH_RISK_MIN],
    [SELECT_ZOOM, legacy.SELECT_ZOOM],
    [RECENT_MONTHS, legacy.RECENT_MONTHS],
    [MAX_WINDOW_MONTHS, legacy.MAX_WINDOW_MONTHS],
    [EMERGE_LIFT, legacy.EMERGE_LIFT],
    [EMERGE_MIN_RECENT, legacy.EMERGE_MIN_RECENT],
    [EMERGE_TOP_N, legacy.EMERGE_TOP_N],
  ];
  for (const [typed, old] of numbers) assert.equal(typed, old);
  assert.deepEqual(MON, legacy.MON);
  assert.deepEqual(DOW, legacy.DOW);
  assert.deepEqual(CHART_COLORS, legacy.CHART_COLORS);
});

test('segmented filter definitions match option for option', () => {
  const old = legacy.SEGMENTS as Record<string, { id: string; options: Array<[string, string | number]>; chips?: true }>;
  for (const key of Object.keys(SEGMENTS) as Array<keyof typeof SEGMENTS>) {
    const match = old[key]; assert.ok(match);
    assert.equal(SEGMENTS[key].chips, match.chips);
    assert.deepEqual(
      SEGMENTS[key].options.map((o) => [o.label, o.value]),
      match.options,
    );
  }
});

test('vocabularies are identical to backend validation', () => {
  const backend = readFileSync(path.join(repoRoot, 'backend', 'main.py'), 'utf8');
  assert.deepEqual([...AREAS], backendList(backend, 'AREAS'));
  assert.deepEqual([...CAUSES], backendList(backend, 'CAUSES'));
  assert.deepEqual([...VEHICLES], backendList(backend, 'VEHICLES'));
  assert.deepEqual([...WEATHERS].sort(), backendSet(backend, 'WEATHERS'));
  assert.deepEqual([...SEVERITIES].sort(), backendSet(backend, 'SEVERITIES'));
});

test('known values pass and prototype members never do', () => {
  for (const severity of SEVERITIES) assert.equal(isSeverity(severity), true);
  for (const probe of ['toString', 'constructor', '__proto__', 'hasOwnProperty', '', 'Fatal', null, 3, {}]) {
    assert.equal(isSeverity(probe), false, `isSeverity(${String(probe)}) must reject`);
    assert.equal(sevOf(probe), SEV.slight);
  }
  for (const area of AREAS) assert.equal(isArea(area), true);
  for (const cause of CAUSES) assert.equal(isCause(cause), true);
  for (const vehicle of VEHICLES) assert.equal(isVehicle(vehicle), true);
  for (const weather of WEATHERS) assert.equal(isWeather(weather), true);
  for (const guard of [isArea, isCause, isVehicle, isWeather]) {
    for (const probe of ['toString', '__proto__', 'constructor']) assert.equal(guard(probe), false);
  }
});

test('a rejected severity can never leak a non-number into arithmetic', () => {
  const probes = ['toString', 'constructor', '__proto__', undefined] as const;
  const total = probes.reduce((sum, probe) => sum + sevOf(probe).weight, 0);
  assert.equal(total, probes.length); // every probe falls back to the slight weight of 1
  assert.equal(Number.isFinite(total), true);
  assert.equal(sevOf('fatal').weight * 1 + sevOf('serious').weight * 1 + sevOf('slight').weight * 1, 6);
});

test('the exported constants are frozen', () => {
  for (const value of [SEV, SEVERITIES, AREAS, CAUSES, VEHICLES, WEATHERS, BBOX, REPORT_BOUNDS, SEGMENTS, MON, DOW, CHART_COLORS]) {
    assert.equal(Object.isFrozen(value), true);
  }
  for (const severity of SEVERITIES) assert.equal(Object.isFrozen(SEV[severity]), true);
});
