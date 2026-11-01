/* =============================================================================
   C.R.A.S.H Bot contract: the model translates a question into a filter object;
   the code applies that object and counts. No number ever comes from the model.
   The filter object is validated against the same fixed vocabularies the
   backend enforces, so an invalid or hostile response degrades to null.
   ========================================================================== */

import {
  isArea,
  isCause,
  isSeverity,
  isVehicle,
  isWeather,
  type Area,
  type Cause,
  type Severity,
  type Vehicle,
  type Weather,
} from './constants.ts';
import type { AccidentRecord } from './engine.ts';
import { isNight } from '../lib/utils.ts';

export type TimeOfDay = 'day' | 'night';

export interface BotFilters {
  area: Area | null;
  severity: Severity | null;
  timeOfDay: TimeOfDay | null;
  weather: Weather | null;
  cause: Cause | null;
  vehicle: Vehicle | null;
}

export const EMPTY_FILTERS: BotFilters = Object.freeze({
  area: null,
  severity: null,
  timeOfDay: null,
  weather: null,
  cause: null,
  vehicle: null,
});

const FILTER_KEYS = ['area', 'severity', 'timeOfDay', 'weather', 'cause', 'vehicle'] as const;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Accept only values from the fixed vocabularies; anything else becomes null. */
export function cleanFilters(raw: unknown): BotFilters {
  const f = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const area = stringOrNull(f.area);
  const severity = stringOrNull(f.severity);
  const weather = stringOrNull(f.weather);
  const cause = stringOrNull(f.cause);
  const vehicle = stringOrNull(f.vehicle);
  const time = stringOrNull(f.timeOfDay);
  return {
    area: isArea(area) ? area : null,
    severity: isSeverity(severity) ? severity : null,
    timeOfDay: time === 'day' || time === 'night' ? time : null,
    weather: isWeather(weather) ? weather : null,
    cause: isCause(cause) ? cause : null,
    vehicle: isVehicle(vehicle) ? vehicle : null,
  };
}

/** Every declared key must be either a valid value or null; returns null if any
    key is present but invalid, so a malformed response cannot look "clean". */
export function parseBotFilters(raw: unknown): BotFilters | null {
  if (raw == null) return EMPTY_FILTERS;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some((k) => !(FILTER_KEYS as readonly string[]).includes(k))) return null;
  const cleaned = cleanFilters(record);
  for (const key of FILTER_KEYS) {
    const value = record[key];
    if (value == null) continue;
    if (typeof value !== 'string' || cleaned[key] === null) return null;
  }
  return cleaned;
}

export function hasActiveFilter(f: BotFilters): boolean {
  return Boolean(f.area || f.severity || f.timeOfDay || f.weather || f.cause || f.vehicle);
}

/** Same field semantics as the home map's filterRecords(). */
export function filterRecords(records: readonly AccidentRecord[], f: BotFilters): AccidentRecord[] {
  return records.filter((a) => {
    if (f.area && a.area !== f.area) return false;
    if (f.severity && a.severity !== f.severity) return false;
    if (f.timeOfDay === 'day' && isNight(a.datetime)) return false;
    if (f.timeOfDay === 'night' && !isNight(a.datetime)) return false;
    if (f.weather && a.weather !== f.weather) return false;
    if (f.cause && a.cause !== f.cause) return false;
    if (f.vehicle && a.vehicle !== f.vehicle) return false;
    return true;
  });
}

export function filterSummary(f: BotFilters): string {
  const parts: string[] = [];
  if (f.severity) parts.push(f.severity);
  parts.push('accidents');
  if (f.area) parts.push(`in ${f.area}`);
  if (f.vehicle) parts.push(`involving a ${f.vehicle}`);
  if (f.cause) parts.push(`caused by ${f.cause}`);
  if (f.weather) parts.push(`in ${f.weather}`);
  if (f.timeOfDay) parts.push(`at ${f.timeOfDay}`);
  return parts.join(' ');
}

function topKey(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = -1;
  for (const key of Object.keys(counts)) {
    const value = counts[key] ?? 0;
    if (value > bestCount) {
      bestCount = value;
      best = key;
    }
  }
  return best;
}

function descending(counts: Record<string, number>): string {
  return Object.keys(counts)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))
    .map((k) => `${k} ${counts[k]}`)
    .join(', ');
}

export interface AreaDigest {
  total: number;
  fatal: number;
  serious: number;
  slight: number;
  day: number;
  night: number;
  clear: number;
  rain: number;
  fog: number;
  cause: Record<string, number>;
  vehicle: Record<string, number>;
  latSum: number;
  lngSum: number;
  geoN: number;
}

/** Statistical digest sent alongside the question. Deterministic, data-only. */
export function buildDigest(records: readonly AccidentRecord[]): string {
  const totals = { total: records.length, fatal: 0, serious: 0, slight: 0, day: 0, night: 0, clear: 0, rain: 0, fog: 0 };
  const byArea: Record<string, AreaDigest> = Object.create(null) as Record<string, AreaDigest>;
  const byCause: Record<string, number> = Object.create(null) as Record<string, number>;
  const byVehicle: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const a of records) {
    if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') totals[a.severity] += 1;
    if (isNight(a.datetime)) totals.night += 1;
    else totals.day += 1;
    if (a.weather === 'rain') totals.rain += 1;
    else if (a.weather === 'fog') totals.fog += 1;
    else totals.clear += 1;
    if (a.cause) byCause[a.cause] = (byCause[a.cause] ?? 0) + 1;
    if (a.vehicle) byVehicle[a.vehicle] = (byVehicle[a.vehicle] ?? 0) + 1;

    const area = byArea[a.area] ?? (byArea[a.area] = {
      total: 0, fatal: 0, serious: 0, slight: 0, day: 0, night: 0,
      clear: 0, rain: 0, fog: 0,
      cause: Object.create(null) as Record<string, number>,
      vehicle: Object.create(null) as Record<string, number>,
      latSum: 0, lngSum: 0, geoN: 0,
    });
    area.total += 1;
    if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') area[a.severity] += 1;
    if (Number.isFinite(a.lat) && Number.isFinite(a.lng)) {
      area.latSum += a.lat;
      area.lngSum += a.lng;
      area.geoN += 1;
    }
    if (isNight(a.datetime)) area.night += 1;
    else area.day += 1;
    if (a.weather === 'rain') area.rain += 1;
    else if (a.weather === 'fog') area.fog += 1;
    else area.clear += 1;
    if (a.cause) area.cause[a.cause] = (area.cause[a.cause] ?? 0) + 1;
    if (a.vehicle) area.vehicle[a.vehicle] = (area.vehicle[a.vehicle] ?? 0) + 1;
  }

  const lines: string[] = [];
  lines.push(`Chennai road-accident dataset: ${totals.total} recorded accidents (period Jul 2024 to Jun 2026).`);
  lines.push(`Severity totals: ${totals.fatal} fatal, ${totals.serious} serious, ${totals.slight} slight.`);
  lines.push(`Time of day: ${totals.day} day (06:00-18:00), ${totals.night} night (18:00-06:00).`);
  lines.push(`Weather: ${totals.clear} clear, ${totals.rain} rain, ${totals.fog} fog.`);
  lines.push(`By cause (desc): ${descending(byCause)}.`);
  lines.push(`By vehicle (desc): ${descending(byVehicle)}.`);
  lines.push('');
  lines.push('Per-area breakdown - columns: AREA | total | fatal/serious/slight | day/night | clear/rain/fog | top cause | top vehicle');
  for (const name of Object.keys(byArea).sort((a, b) => (byArea[b]?.total ?? 0) - (byArea[a]?.total ?? 0))) {
    const r = byArea[name] as AreaDigest;
    lines.push(`${name} | ${r.total} | ${r.fatal}/${r.serious}/${r.slight} | ${r.day}/${r.night} | ${r.clear}/${r.rain}/${r.fog} | ${topKey(r.cause) ?? '-'} | ${topKey(r.vehicle) ?? '-'}`);
  }
  return lines.join('\n');
}

export interface BotAnswer {
  answer: string;
  filters: BotFilters | null;
}

export const BOT_EXAMPLES = Object.freeze([
  'Which area has the most fatal accidents?',
  'Safest areas in Chennai?',
  'Compare Adyar and Velachery',
  'What causes most crashes?',
]);

export const BOT_UNAVAILABLE = 'C.R.A.S.H Bot is unavailable right now - try the example questions or the filters.';

export function apiAnswerUrl(): string {
  return `${(window as unknown as { API_BASE?: string }).API_BASE ?? ''}/ask`;
}
