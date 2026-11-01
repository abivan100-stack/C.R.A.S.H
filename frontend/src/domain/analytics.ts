/* Analytics aggregations: every dimension the studio briefs on. Pure and typed,
   the same formulas as analytics.js's computeAgg(). */

import {
  BBOX, CAUSES, CELL, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N,
  HIGH_RISK_MIN, RECENT_MONTHS, SUPPRESS, TOP_N, VEHICLES,
} from './constants.ts';
import { computeEmerging, gridCells, topJunctions } from './engine.ts';
import type { AccidentRecord, EmergingList, GridCell } from './engine.ts';

export interface Counts {
  fatal: number;
  serious: number;
  slight: number;
}

export interface AnalyticsAggregate {
  total: number;
  sev: Counts;
  cause: Record<string, number>;
  veh: Record<string, number>;
  weather: Counts & { clear: number; rain: number; fog: number };
  hour: number[];
  dow: number[];
  heat: number[][];
  wsev: Record<'clear' | 'rain' | 'fog', Counts>;
  cells: GridCell[];
  top: GridCell[];
  emerging: EmergingList;
  sevCity: number;
  sevTop: number;
  leveragePct: number;
  bySevere: Array<{ area: string; severe: number }>;
  highRisk: number;
  avgPerMonth: number;
  monthCount: number;
}

function countTable(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

export function aggregate(records: readonly AccidentRecord[], monthCount: number): AnalyticsAggregate {
  const sev: Counts = { fatal: 0, serious: 0, slight: 0 };
  const cause = countTable();
  const veh = countTable();
  const weather = { fatal: 0, serious: 0, slight: 0, clear: 0, rain: 0, fog: 0 };
  const hour = new Array<number>(24).fill(0);
  const dow = new Array<number>(7).fill(0);
  const heat: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const wsev: Record<'clear' | 'rain' | 'fog', Counts> = {
    clear: { fatal: 0, serious: 0, slight: 0 },
    rain: { fatal: 0, serious: 0, slight: 0 },
    fog: { fatal: 0, serious: 0, slight: 0 },
  };
  for (const c of CAUSES) cause[c] = 0;
  for (const v of VEHICLES) veh[v] = 0;

  for (const a of records) {
    if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') sev[a.severity] += 1;
    cause[a.cause] = (cause[a.cause] ?? 0) + 1;
    veh[a.vehicle] = (veh[a.vehicle] ?? 0) + 1;
    const h = a._h ?? 0;
    const d = a._dow ?? 0;
    if (h >= 0 && h < 24) hour[h] = (hour[h] ?? 0) + 1;
    if (d >= 0 && d < 7) dow[d] = (dow[d] ?? 0) + 1;
    if (h >= 0 && h < 24 && d >= 0 && d < 7) heat[d]![h] = (heat[d]![h] ?? 0) + 1;
    if (a.weather === 'rain') weather.rain += 1;
    else if (a.weather === 'fog') weather.fog += 1;
    else weather.clear += 1;
    if (a.weather === 'clear' || a.weather === 'rain' || a.weather === 'fog') {
      if (a.severity === 'fatal' || a.severity === 'serious' || a.severity === 'slight') {
        weather[a.severity] += 1;
        wsev[a.weather][a.severity] += 1;
      }
    }
  }

  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, monthCount);
  const top = topJunctions(cells, TOP_N, SUPPRESS);
  const sevCity = sev.fatal + sev.serious;
  let sevTop = 0;
  for (const c of top) sevTop += c.fatal + c.serious;

  const bySevere = cells
    .map((c) => ({ area: c.area, severe: c.fatal + c.serious }))
    .filter((c) => c.severe > 0)
    .sort((a, b) => b.severe - a.severe);

  const emerging = computeEmerging(cells, RECENT_MONTHS, monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);

  return {
    total: records.length,
    sev,
    cause,
    veh,
    weather,
    hour,
    dow,
    heat,
    wsev,
    cells,
    top,
    emerging,
    sevCity,
    sevTop,
    leveragePct: sevCity ? Math.round((100 * sevTop) / sevCity) : 0,
    bySevere,
    highRisk: cells.filter((c) => c.score >= HIGH_RISK_MIN).length,
    avgPerMonth: Math.round(records.length / (monthCount || 1)),
    monthCount,
  };
}

/** Pareto bars and cumulative share, capped like the legacy chart. */
export function paretoSeries(a: AnalyticsAggregate): { labels: number[]; severe: number[]; cumulative: number[] } {
  const bars = a.bySevere.slice(0, Math.min(28, a.bySevere.length));
  let cumulative = 0;
  const cumulativeSeries = bars.map((c) => {
    cumulative += c.severe;
    return Math.round((1000 * cumulative) / (a.sevCity || 1)) / 10;
  });
  return { labels: bars.map((_, i) => i + 1), severe: bars.map((c) => c.severe), cumulative: cumulativeSeries };
}
