import { useEffect, useMemo, useRef, useState } from 'react';

import { BBOX, CELL, CAUSES, RECENT_MONTHS, SEV, SEGMENTS, SUPPRESS, TOP_N, isSeverity } from '../domain/constants.ts';
import { gridCells, topJunctions } from '../domain/engine.ts';
import type { AccidentRecord, GridCell } from '../domain/engine.ts';
import { DEFAULT_FILTERS, activeFilterCount, filterNote, filterRecords, type MapFilters } from '../domain/filters.ts';
import { escapeHtml, fmt } from '../lib/utils.ts';
import { addBaseLayer, refreshBaseLayer, type Theme } from '../lib/maptiler.ts';
import { Icon } from './Icon.tsx';

interface Props {
  records: readonly AccidentRecord[];
  monthCount: number;
  theme: Theme;
  onSelectCell?: (cell: GridCell) => void;
}

function popupHtml(a: AccidentRecord): string {
  const severity = isSeverity(a.severity) ? SEV[a.severity] : SEV.slight;
  return `<div class="hotspot-pop"><div style="font:600 12px Roboto,sans-serif;margin-bottom:4px">${escapeHtml(a.area)}</div>`
    + `<div style="font:400 11px 'IBM Plex Mono',monospace;color:${severity.color}">${severity.label}</div>`
    + `<div style="font:400 10.5px 'IBM Plex Mono',monospace;color:var(--text-3)">${escapeHtml(a.datetime)} - ${escapeHtml(a.cause)}</div></div>`;
}

function MapCanvas({ points, theme, onReady }: { points: readonly AccidentRecord[]; theme: Theme; onReady: (map: any) => void }): JSX.Element {
  const el = useRef<HTMLDivElement | null>(null);
  const map = useRef<any>(null);
  const layer = useRef<any>(null);
  const tiles = useRef<any>(null);
  const renderer = useRef<any>(null);

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
    onReady(instance);
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
    if (layer.current) layer.current.remove();
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
    layer.current = group;
  }, [points]);

  return <div id="map" ref={el} />;
}

const SEV_OPTIONS = SEGMENTS.sev.options;
const TIME_OPTIONS = SEGMENTS.time.options;
const WEATHER_OPTIONS = SEGMENTS.weather.options;
const DOW_OPTIONS = SEGMENTS.dow.options;
const SOURCE_OPTIONS = SEGMENTS.source.options;

export function MapPage({ records, monthCount, theme, onSelectCell }: Props): JSX.Element {
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const mapRef = useRef<any>(null);

  const filtered = useMemo(() => filterRecords(records, filters), [records, filters]);
  const top = useMemo(
    () => topJunctions(gridCells(filtered, BBOX, CELL, RECENT_MONTHS, monthCount), TOP_N, SUPPRESS),
    [filtered, monthCount],
  );

  function set<K extends keyof MapFilters>(key: K, value: MapFilters[K]): void {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function pick(cell: GridCell): void {
    setSelected(cell.key);
    onSelectCell?.(cell);
    if (mapRef.current) {
      mapRef.current.flyTo([cell.lat, cell.lng], 14, { duration: 0.6 });
    }
  }

  const badge = activeFilterCount(filters);

  return (
    <section className="app-section active" role="tabpanel" aria-label="Map">
      <div className="map-root">
        <aside id="rail" style={{ width: 296, flex: 'none', display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--panel)', borderRight: '1px solid var(--border)' }}>
          <div style={{ padding: '14px 16px 11px', borderBottom: '1px solid var(--border)', flex: 'none' }}>
            <div style={{ font: "500 10px 'IBM Plex Mono', monospace", letterSpacing: '0.18em', color: 'var(--text-2)', textTransform: 'uppercase' }}>Ranked danger index</div>
            <div style={{ font: '400 11px Roboto, sans-serif', color: 'var(--text-2)', marginTop: 4 }}>Top {top.length} junctions - severity-weighted</div>
            <div id="filterNote" style={{ font: "400 10px 'IBM Plex Mono', monospace", color: 'var(--accent)', marginTop: 3, minHeight: 13 }}>
              {filterNote(filters, filtered.length, records.length)}
            </div>
          </div>
          <div id="railList" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {top.length === 0 ? (
              <div style={{ padding: '18px 16px', font: '400 11px Roboto, sans-serif', color: 'var(--text-3)' }}>No incidents match the current filters.</div>
            ) : (
              top.map((cell, i) => (
                <button
                  key={cell.key}
                  type="button"
                  aria-pressed={selected === cell.key}
                  onClick={() => pick(cell)}
                  style={{
                    display: 'grid', gridTemplateColumns: '24px minmax(0, 1fr) auto', columnGap: 10,
                    width: '100%', textAlign: 'left', border: 'none', borderBottom: '1px solid var(--border-soft)',
                    padding: '11px 14px 12px', cursor: 'pointer', color: 'var(--text)', font: '400 12px Roboto, sans-serif',
                    background: selected === cell.key ? 'rgba(47,92,135,0.07)' : 'transparent',
                    boxShadow: selected === cell.key ? 'inset 2px 0 0 var(--accent)' : 'none',
                  }}
                >
                  <span style={{ font: "500 13px 'IBM Plex Mono', monospace", color: i < 3 ? 'var(--text)' : 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', font: '500 13px Roboto, sans-serif', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
              ))
            )}
          </div>
          <div style={{ flex: 'none', padding: '10px 16px 12px', borderTop: '1px solid var(--border)' }}>
            <div style={{ font: "400 9.5px 'IBM Plex Mono', monospace", color: 'var(--text-3)', lineHeight: 1.5 }}>
              Risk score = severity-weighted incidents (fatal x3, serious x2, slight x1) per 250 m cell.
            </div>
          </div>
        </aside>

        <div className="resizer" role="separator" aria-orientation="vertical" aria-label="Resize ranked index panel" tabIndex={0} style={{ width: 3, flex: 'none', cursor: 'col-resize', background: 'var(--border-soft)' }} />

        <div style={{ flex: 1, position: 'relative', minWidth: 0, background: 'var(--bg)', overflow: 'hidden' }}>
          <MapCanvas points={filtered} theme={theme} onReady={(m) => { mapRef.current = m; }} />

          <div style={{ position: 'absolute', top: 12, left: 14, zIndex: 20, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
            <button className="mapfilter-btn" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name="list-filter" size={12} /> Filters
              <span className="mapfilter-count">{badge}</span>
              <Icon name="chevron-down" size={10} />
            </button>
            {open ? (
              <div className="mapfilter-panel">
                <Seg label="Source" options={SOURCE_OPTIONS} value={filters.source} onPick={(v) => set('source', v as MapFilters['source'])} />
                <Seg label="Severity" options={SEV_OPTIONS} value={filters.sev} onPick={(v) => set('sev', v as MapFilters['sev'])} />
                <Seg label="Time of day" options={TIME_OPTIONS} value={filters.time} onPick={(v) => set('time', v as MapFilters['time'])} />
                <Seg label="Weather" options={WEATHER_OPTIONS} value={filters.weather} onPick={(v) => set('weather', v as MapFilters['weather'])} />
                <Seg label="Day of week" options={DOW_OPTIONS} value={filters.dow} onPick={(v) => set('dow', v as MapFilters['dow'])} />
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
          </div>
        </div>
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
