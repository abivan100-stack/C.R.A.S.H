/* Report data for the PDF exports: the same numbers the analytics page and a
   zone dossier show. Ported from report.js's cityData/zoneData. */

import {
  BBOX, CAUSES, CELL, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N, HIGH_RISK_MIN,
  MON, RECENT_MONTHS, SUPPRESS, TOP_N, VEHICLES,
} from './constants.ts';
import { computeEmerging, gridCells, topJunctions } from './engine.ts';
import type { AccidentRecord, EmergingList, GridCell } from './engine.ts';
import { isNight, sortedEntries } from '../lib/utils.ts';
import { pickIntervention, preventable, type Intervention } from './interventions.ts';

export interface QueueRow {
  area: string;
  dom: string;
  iv: Intervention;
  prevent: number;
  fatal: number;
  serious: number;
}

export interface CityReportData {
  total: number;
  monthCount: number;
  range: { min: number; max: number; count: number };
  sev: { fatal: number; serious: number; slight: number };
  cause: Record<string, number>;
  veh: Record<string, number>;
  top: GridCell[];
  highRisk: number;
  sevCity: number;
  sevTop: number;
  leveragePct: number;
  emerging: EmergingList;
  queue: QueueRow[];
}

export function cityReportData(records: readonly AccidentRecord[], monthCount: number, range: { min: number; max: number; count: number }): CityReportData {
  const sev = { fatal: 0, serious: 0, slight: 0 };
  const cause: Record<string, number> = Object.create(null) as Record<string, number>;
  const veh: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const a of records) {
    if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') sev[a.severity] += 1;
    cause[a.cause] = (cause[a.cause] ?? 0) + 1;
    veh[a.vehicle] = (veh[a.vehicle] ?? 0) + 1;
  }
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, monthCount);
  const top = topJunctions(cells, TOP_N, SUPPRESS);
  const sevCity = sev.fatal + sev.serious;
  let sevTop = 0;
  for (const c of top) sevTop += c.fatal + c.serious;
  const queue = top.map((c) => {
    const dom = sortedEntries(c.cause)[0]?.[0] ?? '-';
    const iv = pickIntervention(dom, c.night / c.count);
    return { area: c.area, dom, iv, prevent: preventable(c.fatal, c.serious, iv.eff), fatal: c.fatal, serious: c.serious };
  }).sort((a, b) => b.prevent - a.prevent);

  return {
    total: records.length,
    monthCount,
    range,
    sev,
    cause,
    veh,
    top,
    highRisk: cells.filter((c) => c.score >= HIGH_RISK_MIN).length,
    sevCity,
    sevTop,
    leveragePct: sevCity ? Math.round((100 * sevTop) / sevCity) : 0,
    emerging: computeEmerging(cells, RECENT_MONTHS, monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS),
    queue,
  };
}

export interface ZoneReportData {
  total: number;
  sev: { fatal: number; serious: number; slight: number };
  cause: Record<string, number>;
  veh: Record<string, number>;
  weather: { clear: number; rain: number; fog: number };
  hour: number[];
  dow: number[];
  night: number;
  domCause: string;
  iv: Intervention;
  preventable: number;
  peakHour: number;
  peakDow: number;
}

export function zoneReportData(records: readonly AccidentRecord[]): ZoneReportData {
  const sev = { fatal: 0, serious: 0, slight: 0 };
  const cause: Record<string, number> = Object.create(null) as Record<string, number>;
  const veh: Record<string, number> = Object.create(null) as Record<string, number>;
  const weather = { clear: 0, rain: 0, fog: 0 };
  const hour = new Array<number>(24).fill(0);
  const dow = new Array<number>(7).fill(0);
  let night = 0;
  for (const a of records) {
    if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') sev[a.severity] += 1;
    cause[a.cause] = (cause[a.cause] ?? 0) + 1;
    veh[a.vehicle] = (veh[a.vehicle] ?? 0) + 1;
    if (a.weather === 'clear' || a.weather === 'rain' || a.weather === 'fog') weather[a.weather] += 1;
    const h = a._h ?? 0;
    if (h >= 0 && h < 24) hour[h] = (hour[h] ?? 0) + 1;
    if (isNight(a.datetime)) night += 1;
    const d = a._dow ?? 0;
    if (d >= 0 && d < 7) dow[d] = (dow[d] ?? 0) + 1;
  }
  const domCause = sortedEntries(cause)[0]?.[0] ?? '-';
  const total = records.length || 1;
  const iv = pickIntervention(domCause, night / total);
  return {
    total: records.length,
    sev,
    cause,
    veh,
    weather,
    hour,
    dow,
    night,
    domCause,
    iv,
    preventable: preventable(sev.fatal, sev.serious, iv.eff),
    peakHour: hour.indexOf(Math.max(...hour)),
    peakDow: dow.indexOf(Math.max(...dow)),
  };
}

/** Months label for a printed date range. */
export function ymRange(range: { min: number; max: number }): string {
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return '-';
  const y0 = Math.floor(range.min / 12);
  const m0 = range.min % 12;
  const y1 = Math.floor(range.max / 12);
  const m1 = range.max % 12;
  return `${MON[m0]} ${y0} - ${MON[m1]} ${y1}`;
}

export const CAUSE_LIST = CAUSES;
export const VEHICLE_LIST = VEHICLES;
