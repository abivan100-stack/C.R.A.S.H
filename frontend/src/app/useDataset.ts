import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BBOX, CELL, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N, MAX_WINDOW_MONTHS, RECENT_MONTHS, SUPPRESS, TOP_N } from '../domain/constants.ts';
import { computeEmerging, gridCells, monthMeta, precompute, topJunctions } from '../domain/engine.ts';
import type { AccidentRecord, EmergingList, GridCell } from '../domain/engine.ts';
import { mergeCitizenReports, fetchAccidents, fetchSharedReports, readLocalReports, type CitizenRecord } from './api.ts';

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
  addCitizenReport: (report: CitizenRecord) => void;
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
  const [citizen, setCitizen] = useState<CitizenRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const [accidents, shared] = await Promise.all([fetchAccidents(), fetchSharedReports()]);
        if (!alive.current) return;
        setBase(accidents);
        setCitizen(mergeCitizenReports(shared, readLocalReports()));
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

  const addCitizenReport = useCallback((report: CitizenRecord) => {
    setCitizen((prev) => [...prev, report]);
  }, []);

  const derived = useMemo(() => derive(base, citizen), [base, citizen]);

  return { loading, error, base, citizen, addCitizenReport, ...derived };
}
