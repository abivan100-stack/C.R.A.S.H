import { useMemo, useState } from 'react';

import { BBOX, SEV } from '../domain/constants.ts';
import type { AccidentRecord } from '../domain/engine.ts';
import {
  buildModel, normalizeScenario, runSimulation, summarize,
  type DayType, type ProjectionSummary, type Scenario, type TimeOfDay, type Weather,
} from '../domain/simulation.ts';
import { fmt } from '../lib/utils.ts';
import { Icon } from './Icon.tsx';

interface Props {
  records: readonly AccidentRecord[];
  monthCount: number;
}

const TIMES: Array<{ value: TimeOfDay; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'day', label: 'Day' },
  { value: 'night', label: 'Night' },
];
const WEATHERS: Array<{ value: Weather; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'clear', label: 'Clear' },
  { value: 'rain', label: 'Rain' },
  { value: 'fog', label: 'Fog' },
];
const DAYS: Array<{ value: DayType; label: string }> = [
  { value: 'any', label: 'Any' },
  { value: 'weekday', label: 'Weekday' },
  { value: 'weekend', label: 'Weekend' },
];

export function SimulatePage({ records, monthCount }: Props): JSX.Element {
  const model = useMemo(() => buildModel(records, BBOX, monthCount), [records, monthCount]);
  const [scenario, setScenario] = useState<Scenario>({ timeOfDay: 'any', weather: 'any', dayType: 'any', horizonMonths: 6 });
  const [runs, setRuns] = useState(0);
  const [result, setResult] = useState<{ points: number; summary: ProjectionSummary } | null>(null);

  function set<K extends keyof Scenario>(key: K, value: Scenario[K]): void {
    const next = { ...scenario, [key]: value };
    setScenario(next);
    if (runs > 0) setResult(run(next, runs));
  }

  function run(next: Scenario = scenario, nonce = runs + 1): { points: number; summary: ProjectionSummary } {
    const normalized = normalizeScenario(next);
    const points = runSimulation(model, BBOX, normalized, nonce);
    return { points: points.length, summary: summarize(points, model) };
  }

  function start(): void {
    const next = runs + 1;
    setRuns(next);
    setResult(run(scenario, next));
  }

  const noHistory = result?.points === 0;

  return (
    <section className="app-section active" role="tabpanel" aria-label="Simulate">
      <div className="report-root">
        <div className="section">
          <div className="slabel">Intervention simulator</div>
          <div className="stitle">Project where risk concentrates.</div>
          <div className="sdesc">
            A probabilistic projection from the historical record, not a prediction of specific events. Choose the
            conditions and horizon, then run the simulation.
          </div>

          <div className="simctl-controls">
            <Seg label="Time of day" options={TIMES} value={scenario.timeOfDay} onPick={(v) => set('timeOfDay', v)} />
            <Seg label="Weather" options={WEATHERS} value={scenario.weather} onPick={(v) => set('weather', v)} />
            <Seg label="Day type" options={DAYS} value={scenario.dayType} onPick={(v) => set('dayType', v)} />
            <label className="af-field simctl-horizon">
              <span className="af-label">Horizon (months)</span>
              <input
                className="af-input"
                type="number"
                min={1}
                max={24}
                value={scenario.horizonMonths}
                onChange={(e) => set('horizonMonths', Math.min(24, Math.max(1, Number(e.target.value) || 6)))}
              />
            </label>
            <button className="rc-btn" type="button" onClick={start}>
              <Icon name="route" size={14} /> Run simulation
            </button>
          </div>

          {result === null ? (
            <div className="simctl-empty">
              <div className="simctl-empty-title">No projection yet</div>
              <div className="simctl-empty-note">Run the simulation to project where accidents are likely to concentrate over the chosen horizon.</div>
            </div>
          ) : noHistory ? (
            <div className="simctl-empty">
              <div className="simctl-empty-title">No historical match</div>
              <div className="simctl-empty-note">No past accidents match this exact combination of conditions, so there is nothing to project. Broaden a filter and run again.</div>
            </div>
          ) : (
            <div className="simctl-results">
              <div className="analytic-kpis">
                <div className="analytic-kpi"><span className="analytic-kpi-value">{fmt(result.summary.total)}</span><span className="analytic-kpi-label">Projected incidents</span></div>
                <div className="analytic-kpi"><span className="analytic-kpi-value" style={{ color: SEV.fatal.color }}>{fmt(result.summary.fatal)}</span><span className="analytic-kpi-label">Projected fatal</span></div>
                <div className="analytic-kpi"><span className="analytic-kpi-value" style={{ color: SEV.serious.color }}>{fmt(result.summary.serious)}</span><span className="analytic-kpi-label">Projected serious</span></div>
                <div className="analytic-kpi"><span className="analytic-kpi-value" style={{ color: SEV.slight.color }}>{fmt(result.summary.slight)}</span><span className="analytic-kpi-label">Projected slight</span></div>
              </div>

              <div className="analytic-card">
                <div className="analytic-card-head">
                  <div className="analytic-card-title">Where risk concentrates</div>
                  <div className="analytic-card-note">Top projected cells for this scenario and horizon</div>
                </div>
                <div className="report-list">
                  {result.summary.topCells.map((cell, i) => (
                    <div className="report-row" key={cell.cellId}>
                      <span className="report-rank">{String(i + 1).padStart(2, '0')}</span>
                      <span className="report-main">
                        <span className="report-area">{cell.area || 'Unknown area'}</span>
                        <span className="report-sub">cell {cell.cellId}</span>
                      </span>
                      <span className="report-sev">{fmt(cell.count)} projected</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="footnote" style={{ marginTop: 14 }}>
                Projection is deterministic for a given scenario and run number; changing any control re-projects the
                current run. Planning estimate, not a forecast of individual crashes.
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Seg<T extends string>({ label, options, value, onPick }: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T;
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <div className="af-field simctl-seg">
      <span className="af-label">{label}</span>
      <div className="simctl-seg-row">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onPick(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
