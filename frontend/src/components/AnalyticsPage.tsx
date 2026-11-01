import { useEffect, useMemo, useRef } from 'react';

import { aggregate, paretoSeries } from '../domain/analytics.ts';
import { CAUSES, DOW, SEV, isSeverity } from '../domain/constants.ts';
import type { AccidentRecord } from '../domain/engine.ts';
import { BASE_OPTIONS, catAxis, readPalette, themeChartDefaults, valAxis } from '../lib/charts.ts';
import { fmt } from '../lib/utils.ts';

interface Props {
  records: readonly AccidentRecord[];
  monthCount: number;
  theme: 'light' | 'dark';
}

type ChartConfig = Record<string, unknown>;

/** One Chart.js canvas; rebuilt when its config or the theme changes. */
function ChartBox({ id, config, theme, height = 220 }: { id: string; config: ChartConfig; theme: string; height?: number }): JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const chart = useRef<any>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const pal = readPalette();
    themeChartDefaults(pal);
    chart.current = new Chart(canvas.current, { ...config, options: { ...BASE_OPTIONS, ...(config.options as object ?? {}) } });
    return () => {
      chart.current?.destroy();
      chart.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, theme]);
  return <div style={{ height, position: 'relative' }}><canvas id={id} ref={canvas} /></div>;
}

export function AnalyticsPage({ records, monthCount, theme }: Props): JSX.Element {
  const pal = theme === 'dark'
    ? { accent: '#6FA3D0', day: '#5F7488', text: '#ECEAE4', text2: '#99A2AC', border: '#333B44', grid: '#2A313A', panel: '#1E232A', night: '#33475C' }
    : { accent: '#2F5C87', day: '#5F7488', text: '#221F18', text2: '#4E5963', border: '#B4BCC5', grid: '#CDD3D9', panel: '#F4F6F8', night: '#33475C' };

  const agg = useMemo(() => aggregate(records, monthCount), [records, monthCount]);
  const pareto = paretoSeries(agg);

  const severityConfig = useMemo<ChartConfig>(() => ({
    type: 'doughnut',
    data: {
      labels: ['Fatal', 'Serious', 'Slight'],
      datasets: [{
        data: [agg.sev.fatal, agg.sev.serious, agg.sev.slight],
        backgroundColor: [SEV.fatal.color, SEV.serious.color, SEV.slight.color],
        borderColor: pal.panel,
        borderWidth: 2,
      }],
    },
    options: {
      cutout: '62%',
      plugins: { legend: { position: 'bottom' } },
    },
  }), [agg.sev, pal.panel]);

  const paretoConfig = useMemo<ChartConfig>(() => ({
    data: {
      labels: pareto.labels,
      datasets: [
        { type: 'bar', label: 'Severe incidents', data: pareto.severe, backgroundColor: pal.accent, borderRadius: 2, order: 2, yAxisID: 'y' },
        { type: 'line', label: 'Cumulative %', data: pareto.cumulative, borderColor: pal.text, backgroundColor: pal.text, borderWidth: 1.5, pointRadius: 0, tension: 0.3, order: 1, yAxisID: 'y1' },
      ],
    },
    options: {
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: { x: catAxis(pal), y: valAxis(pal), y1: valAxis(pal, { position: 'right', grid: { display: false }, max: 100 }) },
    },
  }), [pareto, pal]);

  const causeRows = useMemo(() => CAUSES.map((c) => ({ label: c, value: agg.cause[c] ?? 0 })).sort((a, b) => b.value - a.value), [agg.cause]);
  const causeConfig = useMemo<ChartConfig>(() => ({
    type: 'bar',
    data: { labels: causeRows.map((r) => r.label), datasets: [{ label: 'Incidents', data: causeRows.map((r) => r.value), backgroundColor: pal.accent, borderRadius: 2 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: valAxis(pal), y: catAxis(pal) } },
  }), [causeRows, pal]);

  const vehRows = useMemo(() => Object.entries(agg.veh).sort((a, b) => b[1] - a[1]), [agg.veh]);
  const vehConfig = useMemo<ChartConfig>(() => ({
    type: 'bar',
    data: { labels: vehRows.map((r) => r[0]), datasets: [{ label: 'Incidents', data: vehRows.map((r) => r[1]), backgroundColor: pal.day, borderRadius: 2 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: valAxis(pal), y: catAxis(pal) } },
  }), [vehRows, pal]);

  const hourConfig = useMemo<ChartConfig>(() => ({
    type: 'line',
    data: {
      labels: Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`),
      datasets: [{ label: 'Incidents', data: agg.hour, borderColor: pal.accent, backgroundColor: 'transparent', borderWidth: 1.8, pointRadius: 0, tension: 0.3, fill: false }],
    },
    options: { plugins: { legend: { display: false } }, scales: { x: catAxis(pal), y: valAxis(pal) } },
  }), [agg.hour, pal]);

  const dowConfig = useMemo<ChartConfig>(() => ({
    type: 'bar',
    data: { labels: [...DOW], datasets: [{ label: 'Incidents', data: agg.dow, backgroundColor: pal.accent, borderRadius: 2 }] },
    options: { plugins: { legend: { display: false } }, scales: { x: catAxis(pal), y: valAxis(pal) } },
  }), [agg.dow, pal]);

  const weatherConfig = useMemo<ChartConfig>(() => ({
    type: 'bar',
    data: {
      labels: ['Clear', 'Rain', 'Fog'],
      datasets: (['fatal', 'serious', 'slight'] as const).map((sev) => ({
        label: SEV[sev].label,
        data: [agg.wsev.clear[sev], agg.wsev.rain[sev], agg.wsev.fog[sev]],
        backgroundColor: SEV[sev].color,
        borderColor: pal.panel,
        borderWidth: 1,
      })),
    },
    options: {
      plugins: { legend: { position: 'top', align: 'end' } },
      scales: { x: catAxis(pal, { stacked: true }), y: valAxis(pal, { stacked: true }) },
    },
  }), [agg.wsev, pal]);

  if (records.length === 0) {
    return (
      <section className="app-section active" role="tabpanel" aria-label="Analytics">
        <div className="report-root"><div className="section"><div className="slabel">Analytics</div><div className="stitle">No incidents match the current data.</div></div></div>
      </section>
    );
  }

  return (
    <section className="app-section active" role="tabpanel" aria-label="Analytics">
      <div className="report-root">
        <div className="section">
          <div className="slabel">Analytics &amp; insights</div>
          <div className="stitle">The city's road-safety picture, at a glance.</div>
          <div className="sdesc">
            Severity, cause, vehicle, timing, weather and concentration — computed live from the same records that drive the map.
          </div>

          <div className="analytic-kpis">
            <Kpi label="Incidents" value={fmt(agg.total)} />
            <Kpi label="Fatal" value={fmt(agg.sev.fatal)} />
            <Kpi label="Severe" value={fmt(agg.sev.fatal + agg.sev.serious)} />
            <Kpi label="Risk zones" value={fmt(agg.highRisk)} />
            <Kpi label="Emerging" value={fmt(agg.emerging.qualifyingCount)} />
            <Kpi label="Per month" value={fmt(agg.avgPerMonth)} />
          </div>

          <div className="analytic-leverage">
            <b>{agg.leveragePct}%</b> of the city's severe crashes occur in the top {agg.top.length} junction cells
            ({fmt(agg.sevTop)} of {fmt(agg.sevCity)} fatal + serious).
          </div>

          <div className="analytic-grid">
            <ChartCard title="Severity split" note="Fatal / serious / slight over every record">
              <ChartBox id="chartSeverity" config={severityConfig} theme={theme} height={240} />
            </ChartCard>
            <ChartCard title="Concentration (Pareto)" note="Top cells by severe incidents and their cumulative share">
              <ChartBox id="chartPareto" config={paretoConfig} theme={theme} height={240} />
            </ChartCard>
            <ChartCard title="Causes" note="Recorded causes, most frequent first">
              <ChartBox id="chartCauses" config={causeConfig} theme={theme} height={300} />
            </ChartCard>
            <ChartCard title="Vehicles involved" note="Vehicle type recorded at the incident">
              <ChartBox id="chartVehicles" config={vehConfig} theme={theme} height={300} />
            </ChartCard>
            <ChartCard title="Hour of day" note="When incidents happen, 00:00 to 23:00">
              <ChartBox id="chartHour" config={hourConfig} theme={theme} />
            </ChartCard>
            <ChartCard title="Day of week" note="Weekday rhythm across the record">
              <ChartBox id="chartDow" config={dowConfig} theme={theme} />
            </ChartCard>
            <ChartCard title="Weather mix" note="Incident severity under clear, rain and fog">
              <ChartBox id="chartWeather" config={weatherConfig} theme={theme} />
            </ChartCard>
            <ChartCard title="Severity colours" note="The same data vocabulary used on the map">
              <ul className="analytic-legend">
                {(['fatal', 'serious', 'slight'] as const).map((s) => (
                  <li key={s}><i style={{ background: SEV[s].color }} />{isSeverity(s) ? SEV[s].label : s}</li>
                ))}
              </ul>
            </ChartCard>
          </div>
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="analytic-kpi">
      <span className="analytic-kpi-value">{value}</span>
      <span className="analytic-kpi-label">{label}</span>
    </div>
  );
}

function ChartCard({ title, note, children }: { title: string; note: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="analytic-card">
      <div className="analytic-card-head">
        <div className="analytic-card-title">{title}</div>
        <div className="analytic-card-note">{note}</div>
      </div>
      {children}
    </div>
  );
}
