/* =============================================================================
   CRASH - Typed hotspot engine.
   Pure computation: cell gridding, severity-weighted ranking, non-max
   suppression, emerging-hotspot detection. No DOM, no rendering, no globals:
   the same behaviour as shared/engine.js, ported to typed modules.
   ========================================================================== */

import type { BBox } from './constants.ts';
import { isSeverity, sevOf } from './constants.ts';

/** Default severity weight: fatal 3, serious 2, slight 1, unknown 1. */
export function sevWeight(severity: unknown): number {
  return sevOf(severity).weight;
}

/** A raw incident as the API and the static dataset deliver it. */
export interface AccidentRecord {
  id?: number | string;
  lat: number;
  lng: number;
  severity: string;
  datetime: string;
  weather: string;
  cause: string;
  vehicle: string;
  area: string;
  citizen?: boolean;
  /* Fields precompute() attaches. */
  _h?: number;
  _night?: boolean;
  _dow?: number;
  _ym?: number;
  _month?: number;
}

export interface PrecomputeMeta {
  minYM: number;
  monthCount: number;
  lastMonth: number;
}

export interface MonthMeta {
  min: number;
  max: number;
  count: number;
}

export interface GridCell {
  key: string;
  ci: number;
  cj: number;
  count: number;
  score: number;
  fatal: number;
  serious: number;
  slight: number;
  night: number;
  areas: Record<string, number>;
  cause: Record<string, number>;
  recent: number;
  baseline: number;
  recentScore: number;
  rF: number;
  rS: number;
  rL: number;
  sumLat: number;
  sumLng: number;
  months: number[] | null;
  /* Derived by gridCells(). */
  area: string;
  lat: number;
  lng: number;
  /* Derived by topJunctions(). */
  norm?: number;
}

export interface EmergingHotspot {
  id: string;
  area: string;
  ci: number;
  cj: number;
  lat: number;
  lng: number;
  months: number[];
  recent: number;
  baseline: number;
  recentRate: number;
  baseRate: number;
  lift: number;
  pct: number;
  pctIncrease: number;
  priority: number;
  rF: number;
  rS: number;
  rL: number;
}

/** The display list carries the raw qualify count before the cap. */
export type EmergingList = EmergingHotspot[] & { qualifyingCount: number };

export type WeightFn = (severity: string) => number;

/** Non-max suppression: keep candidates at least `suppress` cells apart. */
export function nmsFilter<T extends { ci: number; cj: number }>(candidates: readonly T[], topN: number, suppress: number): T[] {
  const pick: T[] = [];
  for (const c of candidates) {
    if (pick.length >= topN) break;
    const clash = pick.some((p) => Math.abs(p.ci - c.ci) <= suppress && Math.abs(p.cj - c.cj) <= suppress);
    if (!clash) pick.push(c);
  }
  return pick;
}

/**
 * Attach fast-filter fields to every record, in place, and resolve the analysis
 * window. The window is anchored to the NEWEST record and clamped to
 * `maxMonths`: an old citizen report must not stretch the window and corrupt
 * every per-month figure.
 */
export function precompute(records: AccidentRecord[], maxMonths?: number): PrecomputeMeta {
  const cap = typeof maxMonths === 'number' && maxMonths > 0 ? maxMonths : Infinity;
  let minYM = Infinity;
  let maxYM = -Infinity;
  for (const a of records) {
    a._h = parseInt(a.datetime.slice(11, 13), 10);
    a._night = a._h < 6 || a._h >= 18;
    const [y = '', m = '', d = ''] = a.datetime.slice(0, 10).split('-');
    a._dow = (new Date(+y, +m - 1, +d).getDay() + 6) % 7;
    a._ym = +y * 12 + (+m - 1);
    if (a._ym < minYM) minYM = a._ym;
    if (a._ym > maxYM) maxYM = a._ym;
  }
  if (!records.length) return { minYM: 0, monthCount: 1, lastMonth: 0 };
  const span = maxYM - minYM + 1;
  const monthCount = Math.min(span, cap);
  minYM = maxYM - monthCount + 1; // anchor on the NEWEST record, not the oldest
  const lastMonth = monthCount - 1;
  for (const record of records) record._month = (record._ym as number) - minYM;
  return { minYM, monthCount, lastMonth };
}

/** Month range for a set of records. `count` is a divisor, never 0. */
export function monthMeta(records: readonly Pick<AccidentRecord, 'datetime'>[]): MonthMeta {
  let min = Infinity;
  let max = -Infinity;
  for (const a of records) {
    const ym = +a.datetime.slice(0, 4) * 12 + (+a.datetime.slice(5, 7) - 1);
    if (ym < min) min = ym;
    if (ym > max) max = ym;
  }
  return { min, max, count: records.length ? max - min + 1 : 1 };
}

function countTable(): Record<string, number> {
  /* Null prototype: a crafted area or cause such as "__proto__" must not reach
     Object.prototype. Mirrors shared/engine.js. */
  return Object.create(null) as Record<string, number>;
}

/** Partition records into ~250 m grid cells, accumulating every stat. */
export function gridCells(
  records: readonly AccidentRecord[],
  bbox: BBox,
  cellSize: number,
  recentMonths: number,
  monthCount?: number,
  weightFn?: WeightFn,
): GridCell[] {
  const weight = weightFn ?? sevWeight;
  const map = new Map<string, GridCell>();
  const hasMonths = typeof monthCount === 'number' && monthCount > 0;
  const recentCut = hasMonths ? monthCount - 1 - recentMonths : -1;

  for (const a of records) {
    const ci = Math.floor((a.lat - bbox.latMin) / cellSize);
    const cj = Math.floor((a.lng - bbox.lngMin) / cellSize);
    const key = `${ci}_${cj}`;
    let cell = map.get(key);
    if (!cell) {
      cell = {
        key, ci, cj, count: 0, score: 0,
        fatal: 0, serious: 0, slight: 0, night: 0,
        areas: countTable(), cause: countTable(),
        recent: 0, baseline: 0, recentScore: 0,
        rF: 0, rS: 0, rL: 0,
        sumLat: 0, sumLng: 0, months: hasMonths ? new Array<number>(monthCount as number).fill(0) : null,
        area: '', lat: 0, lng: 0,
      };
      map.set(key, cell);
    }
    cell.count++;
    let w = weight(a.severity);
    if (typeof w !== 'number' || !Number.isFinite(w)) w = 1; // a caller's weightFn must not poison the score
    cell.score += w;
    /* Only the three known severity fields are ever written: a crafted
       severity must not overwrite count/score/key. */
    if (isSeverity(a.severity)) cell[a.severity]++;
    if (a._night) cell.night++;
    cell.areas[a.area] = (cell.areas[a.area] ?? 0) + 1;
    cell.cause[a.cause] = (cell.cause[a.cause] ?? 0) + 1;
    const month = a._month;
    if (hasMonths && month !== undefined && month >= 0 && month < (monthCount as number)) {
      const months = cell.months as number[];
      months[month] = (months[month] ?? 0) + 1;
    }
    if (hasMonths && month !== undefined && month > recentCut) {
      cell.recent++;
      cell.recentScore += w;
      if (a.severity === 'fatal') cell.rF++;
      else if (a.severity === 'serious') cell.rS++;
      else cell.rL++;
    } else if (hasMonths) {
      cell.baseline++;
    }
    cell.sumLat += a.lat;
    cell.sumLng += a.lng;
  }

  const cells: GridCell[] = [];
  map.forEach((v) => {
    const areaKeys = Object.keys(v.areas);
    if (areaKeys.length) {
      areaKeys.sort((a, b) => (v.areas[b] as number) - (v.areas[a] as number));
      v.area = areaKeys[0] as string;
    }
    v.lat = v.sumLat / v.count;
    v.lng = v.sumLng / v.count;
    cells.push(v);
  });
  return cells;
}

/** Top N junctions: sort by score desc, NMS, normalise to 1-100. */
export function topJunctions(cells: readonly GridCell[], topN: number, suppress: number): GridCell[] {
  const byScore = cells.slice().sort((a, b) => b.score - a.score || b.count - a.count);
  const pick = nmsFilter(byScore, topN, suppress);
  const topRaw = pick.length ? (pick[0] as GridCell).score : 1;
  for (const cell of pick) {
    cell.norm = Math.max(1, Math.round(100 * Math.pow(cell.score / topRaw, 0.6)));
  }
  return pick;
}

/**
 * Emerging-hotspot detection. Cells must already carry `.recent`, `.baseline`
 * and `.recentScore` (gridCells computes them).
 */
export function computeEmerging(
  cells: readonly GridCell[],
  recentMonths: number,
  monthCount: number,
  minRecent: number,
  liftThreshold: number,
  topN: number,
  suppress: number,
): EmergingList {
  const baseMonths = Math.max(1, monthCount - recentMonths);
  const candidates: EmergingHotspot[] = [];
  for (const c of cells) {
    if (c.recent < minRecent) continue;
    const recentRate = c.recent / recentMonths;
    const baseRate = c.baseline / baseMonths;
    const lift = baseRate > 0 ? recentRate / baseRate : 3;
    if (lift < liftThreshold) continue;
    let area = '';
    if (c.areas) {
      const top = Object.keys(c.areas).sort((a, b) => (c.areas[b] as number) - (c.areas[a] as number));
      area = top[0] ?? '';
    }
    const n = c.recent + c.baseline || c.count || 1;
    candidates.push({
      id: c.key, area, ci: c.ci, cj: c.cj,
      lat: c.lat ?? (c.sumLat || 0) / n,
      lng: c.lng ?? (c.sumLng || 0) / n,
      months: c.months ?? [],
      recent: c.recent, baseline: c.baseline,
      recentRate, baseRate,
      lift,
      pct: Math.round((lift - 1) * 100),
      pctIncrease: Math.round((lift - 1) * 100),
      priority: c.recentScore * (lift - 1),
      rF: c.rF || 0, rS: c.rS || 0, rL: c.rL || 0,
    });
  }
  candidates.sort((a, b) => b.priority - a.priority);
  const picked = nmsFilter(candidates, topN, suppress) as EmergingList;
  /* Display list is capped at topN; callers that show a count must use this. */
  picked.qualifyingCount = candidates.length;
  return picked;
}
