/* Area comparison: per-area statistics for any two Chennai areas, using the
   same accumulators the legacy compare page built. */

import { CAUSES, RECENT_MONTHS, VEHICLES, isSeverity, sevOf } from './constants.ts';
import type { AccidentRecord } from './engine.ts';

export interface AreaStats {
  area: string;
  total: number;
  fatal: number;
  serious: number;
  slight: number;
  severe: number;
  night: number;
  weekend: number;
  score: number;
  hour: number[];
  dow: number[];
  cause: Record<string, number>;
  vehicle: Record<string, number>;
  weather: { clear: number; rain: number; fog: number };
  month: number[];
  recent: number;
  baseline: number;
  fatalRate: number;
  severeShare: number;
  nightShare: number;
  weekendShare: number;
  lift: number;
  peakHour: number;
  peakDow: number;
  topCause: string;
  topVehicle: string;
}

export interface CompareDimension {
  key: string;
  label: string;
  a: number;
  b: number;
  format: 'int' | 'pct';
  higherIsWorse: boolean;
}

function table(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function computeAreaStats(records: readonly AccidentRecord[], monthCount: number): Record<string, AreaStats> {
  const areas: Record<string, AreaStats> = Object.create(null) as Record<string, AreaStats>;
  const baseMonths = Math.max(1, monthCount - RECENT_MONTHS);
  const lastMonth = monthCount - 1;

  for (const a of records) {
    let s = areas[a.area];
    if (!s) {
      s = {
        area: a.area, total: 0, fatal: 0, serious: 0, slight: 0, severe: 0,
        night: 0, weekend: 0, score: 0,
        hour: new Array<number>(24).fill(0),
        dow: new Array<number>(7).fill(0),
        cause: table(), vehicle: table(),
        weather: { clear: 0, rain: 0, fog: 0 },
        month: new Array<number>(monthCount).fill(0),
        recent: 0, baseline: 0,
        fatalRate: 0, severeShare: 0, nightShare: 0, weekendShare: 0, lift: 1,
        peakHour: 0, peakDow: 0, topCause: '-', topVehicle: '-',
      };
      for (const c of CAUSES) s.cause[c] = 0;
      for (const v of VEHICLES) s.vehicle[v] = 0;
      areas[a.area] = s;
    }
    s.total += 1;
    if (isSeverity(a.severity)) s[a.severity] += 1;
    s.score += sevOf(a.severity).weight;
    if (a._night) s.night += 1;
    const h = a._h ?? 0;
    const d = a._dow ?? 0;
    if (h >= 0 && h < 24) s.hour[h] = (s.hour[h] ?? 0) + 1;
    if (d >= 0 && d < 7) s.dow[d] = (s.dow[d] ?? 0) + 1;
    s.cause[a.cause] = (s.cause[a.cause] ?? 0) + 1;
    s.vehicle[a.vehicle] = (s.vehicle[a.vehicle] ?? 0) + 1;
    if (a.weather === 'clear' || a.weather === 'rain' || a.weather === 'fog') s.weather[a.weather] += 1;
    const m = a._month ?? 0;
    if (m >= 0 && m < monthCount) s.month[m] = (s.month[m] ?? 0) + 1;
    if (m > lastMonth - RECENT_MONTHS) s.recent += 1;
    else s.baseline += 1;
  }

  for (const s of Object.values(areas)) {
    s.severe = s.fatal + s.serious;
    s.weekend = (s.dow[5] ?? 0) + (s.dow[6] ?? 0);
    s.fatalRate = s.total ? s.fatal / s.total : 0;
    s.severeShare = s.total ? s.severe / s.total : 0;
    s.nightShare = s.total ? s.night / s.total : 0;
    s.weekendShare = s.total ? s.weekend / s.total : 0;
    const recentRate = s.recent / RECENT_MONTHS;
    const baseRate = s.baseline / baseMonths;
    s.lift = baseRate > 0 ? recentRate / baseRate : (s.recent >= 8 ? 2 : 1);
    s.peakHour = s.hour.indexOf(Math.max(...s.hour));
    s.peakDow = s.dow.indexOf(Math.max(...s.dow));
    s.topCause = Object.entries(s.cause).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '-';
    s.topVehicle = Object.entries(s.vehicle).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '-';
  }
  return areas;
}

/** The head-to-head rows shown for A and B. */
export function compareDimensions(a: AreaStats, b: AreaStats): CompareDimension[] {
  return [
    { key: 'volume', label: 'Incidents', a: a.total, b: b.total, format: 'int', higherIsWorse: true },
    { key: 'fatal', label: 'Fatal', a: a.fatal, b: b.fatal, format: 'int', higherIsWorse: true },
    { key: 'severe', label: 'Fatal + serious', a: a.severe, b: b.severe, format: 'int', higherIsWorse: true },
    { key: 'fatalRate', label: 'Fatal rate', a: a.fatalRate, b: b.fatalRate, format: 'pct', higherIsWorse: true },
    { key: 'severeShare', label: 'Severe share', a: a.severeShare, b: b.severeShare, format: 'pct', higherIsWorse: true },
    { key: 'nightShare', label: 'Night share', a: a.nightShare, b: b.nightShare, format: 'pct', higherIsWorse: true },
    { key: 'weekendShare', label: 'Weekend share', a: a.weekendShare, b: b.weekendShare, format: 'pct', higherIsWorse: true },
    { key: 'score', label: 'Risk score', a: a.score, b: b.score, format: 'int', higherIsWorse: true },
    { key: 'lift', label: 'Recent rate lift', a: a.lift, b: b.lift, format: 'int', higherIsWorse: true },
    { key: 'peakHour', label: 'Peak hour', a: a.peakHour, b: b.peakHour, format: 'int', higherIsWorse: false },
  ];
}

export function formatDimension(dim: CompareDimension, value: number): string {
  if (dim.format === 'pct') return `${(Math.round(value * 1000) / 10).toFixed(1)}%`;
  if (dim.key === 'lift') return `${(Math.round(value * 10) / 10).toFixed(1)}x`;
  if (dim.key === 'peakHour') return `${String(Math.round(value)).padStart(2, '0')}:00`;
  return new Intl.NumberFormat('en-US').format(value);
}
