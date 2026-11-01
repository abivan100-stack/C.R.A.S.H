/* Monte Carlo risk projection: the deterministic, seeded sampler ported from
   simulate.js. Same scenario inputs, same seeded stream, same outputs. */

import { CELL } from './constants.ts';
import type { AccidentRecord } from './engine.ts';
import { sevOf, type Severity } from './constants.ts';
import { isNight } from '../lib/utils.ts';

export type TimeOfDay = 'any' | 'day' | 'night';
export type Weather = 'any' | 'clear' | 'rain' | 'fog';
export type DayType = 'any' | 'weekday' | 'weekend';

export interface Scenario {
  timeOfDay: TimeOfDay;
  weather: Weather;
  dayType: DayType;
  horizonMonths: number;
}

export interface ModelCell {
  cellId: string;
  ci: number;
  cj: number;
  count: number;
  severityWeight: number;
  centerLat: number;
  centerLng: number;
  nightFrac: number;
  dayFrac: number;
  clearFrac: number;
  rainFrac: number;
  fogFrac: number;
  weekdayFrac: number;
  weekendFrac: number;
  night: number;
  day: number;
  clear: number;
  rain: number;
  fog: number;
  weekday: number;
  weekend: number;
  fatal: number;
  serious: number;
  slight: number;
  area: string;
  areaMix: Record<string, number>;
}

export interface SimulationModel {
  cells: ModelCell[];
  joint: Record<string, number>;
  monthlyRate: number;
  totalCount: number;
}

export interface ProjectedPoint {
  lat: number;
  lng: number;
  cellId: string;
  projectedSeverity: Severity;
}

export const VOLUME_SIGMA = 0.06;
export const VOLUME_CLAMP = 0.15;

/** mulberry32: deterministic PRNG matching the legacy implementation. */
export function mulberry32(a: number): () => number {
  let state = a;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeScenario(scenario: Partial<Scenario>): Scenario {
  return {
    timeOfDay: scenario.timeOfDay ?? 'any',
    weather: scenario.weather ?? 'any',
    dayType: scenario.dayType ?? 'any',
    horizonMonths: Math.min(24, Math.max(1, Number.parseInt(String(scenario.horizonMonths ?? 6), 10) || 6)),
  };
}

/** FNV-1a over the scenario plus run nonce. */
export function seedFrom(s: Scenario, nonce: number): number {
  const str = `${s.timeOfDay}|${s.weather}|${s.dayType}|${s.horizonMonths}|${nonce >>> 0}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function gaussian(rng: () => number): number {
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function reflect(v: number, lo: number, hi: number): number {
  let value = v;
  if (value < lo) value = lo + (lo - value);
  if (value > hi) value = hi - (value - hi);
  return value < lo ? lo : value > hi ? hi : value;
}

export function buildModel(records: readonly AccidentRecord[], bbox: { latMin: number; latMax: number; lngMin: number; lngMax: number }, monthCount: number): SimulationModel {
  const cells = new Map<string, ModelCell>();
  const joint: Record<string, number> = Object.create(null) as Record<string, number>;

  for (const a of records) {
    const ci = Math.floor((a.lat - bbox.latMin) / CELL);
    const cj = Math.floor((a.lng - bbox.lngMin) / CELL);
    const key = `${ci}_${cj}`;
    let c = cells.get(key);
    if (!c) {
      c = {
        cellId: key, ci, cj, count: 0, severityWeight: 0, centerLat: 0, centerLng: 0,
        nightFrac: 0, dayFrac: 0, clearFrac: 0, rainFrac: 0, fogFrac: 0,
        weekdayFrac: 0, weekendFrac: 0, night: 0, day: 0, clear: 0, rain: 0, fog: 0, weekday: 0, weekend: 0,
        fatal: 0, serious: 0, slight: 0,
        area: '', areaMix: Object.create(null) as Record<string, number>,
      };
      cells.set(key, c);
    }
    c.count += 1;
    c.centerLat += a.lat;
    c.centerLng += a.lng;
    c.severityWeight += sevOf(a.severity).weight;
    if (a.severity === 'fatal') c.fatal += 1;
    else if (a.severity === 'serious') c.serious += 1;
    else c.slight += 1;

    const night = isNight(a.datetime);
    const weather = a.weather === 'rain' ? 'rain' : a.weather === 'fog' ? 'fog' : 'clear';
    const [y = '', m = '', d = ''] = a.datetime.slice(0, 10).split('-');
    const dow = new Date(+y, +m - 1, +d).getDay();
    const weekend = dow === 0 || dow === 6;
    if (night) c.night += 1; else c.day += 1;
    if (weather === 'rain') c.rain += 1; else if (weather === 'fog') c.fog += 1; else c.clear += 1;
    if (weekend) c.weekend += 1; else c.weekday += 1;
    c.areaMix[a.area] = (c.areaMix[a.area] ?? 0) + 1;

    const jk = `${night ? 'night' : 'day'}|${weather}|${weekend ? 'weekend' : 'weekday'}`;
    joint[jk] = (joint[jk] ?? 0) + 1;
  }

  const list: ModelCell[] = [];
  for (const c of cells.values()) {
    const n = c.count || 1;
    c.centerLat /= n;
    c.centerLng /= n;
    c.nightFrac = (c.night || 0) / n;
    c.dayFrac = (c.count - (c.night || 0)) / n;
    c.clearFrac = (c.clear || 0) / n;
    c.rainFrac = (c.rain || 0) / n;
    c.fogFrac = (c.fog || 0) / n;
    c.weekdayFrac = (c.weekday || 0) / n;
    c.weekendFrac = (c.weekend || 0) / n;
    c.area = Object.entries(c.areaMix).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
    list.push(c);
  }
  /* The fractions are filled in below from the raw counters. */
  list.sort((x, y) => y.count - x.count);

  return {
    cells: list,
    joint,
    totalCount: records.length,
    monthlyRate: records.length / (monthCount || 1),
  };
}

function scenarioMultiplier(cell: ModelCell, s: Scenario): number {
  const t = s.timeOfDay === 'night' ? cell.nightFrac : s.timeOfDay === 'day' ? cell.dayFrac : 1;
  const w = s.weather === 'rain' ? cell.rainFrac : s.weather === 'fog' ? cell.fogFrac : s.weather === 'clear' ? cell.clearFrac : 1;
  const d = s.dayType === 'weekday' ? cell.weekdayFrac : s.dayType === 'weekend' ? cell.weekendFrac : 1;
  return t * w * d;
}

export function scenarioPrevalence(s: Scenario, model: SimulationModel): number {
  const total = model.totalCount || 1;
  let matched = 0;
  for (const key of Object.keys(model.joint)) {
    const [time = '', weather = '', day = ''] = key.split('|');
    if (
      (s.timeOfDay === 'any' || s.timeOfDay === time) &&
      (s.weather === 'any' || s.weather === weather) &&
      (s.dayType === 'any' || s.dayType === day)
    ) matched += model.joint[key] ?? 0;
  }
  return matched / total;
}

function sampleSeverity(cell: ModelCell, rng: () => number): Severity {
  const n = cell.fatal + cell.serious + cell.slight;
  if (n <= 0) return 'slight';
  const r = rng() * n;
  if (r < cell.fatal) return 'fatal';
  if (r < cell.fatal + cell.serious) return 'serious';
  return 'slight';
}

/** Deterministic projection for a scenario + nonce. */
export function runSimulation(
  model: SimulationModel,
  bbox: { latMin: number; latMax: number; lngMin: number; lngMax: number },
  rawScenario: Partial<Scenario>,
  nonce = 0,
): ProjectedPoint[] {
  const s = normalizeScenario(rawScenario);
  const rng = mulberry32(seedFrom(s, nonce));
  const prevalence = scenarioPrevalence(s, model);
  const baseTotal = model.monthlyRate * s.horizonMonths * prevalence;
  if (Math.round(baseTotal) <= 0) return [];
  const volumeFactor = 1 + Math.max(-VOLUME_CLAMP, Math.min(VOLUME_CLAMP, gaussian(rng) * VOLUME_SIGMA));
  const projectedTotal = Math.max(1, Math.round(baseTotal * volumeFactor));

  const cells = model.cells;
  const n = cells.length;
  if (n === 0) return [];
  const cumulative = new Array<number>(n);
  let weight = 0;
  for (let i = 0; i < n; i += 1) {
    weight += (cells[i] as ModelCell).severityWeight * scenarioMultiplier(cells[i] as ModelCell, s);
    cumulative[i] = weight;
  }
  if (weight <= 0) return [];

  const sigma = CELL * 0.5;
  const points: ProjectedPoint[] = [];
  for (let k = 0; k < projectedTotal; k += 1) {
    const target = rng() * weight;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumulative[mid] as number) <= target) lo = mid + 1;
      else hi = mid;
    }
    const cell = cells[lo] as ModelCell;
    points.push({
      lat: reflect(cell.centerLat + gaussian(rng) * sigma, bbox.latMin, bbox.latMax),
      lng: reflect(cell.centerLng + gaussian(rng) * sigma, bbox.lngMin, bbox.lngMax),
      cellId: cell.cellId,
      projectedSeverity: sampleSeverity(cell, rng),
    });
  }
  return points;
}

export interface ProjectionSummary {
  total: number;
  fatal: number;
  serious: number;
  slight: number;
  topCells: Array<{ cellId: string; count: number; area: string }>;
}

export function summarize(points: readonly ProjectedPoint[], model: SimulationModel): ProjectionSummary {
  const byCell = new Map<string, number>();
  let fatal = 0;
  let serious = 0;
  let slight = 0;
  for (const p of points) {
    byCell.set(p.cellId, (byCell.get(p.cellId) ?? 0) + 1);
    if (p.projectedSeverity === 'fatal') fatal += 1;
    else if (p.projectedSeverity === 'serious') serious += 1;
    else slight += 1;
  }
  const areas = new Map(model.cells.map((c) => [c.cellId, c.area]));
  const topCells = [...byCell.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cellId, count]) => ({ cellId, count, area: areas.get(cellId) ?? '' }));
  return { total: points.length, fatal, serious, slight, topCells };
}
