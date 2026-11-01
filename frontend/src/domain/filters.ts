/* Live map filters: source, severity, time of day, weather, weekday and cause.
   The same field semantics as app.js's filterRecords(). */

import { isCause, type Cause, type Weather } from './constants.ts';
import type { AccidentRecord } from './engine.ts';
import { isNight } from '../lib/utils.ts';

export interface MapFilters {
  source: 'all' | 'official' | 'citizen';
  sev: 'all' | 'fs' | 'f';
  time: 'all' | 'day' | 'night';
  weather: 'all' | Weather;
  dow: 'all' | number;
  cause: 'all' | Cause;
}

export const DEFAULT_FILTERS: MapFilters = Object.freeze({
  source: 'all',
  sev: 'all',
  time: 'all',
  weather: 'all',
  dow: 'all',
  cause: 'all',
});

export function filterRecords(records: readonly AccidentRecord[], f: MapFilters): AccidentRecord[] {
  return records.filter((a) => {
    if (f.source === 'citizen' && !a.citizen) return false;
    if (f.source === 'official' && a.citizen) return false;
    if (f.sev === 'fs' && a.severity !== 'fatal' && a.severity !== 'serious') return false;
    if (f.sev === 'f' && a.severity !== 'fatal') return false;
    if (f.time === 'night' && !isNight(a.datetime)) return false;
    if (f.time === 'day' && isNight(a.datetime)) return false;
    if (f.weather !== 'all' && a.weather !== f.weather) return false;
    if (f.dow !== 'all' && a._dow !== f.dow) return false;
    if (f.cause !== 'all' && a.cause !== f.cause) return false;
    return true;
  });
}

/** Number of dimensions that differ from the defaults (the filter badge). */
export function activeFilterCount(f: MapFilters): number {
  let n = 0;
  if (f.source !== 'all') n += 1;
  if (f.sev !== 'all') n += 1;
  if (f.time !== 'all') n += 1;
  if (f.weather !== 'all') n += 1;
  if (f.dow !== 'all') n += 1;
  if (f.cause !== 'all') n += 1;
  return n;
}

export function filterNote(f: MapFilters, shown: number, total: number): string {
  if (activeFilterCount(f) === 0) return `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} incidents`;
  return `${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} incidents match`;
}

/** Keep a hostile/persisted cause value from becoming an active filter. */
export function sanitizeFilters(raw: Partial<MapFilters>): MapFilters {
  const cause = typeof raw.cause === 'string' && isCause(raw.cause) ? raw.cause : 'all';
  const weather = raw.weather === 'clear' || raw.weather === 'rain' || raw.weather === 'fog' ? raw.weather : 'all';
  const dow = typeof raw.dow === 'number' && raw.dow >= 0 && raw.dow <= 6 ? raw.dow : 'all';
  return {
    source: raw.source === 'official' || raw.source === 'citizen' ? raw.source : 'all',
    sev: raw.sev === 'fs' || raw.sev === 'f' ? raw.sev : 'all',
    time: raw.time === 'day' || raw.time === 'night' ? raw.time : 'all',
    weather,
    dow,
    cause,
  };
}
