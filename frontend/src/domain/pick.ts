/* Chennai land guard for map picking, ported from the legacy picker.
   The city box is narrower than the report bounds, and the eastern limit is the
   coastline interpolated from control points: a point east of it is sea. */

export const PICK_LAT_MIN = 12.80;
export const PICK_LAT_MAX = 13.20;
export const PICK_LNG_MIN = 80.10;

/** [latitude, coastline longitude], south to north. */
export const PICK_COAST: ReadonlyArray<readonly [number, number]> = Object.freeze([
  [12.80, 80.250],
  [12.95, 80.263],
  [13.02, 80.272],
  [13.06, 80.285],
  [13.10, 80.300],
  [13.15, 80.322],
  [13.20, 80.340],
]);

/** Eastern (coastline) longitude limit at a latitude, linearly interpolated. */
export function coastLngAt(lat: number): number {
  const p = PICK_COAST;
  const first = p[0] as readonly [number, number];
  const last = p[p.length - 1] as readonly [number, number];
  if (lat <= first[0]) return first[1];
  if (lat >= last[0]) return last[1];
  for (let i = 1; i < p.length; i += 1) {
    const b = p[i] as readonly [number, number];
    if (lat <= b[0]) {
      const a = p[i - 1] as readonly [number, number];
      const t = (lat - a[0]) / (b[0] - a[0]);
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/** A pick is valid on land inside the city box, west of the coastline. */
export function isValidLandPoint(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= PICK_LAT_MIN && lat <= PICK_LAT_MAX &&
    lng >= PICK_LNG_MIN && lng <= coastLngAt(lat)
  );
}
