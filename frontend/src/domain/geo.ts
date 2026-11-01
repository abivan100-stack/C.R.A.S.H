/* Geographic helpers used by the report form and the map shell. */

import type { AccidentRecord } from '../domain/engine.ts';

export interface LatLng {
  lat: number;
  lng: number;
}

const M_PER_DEG_LAT = 111_320;

/** Mean position of the records of each area. */
export function areaCentroids(records: readonly AccidentRecord[]): Record<string, [number, number]> {
  const acc: Record<string, { lat: number; lng: number; n: number }> = Object.create(null) as Record<string, { lat: number; lng: number; n: number }>;
  for (const a of records) {
    const c = acc[a.area] ?? (acc[a.area] = { lat: 0, lng: 0, n: 0 });
    c.lat += a.lat;
    c.lng += a.lng;
    c.n += 1;
  }
  const out: Record<string, [number, number]> = Object.create(null) as Record<string, [number, number]>;
  for (const key of Object.keys(acc)) {
    const c = acc[key] as { lat: number; lng: number; n: number };
    out[key] = [c.lat / c.n, c.lng / c.n];
  }
  return out;
}

export function uniqueAreas(records: readonly AccidentRecord[]): string[] {
  return Object.keys(areaCentroids(records)).sort();
}

/** Nearest actual record's area: robust for irregularly shaped areas. */
export function nearestArea(records: readonly AccidentRecord[], lat: number, lng: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const a of records) {
    const dLat = a.lat - lat;
    const dLng = a.lng - lng;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) {
      bestD = d;
      best = a.area;
    }
  }
  return best;
}

/** Great-circle distance in kilometres. */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Metres between two nearby points (small-area approximation). */
export function metersBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * M_PER_DEG_LAT;
  const dLng = (lng2 - lng1) * M_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}
