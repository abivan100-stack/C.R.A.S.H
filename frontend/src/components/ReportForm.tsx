import { useMemo, useState } from 'react';

import { CAUSES, SEV, SEVERITIES, VEHICLES, WEATHERS } from '../domain/constants.ts';
import type { AccidentRecord } from '../domain/engine.ts';
import { uniqueAreas } from '../domain/geo.ts';
import { nowLocalInput, toStoredDatetime, validateReport, type ReportDraft, type ReportField, type ReportIssue } from '../domain/report.ts';
import { readLocalReports, submitReport, writeLocalReports, type CitizenRecord } from '../app/api.ts';
import { Icon } from './Icon.tsx';

interface Props {
  records: readonly AccidentRecord[];
  onSaved: (report: CitizenRecord) => void;
}

const EMPTY: ReportDraft = {
  lat: null,
  lng: null,
  severity: '',
  datetime: '',
  weather: 'clear',
  cause: '',
  vehicle: '',
  area: '',
};
const SEV_COLOR = { fatal: 'var(--fatal)', serious: 'var(--serious)', slight: 'var(--slight)' } as Record<string, string>;

function locationText(draft: ReportDraft): string {
  if (draft.lat == null || draft.lng == null) return 'No location set yet.';
  return `${draft.lat.toFixed(5)}, ${draft.lng.toFixed(5)}${draft.pickedArea ? ` - ${draft.pickedArea}` : ''}`;
}

export function ReportForm({ records, onSaved }: Props): JSX.Element {
  const areas = useMemo(() => uniqueAreas(records), [records]);
  const [draft, setDraft] = useState<ReportDraft>({ ...EMPTY, datetime: nowLocalInput() });
  const [issues, setIssues] = useState<ReportIssue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; text: string } | null>(null);

  const invalid = (field: ReportField): string => (issues.some((i) => i.field === field) ? ' invalid' : '');

  function update<K extends keyof ReportDraft>(key: K, value: ReportDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }));
    setError('');
    setIssues([]);
  }

  function changeArea(value: string): void {
    const typed = value.trim();
    if (!typed) {
      update('area', '');
      setDraft((d) => ({ ...d, lat: null, lng: null, pickedArea: null }));
      return;
    }
    const canonical = areas.find((a) => a.toLowerCase() === typed.toLowerCase());
    if (!canonical) {
      setDraft((d) => ({ ...d, area: value }));
      setError(`"${typed}" is not a known area. Pick one from the list.`);
      return;
    }
    const [cLat, cLng] = centroidFor(records, canonical);
    setDraft((d) => ({ ...d, area: canonical, pickedArea: canonical, lat: cLat, lng: cLng }));
    setError('');
    setIssues([]);
  }

  async function save(): Promise<void> {
    setIssues([]);
    setError('');
    /* The control stores datetime-local shape; the validator and payload use the backend shape. */
    const validation = validateReport({ ...draft, datetime: toStoredDatetime(draft.datetime) });
    if (!validation.ok) {
      setIssues(validation.issues);
      setError(validation.issues[0]?.message ?? 'Check the form.');
      return;
    }
    setBusy(true);
    const stored = { ...validation.report };
    const posted = await submitReport(stored);
    /* The backend is the shared store; localStorage is only the offline fallback. */
    let offline = false;
    if (!posted.ok) {
      offline = true;
      writeLocalReports([...readLocalReports(), { ...stored, citizen: true }]);
    }
    const saved: CitizenRecord = {
      ...stored,
      citizen: true,
      ...(offline ? {} : { shared: true }),
      id: posted.ok && posted.id ? `m${posted.id}` : `c${Date.now().toString(36)}`,
    };
    onSaved(saved);
    setBusy(false);
    setConfirm({
      title: offline ? 'Report saved offline' : 'Report saved',
      text: offline
        ? 'Backend unreachable, so it was saved offline on this device. It stays on the map and is counted in every statistic here.'
        : 'Saved to the shared reports database. It will show up on other devices too.',
    });
    setDraft({ ...EMPTY, datetime: nowLocalInput() });
  }

  return (
    <div className="section" id="reportFormSection">
      <div className="slabel">Contribute</div>
      <div className="stitle">Report an accident</div>
      <div className="sdesc">
        Saw a crash that isn't on the map? Add it here. Reports are sent to the shared CRASH database so they appear
        for everyone, and instantly update the map, hotspots and statistics. If the server can't be reached, your report
        is kept on this device and stays visible to you.
      </div>

      <div className="af-card">
        <div className="af-grid">
          <div className="af-field full">
            <div className="af-label">Location</div>
            <div className={`af-readout${invalid('location')}`}>{locationText(draft)}</div>
            <div className="af-hint">
              Pick an area below to place the report at its centre, or draw the exact spot on the map after the map shell
              lands. The coordinates are stored exactly as chosen.
            </div>
          </div>

          <div className="af-field">
            <label className="af-label" htmlFor="afArea">Area</label>
            <input
              className={`af-input${invalid('area')}`}
              id="afArea"
              list="afAreaList"
              placeholder="Type to search an area..."
              autoComplete="off"
              value={draft.area}
              onChange={(e) => changeArea(e.target.value)}
            />
            <datalist id="afAreaList">
              {areas.map((a) => <option key={a} value={a} />)}
            </datalist>
          </div>
          <div className="af-field">
            <div className="af-label">Selected location</div>
            <div className="af-readout">{locationText(draft)}</div>
          </div>

          <div className="af-field">
            <label className="af-label" htmlFor="afWhen">Date &amp; time</label>
            <input
              className={`af-input${invalid('datetime')}`}
              type="datetime-local"
              id="afWhen"
              max={nowLocalInput()}
              value={draft.datetime}
              onChange={(e) => update('datetime', toStoredDatetime(e.target.value))}
            />
          </div>
          <div className="af-field">
            <label className="af-label" htmlFor="afWeather">Weather</label>
            <select className={`af-select${invalid('weather')}`} id="afWeather" value={draft.weather} onChange={(e) => update('weather', e.target.value)}>
              {WEATHERS.map((w) => <option key={w} value={w}>{w[0]?.toUpperCase() + w.slice(1)}</option>)}
            </select>
          </div>

          <div className="af-field full">
            <div className="af-label">Severity</div>
            <div className={`af-sev${invalid('severity')}`} id="afSev" role="group" aria-label="Severity">
              {SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  data-sev={s}
                  aria-pressed={draft.severity === s}
                  onClick={() => update('severity', s)}
                  style={draft.severity === s ? { borderColor: SEV_COLOR[s], color: SEV_COLOR[s] } : undefined}
                >
                  <span className="dot" style={{ background: SEV_COLOR[s] }} />{SEV[s].label}
                </button>
              ))}
            </div>
          </div>

          <div className="af-field">
            <label className="af-label" htmlFor="afCause">Cause</label>
            <select className={`af-select${invalid('cause')}`} id="afCause" value={draft.cause} onChange={(e) => update('cause', e.target.value)}>
              <option value="">Select a cause...</option>
              {CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="af-field">
            <label className="af-label" htmlFor="afVehicle">Vehicle</label>
            <select className={`af-select${invalid('vehicle')}`} id="afVehicle" value={draft.vehicle} onChange={(e) => update('vehicle', e.target.value)}>
              <option value="">Select a vehicle...</option>
              {VEHICLES.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="af-field full">
            <div className="af-err" id="afErr" role="alert">{error}</div>
            <div className="af-actions">
              <button className="rc-btn" id="afSubmit" type="button" onClick={() => void save()} disabled={busy}>
                <Icon name="check" />{busy ? 'Saving...' : 'Submit report'}
              </button>
              <button
                className="rc-btn ghost"
                id="afReset"
                type="button"
                onClick={() => { setDraft({ ...EMPTY, datetime: nowLocalInput() }); setIssues([]); setError(''); setConfirm(null); }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirm ? (
        <div className="af-confirm" id="afConfirm" role="status">
          <div className="af-confirm-icon"><Icon name="check" size={18} /></div>
          <div className="af-confirm-body">
            <div className="af-confirm-title">{confirm.title}</div>
            <div className="af-confirm-text">{confirm.text}</div>
          </div>
          <button className="af-confirm-close" type="button" onClick={() => setConfirm(null)}>Report another</button>
        </div>
      ) : null}

      <div className="footnote" style={{ marginTop: 14 }}>
        Citizen reports are community-submitted and unverified. They are marked distinctly on the map and shared with
        everyone using CRASH - don't include personal details. Location, time, severity, cause and vehicle type are the
        only fields stored.
      </div>
    </div>
  );
}

function centroidFor(records: readonly AccidentRecord[], area: string): [number, number] {
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const r of records) {
    if (r.area !== area) continue;
    lat += r.lat;
    lng += r.lng;
    n += 1;
  }
  return n ? [lat / n, lng / n] : [13.05, 80.23];
}
