import { SEV, isSeverity } from '../domain/constants.ts';
import type { CitizenRecord } from '../app/api.ts';

/** Recent citizen reports, newest first. Values render as React text, never HTML. */
export function ReportList({ reports }: { reports: readonly CitizenRecord[] }): JSX.Element {
  const sorted = [...reports].sort((a, b) => b.datetime.localeCompare(a.datetime)).slice(0, 25);
  return (
    <div className="section">
      <div className="eyebrow">Reports</div>
      <h1 className="h-hero">Recent citizen reports.</h1>
      <p className="sub">
        Community-submitted incidents currently counted by the map and the statistics. Shared reports come from the
        backend; offline reports live on this device only.
      </p>
      {sorted.length === 0 ? (
        <div className="footnote">No citizen reports yet.</div>
      ) : (
        <div className="report-list">
          {sorted.map((r, i) => {
            const severity = isSeverity(r.severity) ? r.severity : 'slight';
            return (
              <div className="report-row" key={r.id ?? `${r.datetime}-${i}`}>
                <span className="report-rank">{String(i + 1).padStart(2, '0')}</span>
                <span className="report-main">
                  <span className="report-area">{r.area}</span>
                  <span className="report-sub">
                    {r.datetime} - {r.cause} - {r.vehicle}
                    {r.shared ? ' - shared' : ' - this device'}
                  </span>
                </span>
                <span className="report-sev" style={{ color: SEV[severity].color }}>
                  {SEV[severity].label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
