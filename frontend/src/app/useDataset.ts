import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BBOX, CELL, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N, MAX_WINDOW_MONTHS, RECENT_MONTHS, SUPPRESS, TOP_N } from '../domain/constants.ts';
import { computeEmerging, gridCells, monthMeta, precompute, topJunctions } from '../domain/engine.ts';
import type { AccidentRecord, EmergingList, GridCell } from '../domain/engine.ts';
import {
  mergeCitizenReports,
  fetchAccidents,
  fetchSharedReports,
  readLocalReports,
  reportSignature,
  type CitizenRecord,
} from './api.ts';
import { attachVisibilityPoll } from './polling.ts';

export const REPORT_POLL_MS = 8000;

export interface ReportNotification {
  id: string;
  area: string;
  severity: string;
  datetime: string;
}

export interface Dataset {
  loading: boolean;
  error: string | null;
  /** Static dataset without citizen reports. */
  base: AccidentRecord[];
  /** Every record, precomputed (internal _h/_night/_ym/_month fields attached). */
  records: AccidentRecord[];
  cells: GridCell[];
  top: GridCell[];
  emerging: EmergingList;
  monthCount: number;
  range: { min: number; max: number; count: number };
  citizen: CitizenRecord[];
  notifications: ReportNotification[];
  unread: number;
  addCitizenReport: (report: CitizenRecord) => void;
  clearNotifications: () => void;
}

function derive(base: readonly AccidentRecord[], citizen: readonly CitizenRecord[]) {
  /* precompute mutates, so every derivation works on a private copy. */
  const records = [...base, ...citizen].map((r) => ({ ...r }));
  const meta = precompute(records, MAX_WINDOW_MONTHS);
  const cells = gridCells(records, BBOX, CELL, RECENT_MONTHS, meta.monthCount);
  const top = topJunctions(cells, TOP_N, SUPPRESS);
  const emerging = computeEmerging(cells, RECENT_MONTHS, meta.monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS);
  return { records, cells, top, emerging, monthCount: meta.monthCount, range: monthMeta(records) };
}

export function useDataset(): Dataset {
  const [base, setBase] = useState<AccidentRecord[]>([]);
  const [shared, setShared] = useState<CitizenRecord[]>([]);
  const [local, setLocal] = useState<CitizenRecord[]>(() => readLocalReports());
  const [notifications, setNotifications] = useState<ReportNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const [accidents, sharedReports] = await Promise.all([fetchAccidents(), fetchSharedReports()]);
        if (!alive.current) return;
        setBase(accidents);
        setShared(sharedReports);
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  /* Cross-device sync: poll for shared reports while visible, immediately on
     return to the tab (attachVisibilityPoll pauses while hidden). */
  useEffect(() => {
    const stop = attachVisibilityPoll(REPORT_POLL_MS, () => {
      if (!alive.current) return;
      void fetchSharedReports().then((reports) => {
        if (!alive.current || reports.length === 0) return;
        setShared((prev) => {
          const known = new Set(prev.map(reportSignature));
          const fresh = reports.filter((r) => !known.has(reportSignature(r)));
          if (fresh.length === 0) return prev;
          setNotifications((n) => [
            ...fresh.map((r) => ({ id: String(r.id ?? reportSignature(r)), area: r.area, severity: r.severity, datetime: r.datetime })),
            ...n,
          ].slice(0, 40));
          setUnread((u) => u + fresh.length);
          return mergeCitizenReports(reports, prev);
        });
      });
    });
    return stop;
  }, []);

  const addCitizenReport = useCallback((report: CitizenRecord) => {
    setLocal((prev) => [...prev, report]);
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
    setUnread(0);
  }, []);

  const citizen = useMemo(() => mergeCitizenReports(shared, local), [shared, local]);
  const derived = useMemo(() => derive(base, citizen), [base, citizen]);

  return {
    loading,
    error,
    base,
    citizen,
    notifications,
    unread,
    addCitizenReport,
    clearNotifications,
    ...derived,
  };
}
