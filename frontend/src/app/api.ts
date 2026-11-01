/* Network boundary for the app: static dataset, shared citizen reports, and
   report submission with the established 6 s abort and offline fallback. */

import type { AccidentRecord } from '../domain/engine.ts';
import type { ReportPayload } from '../domain/report.ts';

export const CITIZEN_STORAGE_KEY = 'citizen_reports';
const REQUEST_TIMEOUT_MS = 6000;

export type CitizenRecord = AccidentRecord & { citizen: true; shared?: boolean };

function apiBase(): string {
  return (window as unknown as { API_BASE?: string }).API_BASE ?? '';
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
  try {
    const response = await fetch(url, controller ? { ...init, signal: controller.signal } : init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchAccidents(): Promise<AccidentRecord[]> {
  return fetchJson<AccidentRecord[]>('./data/accidents.json');
}

/** Content signature over the 8 report fields, to merge shared + local copies. */
export function reportSignature(r: AccidentRecord): string {
  return [
    Number(r.lat).toFixed(5),
    Number(r.lng).toFixed(5),
    r.severity,
    r.datetime,
    r.weather,
    r.cause,
    r.vehicle,
    r.area,
  ].join('|');
}

function looksLikeReport(value: unknown): value is ReportPayload & { _id?: string } {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.lat === 'number' && typeof r.lng === 'number' && typeof r.severity === 'string'
    && typeof r.datetime === 'string' && typeof r.weather === 'string' && typeof r.cause === 'string'
    && typeof r.vehicle === 'string' && typeof r.area === 'string';
}

/** Shared reports from the backend. Any failure yields [] so the app keeps working. */
export async function fetchSharedReports(): Promise<CitizenRecord[]> {
  try {
    const arr = await fetchJson<unknown[]>(`${apiBase()}/reports`);
    if (!Array.isArray(arr)) return [];
    return arr.filter(looksLikeReport).map((r) => ({
      lat: r.lat,
      lng: r.lng,
      severity: r.severity,
      datetime: r.datetime,
      weather: r.weather,
      cause: r.cause,
      vehicle: r.vehicle,
      area: r.area,
      citizen: true as const,
      shared: true,
      id: r._id ? `m${r._id}` : `c${Math.random().toString(36).slice(2, 8)}`,
    }));
  } catch {
    return [];
  }
}

/** Local fallback reports, validated field by field before they join the dataset. */
export function readLocalReports(): CitizenRecord[] {
  try {
    const raw = localStorage.getItem(CITIZEN_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(looksLikeReport).map((r) => ({ ...r, citizen: true as const }));
  } catch {
    return [];
  }
}

export function writeLocalReports(records: readonly CitizenRecord[]): void {
  try {
    localStorage.setItem(
      CITIZEN_STORAGE_KEY,
      JSON.stringify(records.map((r) => ({
        lat: r.lat, lng: r.lng, severity: r.severity, datetime: r.datetime,
        weather: r.weather, cause: r.cause, vehicle: r.vehicle, area: r.area,
      }))),
    );
  } catch {
    /* storage full or blocked: the in-memory report still shows this session */
  }
}

/** Merge shared and local reports, de-duplicated by content signature. */
export function mergeCitizenReports(shared: readonly CitizenRecord[], local: readonly CitizenRecord[]): CitizenRecord[] {
  const seen = new Set(shared.map(reportSignature));
  const out = [...shared];
  for (const report of local) {
    const key = reportSignature(report);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(report);
  }
  return out;
}

export type SubmitResult = { ok: true; id?: string | undefined } | { ok: false; error: string };

/** POST one report to the shared backend, with the established abort budget. */
export async function submitReport(report: ReportPayload): Promise<SubmitResult> {
  try {
    const data = await fetchJson<{ id?: string }>(`${apiBase()}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
    return { ok: true, id: data?.id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
