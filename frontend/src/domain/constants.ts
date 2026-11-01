/* =============================================================================
   CRASH — Typed domain constants.
   Single source of truth for the migrated frontend. Mirrors
   shared/constants.js and backend/main.py: same areas, causes, vehicles,
   weathers and severities, same tuning numbers. Frozen at runtime and
   immutable in the type system.

   Every membership test goes through the guards below, never a bare object
   lookup: a report's severity/area arrives from the network and is
   attacker-controlled, and `OBJ[value]` also resolves inherited
   Object.prototype members ("toString", "constructor", …).
   ========================================================================== */

export type Severity = 'fatal' | 'serious' | 'slight';

export interface SeverityDescriptor {
  readonly color: string;
  readonly label: string;
  readonly weight: number;
  /* Short aliases kept for the chart layer, mirroring the legacy shape. */
  readonly c: string;
  readonly l: string;
  readonly w: number;
}

function severity(color: string, label: string, weight: number): SeverityDescriptor {
  return Object.freeze({ color, label, weight, c: color, l: label, w: weight });
}

export const SEV: Readonly<Record<Severity, SeverityDescriptor>> = Object.freeze({
  fatal: severity('#BE2F2A', 'Fatal', 3),
  serious: severity('#CE8A2E', 'Serious', 2),
  slight: severity('#E7C64B', 'Slight', 1),
});

export const SEVERITIES = Object.freeze(['fatal', 'serious', 'slight'] as const);

export function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).indexOf(value) !== -1;
}

/** Safe descriptor lookup: an unknown severity falls back to `slight`. */
export function sevOf(value: unknown): SeverityDescriptor {
  return isSeverity(value) ? SEV[value] : SEV.slight;
}

/* The four controlled vocabularies, mirrored exactly with backend/main.py's
   AREAS, CAUSES, VEHICLES and WEATHERS. A value outside the vocabulary is not
   cosmetic: it becomes an object key in accumulators, so "__proto__" or an
   unknown weather used to crash the ranking engine outright. */
export const AREAS = Object.freeze([
  'Adyar', 'Ambattur', 'Anna Nagar', 'Avadi',
  'Chromepet', 'Egmore', 'Guindy', 'Kattankulathur',
  'Koyambedu', 'Maduravoyal', 'Medavakkam', 'Mylapore',
  'Nandanam', 'Nungambakkam', 'Padi', 'Pallavaram',
  'Perambur', 'Perungudi', 'Poonamallee', 'Porur',
  'Saidapet', 'Sholinganallur', 'T. Nagar', 'Tambaram',
  'Teynampet', 'Thiruvanmiyur', 'Thoraipakkam', 'Vadapalani',
  'Vandalur', 'Velachery',
] as const);

export const CAUSES = Object.freeze([
  'Over-speeding', 'Wrong-side driving', 'Signal jumping', 'Drunken driving',
  'Mobile phone use', 'Hit and run', 'Pothole / bad road', 'Pedestrian crossing error',
  'Improper overtaking', 'Vehicle defect', 'Poor visibility',
] as const);

export const VEHICLES = Object.freeze([
  'Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus (MTC/Private)',
  'Lorry / Truck', 'LCV / Van', 'Bicycle', 'Unknown (fled)',
] as const);

export const WEATHERS = Object.freeze(['clear', 'rain', 'fog'] as const);

export type Area = (typeof AREAS)[number];
export type Cause = (typeof CAUSES)[number];
export type Vehicle = (typeof VEHICLES)[number];
export type Weather = (typeof WEATHERS)[number];

function inVocabulary(vocabulary: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && vocabulary.indexOf(value) !== -1;
}

export function isArea(value: unknown): value is Area {
  return inVocabulary(AREAS, value);
}
export function isCause(value: unknown): value is Cause {
  return inVocabulary(CAUSES, value);
}
export function isVehicle(value: unknown): value is Vehicle {
  return inVocabulary(VEHICLES, value);
}
export function isWeather(value: unknown): value is Weather {
  return inVocabulary(WEATHERS, value);
}

export interface BBox {
  readonly latMin: number;
  readonly latMax: number;
  readonly lngMin: number;
  readonly lngMax: number;
}

/* Chennai bounding box (~250 m grid). */
export const BBOX: BBox = Object.freeze({ latMin: 12.80, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 });
export const CELL = 0.0022;

/* Sanity box for an incoming citizen report: deliberately wider than BBOX so a
   map-edge pick is never rejected. Mirrors the backend's own bounds. */
export const REPORT_BOUNDS: BBox = Object.freeze({ latMin: 12.60, latMax: 13.40, lngMin: 79.90, lngMax: 80.45 });

/* Hotspot engine tuning. */
export const TOP_N = 10;
export const SUPPRESS = 2;
export const HIGH_RISK_MIN = 40;
export const SELECT_ZOOM = 15;

/* Emerging-hotspot engine. */
export const RECENT_MONTHS = 6;

/* Longest analysis window in months: the shipped dataset spans exactly 24.
   Clamping stops one citizen report with a stray date from stretching the
   window and corrupting every per-month figure. */
export const MAX_WINDOW_MONTHS = 24;
export const EMERGE_LIFT = 1.5;
export const EMERGE_MIN_RECENT = 8;
export const EMERGE_TOP_N = 6;

export const MON = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const);
export const DOW = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const);

export type SegmentValue = string | number;
export interface SegmentOption {
  readonly label: string;
  readonly value: SegmentValue;
}
export interface SegmentDefinition {
  readonly id: string;
  readonly chips?: true;
  readonly options: readonly SegmentOption[];
}

function seg(id: string, options: ReadonlyArray<readonly [string, SegmentValue]>, chips = false): SegmentDefinition {
  const mapped = options.map(([label, value]) => Object.freeze({ label, value }));
  return Object.freeze(chips ? { id, chips: true as const, options: mapped } : { id, options: mapped });
}

/* Segmented filter definitions (map page). */
export const SEGMENTS: Readonly<Record<'source' | 'sev' | 'time' | 'weather' | 'dow', SegmentDefinition>> = Object.freeze({
  source: seg('segSource', [['All', 'all'], ['Official only', 'official'], ['Citizen only', 'citizen']]),
  sev: seg('segSev', [['All', 'all'], ['Fatal + serious', 'fs'], ['Fatal', 'f']]),
  time: seg('segTime', [['All', 'all'], ['Day', 'day'], ['Night', 'night']]),
  weather: seg('segWeather', [['All', 'all'], ['Clear', 'clear'], ['Rain', 'rain'], ['Fog', 'fog']]),
  dow: seg('segDow', [['All', 'all'], ['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]], true),
});

/* Chart colour palette (CSS variable fallbacks). */
export const CHART_COLORS = Object.freeze({
  accent: '#2F5C87',
  day: '#5F7488',
  night: '#33475C',
  fatal: '#BE2F2A',
  serious: '#CE8A2E',
  slight: '#E7C64B',
});
