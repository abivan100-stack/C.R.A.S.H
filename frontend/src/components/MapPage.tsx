import { useEffect, useMemo, useRef, useState } from 'react';

import {
  BBOX, CELL, CAUSES, DOW, EMERGE_LIFT, EMERGE_MIN_RECENT, EMERGE_TOP_N,
  RECENT_MONTHS, SEV, SEGMENTS, SUPPRESS, TOP_N, isSeverity,
} from '../domain/constants.ts';
import { computeEmerging, gridCells, topJunctions } from '../domain/engine.ts';
import type { AccidentRecord, EmergingHotspot, GridCell } from '../domain/engine.ts';
import { DEFAULT_FILTERS, activeFilterCount, filterNote, filterRecords, type MapFilters } from '../domain/filters.ts';
import { zoneReportData, type ZoneReportData } from '../domain/reportData.ts';
import { exportZonePdf } from '../lib/pdf.ts';
import { escapeHtml, fmt, pad2, pct, sortedEntries } from '../lib/utils.ts';
import { addBaseLayer, refreshBaseLayer, type Theme } from '../lib/maptiler.ts';
import { Icon } from './Icon.tsx';

interface Props {
  records: readonly AccidentRecord[];
  monthCount: number;
  theme: Theme;
}

interface SelectedCell {
  cell: GridCell;
  records: AccidentRecord[];
  zone: ZoneReportData;
}

function popupHtml(a: AccidentRecord): string {
  const severity = isSeverity(a.severity) ? SEV[a.severity] : SEV.slight;
  return `<div class="hotspot-pop"><div style="font:600 12px Roboto,sans-serif;margin-bottom:4px">${escapeHtml(a.area)}</div>`
    + `<div style="font:400 11px 'IBM Plex Mono',monospace;color:${severity.color}">${severity.label}</div>`
    + `<div style="font:400 10.5px 'IBM Plex Mono',monospace;color:var(--text-3)">${escapeHtml(a.datetime)} - ${escapeHtml(a.cause)}</div></div>`;
}

function bloomRadius(norm: number | undefined): number {
  const n = norm ?? 50;
  return 10 + Math.round((n / 100) * 20);
}

function MapCanvas({ points, blooms, pulses, theme, onCellClick }: {
  points: readonly AccidentRecord[];
  blooms: readonly GridCell[];
  pulses: readonly EmergingHotspot[];
  theme: Theme;
  onCellClick: (lat: number, lng: number) => void;
}): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const pointLayer = useRef<any>(null);
  const bloomLayer = useRef<any>(null);
  const pulseLayer = useRef<any>(null);
  const tiles = useRef<any>(null);
  const renderer = useRef<any>(null);
  const clickRef = useRef(onCellClick);
  clickRef.current = onCellClick;

  useEffect(() => {
    if (!el.current || map.current) return;
    const instance = L.map(el.current, {
      center: [13.05, 80.23],
      zoom: 11,
      zoomControl: true,
      attributionControl: true,
      zoomSnap: 0.25,
      minZoom: 10,
      maxZoom: 18,
      preferCanvas: true,
    });
    map.current = instance;
    tiles.current = addBaseLayer(instance, theme);
    renderer.current = L.canvas({ padding: 0.5 });
    instance.on('click', (e: { latlng: { lat: number; lng: number } }) => clickRef.current(e.latlng.lat, e.latlng.lng));
    const timer = setTimeout(() => instance.invalidateSize(), 0);
    return () => {
      clearTimeout(timer);
      instance.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refreshBaseLayer(tiles.current, theme);
  }, [theme]);

  useEffect(() => {
    if (!map.current) return;
    pointLayer.current?.remove();
    const group = L.layerGroup();
    for (const a of points) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;
      const severity = isSeverity(a.severity) ? SEV[a.severity] : SEV.slight;
      const marker = L.circleMarker([a.lat, a.lng], a.citizen
        ? { renderer: renderer.current, radius: 5, stroke: true, color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), weight: 2, opacity: 0.95, fillColor: severity.color, fillOpacity: 0.85 }
        : { renderer: renderer.current, radius: 3.2, stroke: false, fillColor: severity.color, fillOpacity: 0.5 });
      marker.bindPopup(popupHtml(a), { closeButton: true, autoPan: true });
      marker.addTo(group);
    }
    group.addTo(map.current);
    pointLayer.current = group;
  }, [points]);

  useEffect(() => {
    if (!map.current) return;
    bloomLayer.current?.remove();
    const group = L.layerGroup();
    for (const cell of blooms) {
      L.circleMarker([cell.lat, cell.lng], {
        renderer: renderer.current,
        radius: bloomRadius(cell.norm),
        stroke: true,
        color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        weight: 1.2,
        opacity: 0.55,
        fillColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        fillOpacity: 0.08,
        bubblingMouseEvents: false,
      }).addTo(group);
    }
    group.addTo(map.current);
    bloomLayer.current = group;
  }, [blooms]);

  useEffect(() => {
    if (!map.current) return;
    pulseLayer.current?.remove();
    const group = L.layerGroup();
    for (const cell of pulses) {
      const marker = L.circleMarker([cell.lat, cell.lng], {
        renderer: renderer.current,
        radius: 7,
        stroke: true,
        color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        weight: 2,
        opacity: 0.9,
        fillColor: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        fillOpacity: 0.18,
        className: 'pulse-marker',
        bubblingMouseEvents: false,
      });
      marker.bindTooltip(`${escapeHtml(cell.area)} - emerging +${cell.pct}%`, { direction: 'top', opacity: 1 });
      marker.addTo(group);
    }
    group.addTo(map.current);
    pulseLayer.current = group;
  }, [pulses]);

  return <div id="map" ref={el} />;
}

function hourBars(zone: ZoneReportData): JSX.Element {
  const max = Math.max(...zone.hour, 1);
  return (
    <div className="dz-hours" aria-label="Incidents by hour">
      {zone.hour.map((count, h) => (
        <i key={h} style={{ height: `${Math.max(3, Math.round((count / max) * 34))}px` }} title={`${pad2(h)}:00 - ${count} incidents`} />
      ))}
    </div>
  );
}

export function MapPage({ records, monthCount, theme }: Props): JSX.Element {
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const mapRef = useRef<any>(null);

  const filtered = useMemo(() => filterRecords(records, filters), [records, filters]);
  const cells = useMemo(() => gridCells(filtered, BBOX, CELL, RECENT_MONTHS, monthCount), [filtered, monthCount]);
  const top = useMemo(() => topJunctions(cells.slice(), TOP_N, SUPPRESS), [cells]);
  const emerging = useMemo(
    () => computeEmerging(gridCells(records, BBOX, CELL, RECENT_MONTHS, monthCount), RECENT_MONTHS, monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS),
    [records, monthCount],
  );

  const selected: SelectedCell | null = useMemo(() => {
    if (!selectedKey) return null;
    const cell = cells.find((c) => c.key === selectedKey);
    if (!cell) return null;
    const cellRecords = filtered.filter((a) => Math.floor((a.lat - BBOX.latMin) / CELL) === cell.ci && Math.floor((a.lng - BBOX.lngMin) / CELL) === cell.cj);
    return { cell, records: cellRecords, zone: zoneReportData(cellRecords) };
  }, [selectedKey, cells, filtered]);

  function set<K extends keyof MapFilters>(key: K, value: MapFilters[K]): void {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function pick(cell: GridCell): void {
    setSelectedKey(cell.key);
    if (mapRef.current) mapRef.current.flyTo([cell.lat, cell.lng], 14, { duration: 0.6 });
  }

  function pickAt(lat: number, lng: number): void {
    const ci = Math.floor((lat - BBOX.latMin) / CELL);
    const cj = Math.floor((lng - BBOX.lngMin) / CELL);
    const cell = cells.find((c) => c.ci === ci && c.cj === cj);
    if (cell) setSelectedKey(cell.key);
    else setSelectedKey(null);
  }

  const badge = activeFilterCount(filters);

  return (
    <section className="app-section active" role="tabpanel" aria-label="Map">
      <div className="map-root">
        <aside id="rail" style={{ width: 296, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', borderRight: '1px solid var(--border)' }}>
          <div style={{ padding: '14px 16px 11px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
            <div style={{ font: "500 10px 'IBM Plex Mono', monospace", letterSpacing: '0.18em', color: 'var(--text-2)', textTransform: 'uppercase' }}>Ranked danger index</div>
            <div style={{ font: '400 11px Roboto, sans-serif', color: 'var(--text-2)', marginTop: 4 }}>Top {top.length} junctions - severity-weighted</div>
            <div style={{ font: "400 10px 'IBM Plex Mono', monospace", color: 'var(--accent)', marginTop: 3, minHeight: 13 }}>
              {filterNote(filters, filtered.length, records.length)}
            </div>
          </div>
          <div id="railList" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {top.length === 0 ? (
              <div style={{ padding: '18px 16px', font: '400 11px Roboto, sans-serif', color: 'var(--text-3)' }}>No incidents match the current filters.</div>
            ) : (
              top.map((cell, i) => {
                const rising = emerging.some((e) => e.id === cell.key);
                return (
                  <button
                    key={cell.key}
                    type="button"
                    aria-pressed={selectedKey === cell.key}
                    onClick={() => pick(cell)}
                    style={{
                      display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) auto', columnGap: 10,
                      width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--border-soft)',
                      padding: '11px 14px 12px', cursor: 'pointer', color: 'var(--text)', font: '400 12px Roboto, sans-serif',
                      background: selectedKey === cell.key ? 'rgba(47,92,135,0.07)' : 'transparent',
                      boxShadow: selectedKey === cell.key ? 'inset 2px 0 0 var(--accent)' : 'none',
                    }}
                  >
                    <span style={{ font: "500 13px 'IBM Plex Mono', monospace", color: i < 3 ? 'var(--text)' : 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', font: '500 13px Roboto, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {rising ? <span style={{ color: 'var(--accent)', fontSize: 10, marginRight: 4 }} title="Emerging: recent rate rising">*</span> : null}
                        {cell.area || 'Unknown area'}
                      </span>
                      <span style={{ display: 'flex', gap: 2, height: 4, marginTop: 5, borderRadius: 2, overflow: 'hidden' }}>
                        <i style={{ width: `${(cell.fatal / cell.count) * 100}%`, background: SEV.fatal.color }} />
                        <i style={{ width: `${(cell.serious / cell.count) * 100}%`, background: SEV.serious.color }} />
                        <i style={{ width: `${(cell.slight / cell.count) * 100}%`, background: SEV.slight.color }} />
                      </span>
                      <span style={{ display: 'block', font: "400 10px 'IBM Plex Mono', monospace", color: 'var(--text-3)', marginTop: 5 }}>
                        {fmt(cell.count)} incidents - {fmt(cell.fatal)} fatal
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span style={{ display: 'block', font: "500 15px 'IBM Plex Mono', monospace", color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{cell.norm ?? 0}</span>
                      <span style={{ display: 'block', font: "400 8px 'IBM Plex Mono', monospace", color: 'var(--text-3)', letterSpacing: '0.08em' }}>RISK /100</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div style={{ flex: 'none', padding: '10px 16px 12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ font: "400 9.5px 'IBM Plex Mono', monospace", color: 'var(--text-3)', lineHeight: 1.5 }}>
              Risk score = severity-weighted incidents (fatal x3, serious x2, slight x1) per 250 m cell.
              Blooms mark the top cells; pulsing rings are emerging hotspots.
            </div>
          </div>
        </aside>

        <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize ranked index panel" tabIndex={0} style={{ width: 3, flex: 'none', cursor: 'col-resize', background: 'var(--border-soft)' }} />

        <div style={{ flex: 1, position: 'relative', minWidth: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <MapCanvas
            points={filtered}
            blooms={top}
            pulses={emerging}
            theme={theme}
            onCellClick={pickAt}
          />

          <div style={{ position: 'absolute', top: 12, left: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <button className="mapfilter-btn" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="list-filter" size={12} /> Filters
              <span className="mapfilter-count">{badge}</span>
              <Icon name="chevron-down" size={10} />
            </button>
            {open ? (
              <div className="mapfilter-panel">
                <Seg label="Source" options={SEGMENTS.source.options} value={filters.source} onPick={(v) => set('source', v as MapFilters['source'])} />
                <Seg label="Severity" options={SEGMENTS.sev.options} value={filters.sev} onPick={(v) => set('sev', v as MapFilters['sev'])} />
                <Seg label="Time of day" options={SEGMENTS.time.options} value={filters.time} onPick={(v) => set('time', v as MapFilters['time'])} />
                <Seg label="Weather" options={SEGMENTS.weather.options} value={filters.weather} onPick={(v) => set('weather', v as MapFilters['weather'])} />
                <Seg label="Day of week" options={SEGMENTS.dow.options} value={filters.dow} onPick={(v) => set('dow', v as MapFilters['dow'])} />
                <div className="af-field">
                  <span className="af-label">Cause</span>
                  <select className="af-select" value={filters.cause} onChange={(e) => set('cause', e.target.value as MapFilters['cause'])}>
                    <option value="all">All causes</option>
                    {CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="mapfilter-foot">
                  <span>{fmt(filtered.length)} incidents</span>
                  <button type="button" className="mapfilter-reset" onClick={() => setFilters(DEFAULT_FILTERS)}>Reset</button>
                </div>
              </div>
            ) : null}
            <div className="maplegend">
              <span><i style={{ background: SEV.fatal.color }} />Fatal</span>
              <span><i style={{ background: SEV.serious.color }} />Serious</span>
              <span><i style={{ background: SEV.slight.color }} />Slight</span>
              <span><i className="ring" />Bloom</span>
              <span><i className="pulse" />Emerging</span>
            </div>
          </div>
        </div>

        {selected ? (
          <aside className="dossier" aria-label="Zone dossier">
            <div className="dossier-head">
              <div>
                <div className="dossier-label">Zone dossier</div>
                <div className="dossier-area">{selected.cell.area || 'Unknown area'}</div>
                <div className="dossier-coords">{selected.cell.lat.toFixed(5)}, {selected.cell.lng.toFixed(5)}</div>
              </div>
              <button type="button" className="dossier-close" aria-label="Close dossier" onClick={() => setSelectedKey(null)}>&times;</button>
            </div>

            <div className="dossier-body">
              <div className="dossier-kpis">
                <div><b style={{ color: SEV.fatal.color }}>{fmt(selected.zone.sev.fatal)}</b><span>Fatal</span></div>
                <div><b style={{ color: SEV.serious.color }}>{fmt(selected.zone.sev.serious)}</b><span>Serious</span></div>
                <div><b style={{ color: SEV.slight.color }}>{fmt(selected.zone.sev.slight)}</b><span>Slight</span></div>
                <div><b>{pct(selected.zone.night, selected.zone.total || 1)}</b><span>Night</span></div>
              </div>

              <div className="dossier-section">
                <div className="dossier-sec-title">Temporal rhythm</div>
                {hourBars(selected.zone)}
                <div className="dossier-note">Peak hour {pad2(selected.zone.peakHour)}:00 - peak day {DOW[selected.zone.peakDow] ?? ''}</div>
              </div>

              <div className="dossier-section">
                <div className="dossier-sec-title">Weather mix</div>
                <div className="dossier-rows">
                  {(['clear', 'rain', 'fog'] as const).map((w) => (
                    <div className="dossier-row" key={w}>
                      <span>{w[0]?.toUpperCase() + w.slice(1)}</span>
                      <b>{fmt(selected.zone.weather[w])}</b>
                      <i style={{ width: `${Math.round((selected.zone.weather[w] / (selected.zone.total || 1)) * 100)}%` }} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="dossier-section">
                <div className="dossier-sec-title">Dominant causes</div>
                <div className="dossier-rows">
                  {sortedEntries(selected.zone.cause).slice(0, 3).map(([name, count]) => (
                    <div className="dossier-row" key={name}>
                      <span>{name}</span>
                      <b>{fmt(count)}</b>
                      <i style={{ width: `${Math.round((count / (selected.zone.total || 1)) * 100)}%` }} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="dossier-section dossier-iv">
                <div className="dossier-sec-title">Recommended intervention</div>
                <div className="dossier-iv-fix">{selected.zone.iv.fix}</div>
                <div className="dossier-iv-meta">Cost {selected.zone.iv.cost} - modelled effectiveness {Math.round(selected.zone.iv.eff * 100)}%</div>
                <div className="dossier-iv-prevent">~ {fmt(selected.zone.preventable)} severe crashes preventable</div>
              </div>

              <button
                type="button"
                className="rc-btn"
                onClick={() => exportZonePdf(selected.zone, { area: selected.cell.area, lat: selected.cell.lat, lng: selected.cell.lng })}
              >
                <Icon name="file-text" size={14} /> Download zone PDF
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}

function Seg<T extends string | number>({ label, options, value, onPick }: {
  label: string;
  options: ReadonlyArray<{ label: string; value: T }>;
  value: T;
  onPick: (value: T) => void;
}): JSX.Element {
  return (
    <div className="af-field">
      <span className="af-label">{label}</span>
      <div className="segctl">
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onPick(o.value)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}
