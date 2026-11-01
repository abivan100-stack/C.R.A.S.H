/* =============================================================================
   CRASH — Citizen report validation and payload shaping.

   Mirrors backend/main.py's Report model exactly: coordinate bounds, the
   YYYY-MM-DD HH:MM shape and real calendar date, and membership in each
   controlled vocabulary. The UI additionally refuses future timestamps, the
   same rule the legacy form enforced.
   ========================================================================== */

import {
  isArea,
  isCause,
  isSeverity,
  isVehicle,
  isWeather,
  REPORT_BOUNDS,
  type Area,
  type Cause,
  type Severity,
  type Vehicle,
  type Weather,
} from './constants.ts';

/** The 8 fields POST /report accepts, in canonical form. */
export interface ReportPayload {
  lat: number;
  lng: number;
  severity: Severity;
  datetime: string;
  weather: Weather;
  cause: Cause;
  vehicle: Vehicle;
  area: Area;
}

/** Raw form state: every field may still be empty or outside a vocabulary. */
export interface ReportDraft {
  lat: number | null;
  lng: number | null;
  severity: string;
  datetime: string;
  weather: string;
  cause: string;
  vehicle: string;
  area: string;
  /** Canonical area derived from the picked coordinates, if any. */
  pickedArea?: string | null;
}

export type ReportField = 'location' | 'area' | 'datetime' | 'severity' | 'cause' | 'vehicle' | 'weather';

export interface ReportIssue {
  field: ReportField;
  message: string;
}

export type ReportValidation =
  | { ok: true; report: ReportPayload }
  | { ok: false; issues: ReportIssue[] };

const DATETIME_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/** True only for a real calendar datetime in the accepted shape. */
export function isRealDatetime(value: string): boolean {
  if (!DATETIME_SHAPE.test(value)) return false;
  const [datePart, timePart] = value.split(' ');
  if (!datePart || !timePart) return false;
  const [y = 0, m = 0, d = 0] = datePart.split('-').map(Number);
  const [hh = 0, mm = 0] = timePart.split(':').map(Number);
  if (m < 1 || m > 12 || d < 1 || hh > 23 || mm > 59) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day of m
  return d <= days;
}

function inReportBounds(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= REPORT_BOUNDS.latMin &&
    lat <= REPORT_BOUNDS.latMax &&
    lng >= REPORT_BOUNDS.lngMin &&
    lng <= REPORT_BOUNDS.lngMax
  );
}

/**
 * Validate a draft exactly like the backend, plus the UI's no-future rule.
 * Returns the canonical payload (trimmed, vocabulary-checked) on success.
 */
export function validateReport(draft: ReportDraft, now: number = Date.now()): ReportValidation {
  const issues: ReportIssue[] = [];

  /* The backend strips whitespace on every string field, so trim before the
     vocabulary checks to accept exactly what it accepts. */
  const severity = draft.severity.trim();
  const weather = draft.weather.trim();
  const cause = draft.cause.trim();
  const vehicle = draft.vehicle.trim();
  const areaInput = (draft.pickedArea ?? draft.area).trim();

  if (draft.lat == null || draft.lng == null || !inReportBounds(draft.lat, draft.lng)) {
    issues.push({ field: 'location', message: 'Set a location: drop a pin or pick an area on land in Chennai.' });
  }

  if (!isArea(areaInput)) {
    issues.push({ field: 'area', message: 'Choose a recognised Chennai area.' });
  }

  const datetime = draft.datetime.trim();
  if (!datetime) {
    issues.push({ field: 'datetime', message: 'Pick the date and time.' });
  } else if (!isRealDatetime(datetime)) {
    issues.push({ field: 'datetime', message: 'Enter a real date and time as YYYY-MM-DD HH:MM.' });
  } else if (new Date(datetime.replace(' ', 'T')).getTime() > now + 60_000) {
    issues.push({ field: 'datetime', message: 'The date and time cannot be in the future.' });
  }

  if (!isSeverity(severity)) {
    issues.push({ field: 'severity', message: 'Choose a severity.' });
  }
  if (!isCause(cause)) {
    issues.push({ field: 'cause', message: 'Choose a cause.' });
  }
  if (!isVehicle(vehicle)) {
    issues.push({ field: 'vehicle', message: 'Choose a vehicle.' });
  }
  if (!isWeather(weather)) {
    issues.push({ field: 'weather', message: 'Choose a weather condition.' });
  }

  const first = issues[0];
  if (first) return { ok: false, issues };

  return {
    ok: true,
    report: {
      lat: draft.lat as number,
      lng: draft.lng as number,
      severity: severity as Severity,
      datetime,
      weather: weather as Weather,
      cause: cause as Cause,
      vehicle: vehicle as Vehicle,
      area: areaInput as Area,
    },
  };
}

/** Normalise a map- or clock-value into the backend's "YYYY-MM-DD HH:MM". */
export function toStoredDatetime(localInputValue: string): string {
  return localInputValue.replace('T', ' ').slice(0, 16);
}

/** Current local time in the `datetime-local` input's value shape. */
export function nowLocalInput(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
