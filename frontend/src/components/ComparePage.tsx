import { useEffect, useMemo, useRef, useState } from 'react';

import { CAUSES, SEV } from '../domain/constants.ts';
import { compareDimensions, computeAreaStats, formatDimension, type AreaStats } from '../domain/compare.ts';
import type { AccidentRecord } from '../domain/engine.ts';
import { BASE_OPTIONS, catAxis, readPalette, themeChartDefaults, valAxis } from '../lib/charts.ts';

interface Props {
  records: readonly AccidentRecord[];
  monthCount: number;
  theme: 'light' | 'dark';
}

function cmpColors(): { a: string; b: string } {
  const css = getComputedStyle(document.documentElement);
  return { a: css.getPropertyValue('--cmpA').trim(), b: css.getPropertyValue('--cmpB').trim() };
}

function ChartBox({ id, config, theme, height = 260 }: { id: string; config: Record<string, unknown>; theme: string; height?: number }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<any>(null);
  useEffect(() => {
    if (!canvas.current) return;
    themeChartDefaults(readPalette());
    chart.current = new Chart(canvas.current, { ...config, options: { ...BASE_OPTIONS, ...(config.options as object ?? {}) } });
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, theme]);
  return <div style={{ height, position: 'relative' }}><canvas id={id} ref={canvas} /></div>;
}

export function ComparePage({ records, monthCount, theme }: Props): JSX.Element {
  const stats = useMemo(() => computeAreaStats(records, monthCount), [records, monthCount]);
  const names = useMemo(() => Object.keys(stats).sort((a, b) => (stats[b]?.total ?? 0) - (stats[a]?.total ?? 0)), [stats]);
  const [aLabe, setA] = useState<string>('');
  const [bLabe, setB] = useState<string>('');
  const a = stats[aLabe || names[1] || ''] ?? null;
  const b = stats[bLabe || names[0] || ''] ?? null;

  const pal = readPalette();
  const cmp = cmpColors();

  const severityConfig = useMemo(() => (a && b ? {
    type: 'bar',
    data: {
      labels: ['Fatal', 'Serious', 'Slight'],
      datasets: [
        { label: a.area, data: [a.fatal, a.serious, a.slight], backgroundColor: cmp.a, borderRadius: 2 },
        { label: b.area, data: [b.fatal, b.serious, b.slight], backgroundColor: cmp.b, borderRadius: 2 },
      ],
    },
    options: { plugins: { legend: { position: 'top', align: 'end' } }, scales: { x: catAxis(pal), y: valAxis(pal) } },
  } : null), [a, b, cmp.a, cmp.b, pal]);

  const hourConfig = useMemo(() => (a && b ? {
    type: 'line',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`),
      datasets: [
        { label: a.area, data: a.hour, borderColor: cmp.a, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3 },
        { label: b.area, data: b.hour, borderColor: cmp.b, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3 },
      ],
    },
    options: { plugins: { legend: { position: 'top', align: 'end' } }, scales: { x: catAxis(pal), y: valAxis(pal) } },
  } : null), [a, b, cmp.a, cmp.b, pal]);

  const causeConfig = useMemo(() => (a && b ? {
    type: 'bar',
    data: {
      labels: CAUSES,
      datasets: [
        { label: a.area, data: CAUSES.map((c) => a.cause[c] ?? 0), backgroundColor: cmp.a, borderRadius: 2 },
        { label: b.area, data: CAUSES.map((c) => b.cause[c] ?? 0), backgroundColor: cmp.b, borderRadius: 2 },
      ],
    },
    options: { indexAxis: 'y', plugins: { legend: { position: 'top', align: 'end' } }, scales: { x: valAxis(pal), y: catAxis(pal) } },
  } : null), [a, b, cmp.a, cmp.b, pal]);

  if (!a || !b) {
    return (
      <section className="app-section active" role="tabpanel" aria-label="Compare">
        <div className="report-root"><div className="section"><div className="stitle">No area data available.</div></div></div>
      </section>
    );
  }

  const rows = compareDimensions(a, b);
  const better = (dim: ReturnType<typeof compareDimensions>[number]): 'a' | 'b' | null => {
    if (dim.a === dim.b) return null;
    const aWins = dim.higherIsWorse ? dim.a < dim.b : dim.a > dim.b;
    return aWins ? 'a' : 'b';
  };

  return (
    <section className="app-section active" role="tabpanel" aria-label="Compare">
      <div className="report-root">
        <div className="section">
          <div className="slabel">Compare areas</div>
          <div className="stitle">Two corners, head to head.</div>
          <div className="sdesc">Every dimension below is computed from the same records as the map and the analytics studio.</div>

          <div className="compare-picks">
            <label className="af-field">
              <span className="af-label">Area A</span>
              <select className="af-select" value={aLabe || names[1] || ''} onChange={(e) => setA(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <button className="rc-btn ghost" type="button" onClick={() => { setA(bLabe || names[0] || ''); setB(aLabe || names[1] || ''); }}>Swap</button>
            <label className="af-field">
              <span className="af-label">Area B</span>
              <select className="af-select" value={bLabe || names[0] || ''} onChange={(e) => setB(e.target.value)}>
                {names.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>

          <div className="analytic-grid">
            <div className="analytic-card">
              <div className="analytic-card-head">
                <div className="analytic-card-title">Head to head</div>
                <div className="analytic-card-note">Underline marks the lighter side on each dimension</div>
              </div>
              <table className="compare-table">
                <thead>
                  <tr><th>Dimension</th><th style={{ color: cmp.a }}>{a.area}</th><th style={{ color: cmp.b }}>{b.area}</th></tr>
                </thead>
                <tbody>
                  {rows.map((dim) => {
                    const win = better(dim);
                    return (
                      <tr key={dim.key}>
                        <td>{dim.label}</td>
                        <td className={win === 'a' ? 'win' : ''}>{formatDimension(dim, dim.a)}</td>
                        <td className={win === 'b' ? 'win' : ''}>{formatDimension(dim, dim.b)}</td>
                      </tr>
                    );
                  })}
                  <tr><td>Dominant cause</td><td>{a.topCause}</td><td>{b.topCause}</td></tr>
                  <tr><td>Top vehicle</td><td>{a.topVehicle}</td><td>{b.topVehicle}</td></tr>
                </tbody>
              </table>
            </div>

            <div className="analytic-card">
              <div className="analytic-card-head">
                <div className="analytic-card-title">Severity split</div>
                <div className="analytic-card-note">Fatal / serious / slight for each area</div>
              </div>
              {severityConfig ? <ChartBox id="cmpSeverity" config={severityConfig} theme={theme} /> : null}
            </div>

            <div className="analytic-card">
              <div className="analytic-card-head">
                <div className="analytic-card-title">Hour of day</div>
                <div className="analytic-card-note">When each area's incidents happen</div>
              </div>
              {hourConfig ? <ChartBox id="cmpHour" config={hourConfig} theme={theme} /> : null}
            </div>

            <div className="analytic-card">
              <div className="analytic-card-head">
                <div className="analytic-card-title">Causes</div>
                <div className="analytic-card-note">Recorded cause mix, side by side</div>
              </div>
              {causeConfig ? <ChartBox id="cmpCauses" config={causeConfig} theme={theme} height={320} /> : null}
            </div>
          </div>

          <div className="footnote" style={{ marginTop: 14 }}>
            Severity colours: {(['fatal', 'serious', 'slight'] as const).map((s) => `${SEV[s].label} ${SEV[s].color}`).join(' · ')}.
            Comparison series use the A/B palette (--cmpA / --cmpB).
          </div>
        </div>
      </div>
    </section>
  );
}

export type { AreaStats };
