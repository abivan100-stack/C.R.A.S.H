/* =============================================================================
   Chennai Road Accident Hotspot Analysis — data engine + live map
   Vanilla JS. Mounts onto the exported design's markup.
   PHASE 1: live CARTO Dark Matter basemap + severity-coloured accident points.
   ========================================================================== */

'use strict';

/* ---- Constants shared across phases ---- */
const SEV = {
  fatal:   { color: '#E4404E', label: 'Fatal',   weight: 3 },
  serious: { color: '#F2933E', label: 'Serious', weight: 2 },
  slight:  { color: '#E7C64B', label: 'Slight',  weight: 1 },
};
const ACCENT = '#43B0CC';

const CAUSES = ['Over-speeding', 'Wrong-side driving', 'Signal jumping', 'Drunken driving',
  'Mobile phone use', 'Hit and run', 'Pothole / bad road', 'Pedestrian crossing error',
  'Improper overtaking', 'Vehicle defect', 'Poor visibility'];
const VEHICLES = ['Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus (MTC/Private)',
  'Lorry / Truck', 'LCV / Van', 'Bicycle', 'Unknown (fled)'];

const CHENNAI = { center: [13.05, 80.23], zoom: 11 };
const BBOX = { latMin: 12.83, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 };

/* CARTO basemaps — dark for the dark theme, Positron for the light theme */
const TILES = {
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

/* Hotspot engine tuning */
const CELL = 0.0022;          // ~250 m grid cell
const TOP_N = 10;             // ranked danger index length
const SUPPRESS = 2;           // non-max suppression radius, in cells (~500 m):
                              // keeps the top-10 as 10 distinct junctions, not
                              // split halves of one cluster
const HIGH_RISK_MIN = 40;     // severity-weighted score for a cell to count as a "high-risk zone"
const SELECT_ZOOM = 15;       // zoom level when a hotspot is selected

/* Emerging-hotspot engine (Phase 2) — flag cells whose recent monthly rate is
   climbing sharply against their own longer baseline. */
const RECENT_MONTHS = 6;      // "recent" window = last 6 months of the record
const EMERGE_LIFT = 1.5;      // recent monthly rate must be >= 1.5x the baseline rate
const EMERGE_MIN_RECENT = 8;  // and have at least this many recent incidents (noise guard)
const EMERGE_TOP_N = 6;       // how many distinct emerging junctions to surface

/* Segmented filter definitions (wired live in Phase 5) */
const SEGMENTS = {
  sev:     { id: 'segSev',     options: [['All', 'all'], ['Fatal + serious', 'fs'], ['Fatal', 'f']] },
  time:    { id: 'segTime',    options: [['All', 'all'], ['Day', 'day'], ['Night', 'night']] },
  weather: { id: 'segWeather', options: [['All', 'all'], ['Clear', 'clear'], ['Rain', 'rain'], ['Fog', 'fog']] },
  dow:     { id: 'segDow', chips: true, options: [['All', 'all'], ['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]] },
};

/* ---- App state ---- */
const app = {
  raw: [],                 // all accident records
  map: null,
  pointLayer: null,
  bloomLayer: null,        // top-10 risk blooms
  bloomMarkers: {},        // hotspot id -> Leaflet marker
  focusRing: null,         // accent selection ring on the map
  hotspots: [],            // ranked top-10 cells (under the active filter)
  hotspotsFull: [],        // Phase 3: boot-time top-10 over ALL data (strategy view)
  emerging: [],            // Phase 2: distinct cells whose recent rate is surging
  emergingIds: null,       // Set of emerging cell ids (for the ranked-index badge)
  emergeLayer: null,       // pulsing map markers for emerging cells
  monthCount: 0,           // number of distinct months spanned by the data
  lastMonth: 0,            // index of the most recent month
  cellById: {},            // id -> inspectable cell under the active filter
  cellByIdFull: {},        // id -> inspectable cell over ALL data (never empty)
  hotspotById: {},         // alias of cellById (selection resolves against all cells)
  highRiskZones: 0,
  filtered: null,          // active filtered subset (null = use raw)
  selected: null,          // selected cell id
  selInfo: null,           // stable info for the selection (survives filter changes)
  tileLayer: null,         // basemap layer (swapped on theme change)
  dossierTab: 'zone',      // 'zone' (selected hotspot) | 'city' (contributing factors)
  filters: { sev: 'all', time: 'all', weather: 'all', dow: 'all', cause: 'all' },
};

/* ---- Small helpers ---- */
const fmt = (n) => n.toLocaleString('en-US');
function hourOf(dt) { return parseInt(dt.slice(11, 13), 10); }        // "YYYY-MM-DD HH:MM"
function isNight(dt) { const h = hourOf(dt); return h < 6 || h >= 18; } // night = 18:00–06:00

/* =============================================================================
   Segmented controls — render the design's filter chips
   ========================================================================== */
function renderSegments() {
  Object.entries(SEGMENTS).forEach(([key, def]) => {
    const el = document.getElementById(def.id);
    if (!el) return;
    el.innerHTML = '';
    def.options.forEach(([label, value], i) => {
      const active = app.filters[key] === value;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.value = value;
      if (def.chips) {
        // wrapping chip style (used by Day of week, which has 8 options and
        // would otherwise clip off the right edge of the popover)
        btn.style.cssText =
          "font: 500 11px 'IBM Plex Mono', monospace; padding: 5px 9px; cursor: pointer; white-space: nowrap; border-radius: 5px;" +
          'border: 1px solid ' + (active ? ACCENT : 'var(--border)') + ';' +
          'background: ' + (active ? 'rgba(67,176,204,0.12)' : 'var(--bg)') + ';' +
          'color: ' + (active ? ACCENT : 'var(--text-2)') + ';';
      } else {
        btn.style.cssText =
          "font: 500 11px 'IBM Plex Mono', monospace; padding: 6px 11px; cursor: pointer; white-space: nowrap;" +
          "border: none; border-right: " + (i < def.options.length - 1 ? '1px solid var(--border)' : 'none') + ';' +
          'background: ' + (active ? 'rgba(67,176,204,0.10)' : 'transparent') + ';' +
          'color: ' + (active ? ACCENT : 'var(--text-2)') + ';';
      }
      btn.addEventListener('click', () => onSegmentClick(key, value));
      btn.addEventListener('focus', () => { btn.style.outline = '1px solid ' + ACCENT; btn.style.outlineOffset = '-2px'; });
      btn.addEventListener('blur', () => { btn.style.outline = 'none'; });
      el.appendChild(btn);
    });
  });
}

function onSegmentClick(key, value) {
  if (app.filters[key] === value) return;
  app.filters[key] = value;
  renderSegments();
  applyFilters();          // re-run everything live on the new filter
}

/* =============================================================================
   Live filters (Phase 5) — every change re-runs the whole engine on the subset
   ========================================================================== */
function filterRecords() {
  const { sev, time, weather, dow, cause } = app.filters;
  return app.raw.filter((a) => {
    if (sev === 'fs' && a.severity === 'slight') return false;   // Fatal + serious
    if (sev === 'f' && a.severity !== 'fatal') return false;     // Fatal only
    if (time === 'day' && a._night) return false;
    if (time === 'night' && !a._night) return false;
    if (weather !== 'all' && a.weather !== weather) return false;
    if (dow !== 'all' && a._dow !== dow) return false;           // single day of week
    if (cause !== 'all' && a.cause !== cause) return false;      // contributing cause
    return true;
  });
}

/* Cause dropdown (many options → a select rather than chips) */
function renderCauseFilter() {
  const sel = document.getElementById('filterCause');
  if (!sel) return;
  sel.innerHTML = '<option value="all">All causes</option>' +
    CAUSES.map((c) => '<option value="' + c + '">' + c + '</option>').join('');
  sel.value = app.filters.cause;
  sel.addEventListener('change', () => { app.filters.cause = sel.value; applyFilters(); });
}

function updateFilterNote() {
  const el = document.getElementById('filterNote');
  if (!el) return;
  const f = app.filters;
  el.textContent = (f.sev !== 'all' || f.time !== 'all' || f.weather !== 'all' || f.dow !== 'all' || f.cause !== 'all')
    ? 'Counts reflect active filters' : '';
}

/* Active-filter count badge on the Filters button */
function updateFilterCount() {
  const f = app.filters;
  let n = 0;
  if (f.sev !== 'all') n++;
  if (f.time !== 'all') n++;
  if (f.weather !== 'all') n++;
  if (f.dow !== 'all') n++;
  if (f.cause !== 'all') n++;
  const badge = document.getElementById('filterCount');
  if (badge) { badge.textContent = String(n); badge.classList.toggle('on', n > 0); }
}

/* Collapsible filters popover — keeps the map clear until you need the filters */
function setupFilterPanel() {
  const btn = document.getElementById('filtersBtn');
  const panel = document.getElementById('filterPanel');
  if (!btn || !panel) return;
  const open = (o) => { panel.style.display = o ? 'block' : 'none'; btn.setAttribute('aria-expanded', o ? 'true' : 'false'); };
  btn.addEventListener('click', (e) => { if (e) e.stopPropagation(); open(panel.style.display !== 'block'); });
  panel.addEventListener('click', (e) => { if (e) e.stopPropagation(); });
  document.addEventListener('click', () => open(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  const reset = document.getElementById('filterReset');
  if (reset) reset.addEventListener('click', () => {
    app.filters.sev = 'all'; app.filters.time = 'all'; app.filters.weather = 'all';
    app.filters.dow = 'all'; app.filters.cause = 'all';
    renderSegments();
    const cs = document.getElementById('filterCause'); if (cs) cs.value = 'all';
    applyFilters();
  });
  updateFilterCount();
}

/* Draggable panel resizers — adjust the ranked index and details panels
   (the map fills the remaining space). Double-click a handle to collapse. */
function setupResizers() {
  const rail = document.getElementById('rail');
  const dossier = document.getElementById('dossier');
  const RANGE = { rail: [180, 520], dossier: [240, 560] };
  const DEFAULT = { rail: 296, dossier: 336 };
  const KEY = { rail: 'cra-rail-w', dossier: 'cra-dossier-w' };

  try {
    const rw = localStorage.getItem(KEY.rail); if (rw) rail.style.width = rw + 'px';
    const dw = localStorage.getItem(KEY.dossier); if (dw) dossier.style.width = dw + 'px';
  } catch (e) { /* ignore */ }

  const invalidateSoon = () => { if (app.map) requestAnimationFrame(() => app.map.invalidateSize()); };
  const persist = (side, el) => { try { localStorage.setItem(KEY[side], String(Math.round(el.getBoundingClientRect().width))); } catch (e) {} };

  function wire(rzId, side) {
    const rz = document.getElementById(rzId);
    const el = side === 'rail' ? rail : dossier;
    if (!rz || !el) return;
    const lim = RANGE[side];
    let prev = null, dragging = false;

    const clamp = (w) => Math.max(lim[0], Math.min(lim[1], w));
    const widthAt = (clientX) => side === 'rail'
      ? clientX - rail.getBoundingClientRect().left
      : dossier.getBoundingClientRect().right - clientX;

    function move(e) {
      if (!dragging) return;
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      el.style.width = clamp(widthAt(cx)) + 'px';
      invalidateSoon();
    }
    function up() {
      if (!dragging) return;
      dragging = false; rz.classList.remove('dragging'); document.body.classList.remove('col-resizing');
      document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
      document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up);
      persist(side, el); invalidateSoon();
    }
    function down(e) {
      dragging = true; rz.classList.add('dragging'); document.body.classList.add('col-resizing'); e.preventDefault();
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      document.addEventListener('touchmove', move, { passive: false }); document.addEventListener('touchend', up);
    }
    rz.addEventListener('mousedown', down);
    rz.addEventListener('touchstart', down, { passive: false });

    rz.addEventListener('dblclick', () => {
      const cur = el.getBoundingClientRect().width;
      if (cur > 12) { prev = cur; el.style.width = '0px'; }
      else { el.style.width = (prev || DEFAULT[side]) + 'px'; }
      persist(side, el); invalidateSoon();
    });
    rz.addEventListener('keydown', (e) => {
      let d = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
      if (!d) return;
      e.preventDefault();
      const cur = el.getBoundingClientRect().width;
      el.style.width = clamp(side === 'rail' ? cur + d : cur - d) + 'px';
      persist(side, el); invalidateSoon();
    });
  }
  wire('railResizer', 'rail');
  wire('dossierResizer', 'dossier');
}

/* If the details panel was collapsed, bring it back when a zone is selected */
function ensureDossierVisible() {
  const d = document.getElementById('dossier');
  if (!d) return;
  if (d.getBoundingClientRect().width < 40) {
    let w = 336;
    try { const s = localStorage.getItem('cra-dossier-w'); if (s && +s >= 40) w = +s; } catch (e) {}
    d.style.width = w + 'px';
    if (app.map) requestAnimationFrame(() => app.map.invalidateSize());
  }
}

/* =============================================================================
   Theme (dark / light)
   ========================================================================== */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('cra-theme', theme); } catch (e) { /* ignore */ }
  if (app.tileLayer) app.tileLayer.setUrl(TILES[theme]);
  renderThemeToggle();
}
function toggleTheme() { applyTheme(currentTheme() === 'light' ? 'dark' : 'light'); }

function renderThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const light = currentTheme() === 'light';
  btn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
  btn.innerHTML = light
    // sun icon (currently light → offer dark)
    ? '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/><line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/><line x1="3.9" y1="3.9" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="16.1" y2="16.1"/><line x1="16.1" y1="3.9" x2="14.4" y2="5.6"/><line x1="5.6" y1="14.4" x2="3.9" y2="16.1"/></g></svg>'
    // moon icon (currently dark → offer light)
    : '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
}

function applyFilters() {
  app.filtered = filterRecords();
  runHotspotEngine();                       // ranking + blooms recomputed on the subset

  // NOTE: the selection is intentionally preserved across filter changes — the
  // dossier just re-reads the cell under the active filter (see selectedCell()).

  renderPoints();
  renderBlooms();
  syncFocusRing();
  renderRail();
  renderDossier();
  renderHeader();
  updateFilterNote();
  updateFilterCount();
}

/* =============================================================================
   Map
   ========================================================================== */
function initMap() {
  app.map = L.map('map', {
    center: CHENNAI.center,
    zoom: CHENNAI.zoom,
    zoomControl: false,
    attributionControl: false,       // design supplies its own attribution text
    preferCanvas: true,              // fast rendering of ~4k point markers
    minZoom: 9,
    maxZoom: 19,
    zoomSnap: 0.25,                  // finer zoom stops for smoother in/out
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90,         // smoother, more responsive wheel zoom
    wheelDebounceTime: 25,
    zoomAnimation: true,
    maxBoundsViscosity: 1.0,         // hard-lock panning to Chennai
  });
  L.control.zoom({ position: 'bottomright', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(app.map);

  app.tileLayer = L.tileLayer(TILES[currentTheme()], {
    subdomains: 'abcd',
    maxZoom: 20,
    attribution: '© OpenStreetMap contributors © CARTO',
  }).addTo(app.map);
}

/* Frame and lock the view to the actual accident extent — Chennai only,
   never the whole of Tamil Nadu. */
function frameToChennai() {
  app.map.invalidateSize();
  const bounds = L.latLngBounds(app.raw.map((a) => [a.lat, a.lng]));
  app.map.fitBounds(bounds, { padding: [28, 28] });
  app.map.setMaxBounds(bounds.pad(0.10));           // hard leash a touch beyond the data
  app.map.setMinZoom(app.map.getZoom());            // can't zoom out past this city-wide frame
}

/* Click anywhere on the map to inspect the ~250 m cell under the cursor
   Snaps to the nearest cell with
   incidents if the exact cell is empty. */
function enableMapClickSelect() {
  app.map.on('click', (e) => {
    const ci = Math.floor((e.latlng.lat - BBOX.latMin) / CELL);
    const cj = Math.floor((e.latlng.lng - BBOX.lngMin) / CELL);
    let cell = app.cellById[ci + '_' + cj];
    if (!cell) {
      // look in the 3×3 neighbourhood and take the densest cell
      let best = null;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const c = app.cellById[(ci + di) + '_' + (cj + dj)];
          if (c && (!best || c.count > best.count)) best = c;
        }
      }
      cell = best;
    }
    if (cell) selectHotspot(cell.id, { pan: false });   // inspect in place, don't yank the view
  });
}

/* Plot every accident as a small, low-opacity circle coloured by severity */
function renderPoints() {
  if (app.pointLayer) app.pointLayer.remove();
  const canvas = L.canvas({ padding: 0.5 });
  app.pointLayer = L.layerGroup();

  currentRecords().forEach((a) => {
    const sev = SEV[a.severity] || SEV.slight;
    const m = L.circleMarker([a.lat, a.lng], {
      renderer: canvas,
      radius: 3.2,
      stroke: false,
      fillColor: sev.color,
      fillOpacity: 0.5,
      bubblingMouseEvents: false,   // dot click shows only its popup, not the cell select
    });
    m.bindPopup(popupHtml(a), { closeButton: true, autoPan: true });
    app.pointLayer.addLayer(m);
  });

  app.pointLayer.addTo(app.map);
}

function popupHtml(a) {
  const sev = SEV[a.severity] || SEV.slight;
  return (
    '<div class="acc-pop-sev"><span class="acc-pop-dot" style="background:' + sev.color + '"></span>' +
      sev.label + '</div>' +
    '<div class="acc-pop-row">' + a.datetime + '</div>' +
    '<div class="acc-pop-row">Weather · ' + a.weather + '</div>' +
    '<div class="acc-pop-area">' + a.area + '</div>'
  );
}

/* =============================================================================
   Hotspot engine — grid the bbox into ~250 m cells, score by severity,
   rank, and keep the top 10 distinct junctions.
   ========================================================================== */
function computeHotspots(records) {
  // city-wide severity shares — the baseline a cell is judged "dominant" against
  let gF = 0, gS = 0;
  for (const a of records) {
    if (a.severity === 'fatal') gF++;
    else if (a.severity === 'serious') gS++;
  }
  const gN = records.length || 1;
  const gFatalShare = gF / gN;
  const gSeriousShare = gS / gN;

  const cells = new Map();
  for (const a of records) {
    const ci = Math.floor((a.lat - BBOX.latMin) / CELL);
    const cj = Math.floor((a.lng - BBOX.lngMin) / CELL);
    const key = ci + '_' + cj;
    let c = cells.get(key);
    if (!c) {
      c = { key, ci, cj, count: 0, score: 0,
            fatal: 0, serious: 0, slight: 0,
            sumLat: 0, sumLng: 0, areas: {} };
      cells.set(key, c);
    }
    c.count++;
    c.score += (SEV[a.severity] || SEV.slight).weight;   // fatal 3, serious 2, slight 1
    c[a.severity] = (c[a.severity] || 0) + 1;
    c.sumLat += a.lat;
    c.sumLng += a.lng;
    c.areas[a.area] = (c.areas[a.area] || 0) + 1;
  }

  const all = [...cells.values()];
  const highRiskZones = all.filter((c) => c.score >= HIGH_RISK_MIN).length;

  // rank all cells by severity-weighted score
  all.sort((a, b) => b.score - a.score || b.count - a.count);

  // non-max suppression so the top 10 are 10 separate junctions
  const picked = [];
  for (const c of all) {
    if (picked.length >= TOP_N) break;
    const clash = picked.some((p) =>
      Math.abs(p.ci - c.ci) <= SUPPRESS && Math.abs(p.cj - c.cj) <= SUPPRESS);
    if (!clash) picked.push(c);
  }

  const topRaw = picked.length ? picked[0].score : 1;
  const rankByKey = {};
  picked.forEach((c, i) => { rankByKey[c.key] = i + 1; });

  // finalise EVERY cell into a rich, inspectable object (so a map click on any
  // cell can open a dossier), tagging the top 10 with a rank.
  const finalize = (c) => {
    const fShare = c.fatal / c.count;
    const sShare = c.serious / c.count;
    const dom = fShare >= gFatalShare ? 'fatal'
              : sShare >= gSeriousShare ? 'serious' : 'slight';   // most severe class over-represented vs city average
    const area = Object.entries(c.areas).sort((a, b) => b[1] - a[1])[0][0];
    return {
      id: c.key, ci: c.ci, cj: c.cj,
      rank: rankByKey[c.key] || null,
      area,
      lat: c.sumLat / c.count,
      lng: c.sumLng / c.count,
      count: c.count,
      scoreRaw: c.score,
      // normalised 0–100 (top = 100). A gentle curve lifts the lower ranks so
      // the index reads as "all of these are dangerous", not "only #1 matters".
      score: Math.max(1, Math.round(100 * Math.pow(c.score / topRaw, 0.6))),
      fatal: c.fatal, serious: c.serious, slight: c.slight,
      dominant: dom,
    };
  };

  const cellById = {};
  for (const c of all) cellById[c.key] = finalize(c);
  const hotspots = picked.map((c) => cellById[c.key]);

  return { hotspots, highRiskZones, cellById };
}

function runHotspotEngine() {
  const { hotspots, highRiskZones, cellById } = computeHotspots(currentRecords());
  app.hotspots = hotspots;
  app.highRiskZones = highRiskZones;
  app.cellById = cellById;
  app.hotspotById = cellById;   // selection resolves against ALL cells, not just the top 10
}

/* =============================================================================
   Emerging-hotspot engine (Phase 2) — predictive "watch list"
   For every ~250 m cell, compare its incident rate in the RECENT window
   (last 6 months) against its own BASELINE (the prior 18 months). A cell whose
   recent monthly rate has jumped >= 1.5x — and has real recent volume — is
   flagged as emerging. Ranked by a severity-weighted "surge priority", then
   non-max-suppressed so the list is distinct junctions, not split clusters.

   Runs on the FULL dataset (not the interactive filter) — it is a strategic,
   time-based read of where risk is trending up, independent of the map filters.
   ========================================================================== */
function computeEmerging(records) {
  const recentCut = app.lastMonth - RECENT_MONTHS;   // months strictly after this are "recent"
  const baseMonths = Math.max(1, app.monthCount - RECENT_MONTHS);
  const cells = new Map();

  for (const a of records) {
    const ci = Math.floor((a.lat - BBOX.latMin) / CELL);
    const cj = Math.floor((a.lng - BBOX.lngMin) / CELL);
    const key = ci + '_' + cj;
    let c = cells.get(key);
    if (!c) {
      c = { key, ci, cj, recent: 0, baseline: 0, recentScore: 0,
            rF: 0, rS: 0, rL: 0, sumLat: 0, sumLng: 0, areas: {},
            months: new Array(app.monthCount).fill(0) };
      cells.set(key, c);
    }
    const w = (SEV[a.severity] || SEV.slight).weight;
    if (a._month > recentCut) {
      c.recent++;
      c.recentScore += w;
      if (a.severity === 'fatal') c.rF++; else if (a.severity === 'serious') c.rS++; else c.rL++;
    } else {
      c.baseline++;
    }
    if (a._month >= 0 && a._month < app.monthCount) c.months[a._month]++;
    c.sumLat += a.lat; c.sumLng += a.lng;
    c.areas[a.area] = (c.areas[a.area] || 0) + 1;
  }

  const candidates = [];
  for (const c of cells.values()) {
    if (c.recent < EMERGE_MIN_RECENT) continue;
    const recentRate = c.recent / RECENT_MONTHS;
    const baseRate = c.baseline / baseMonths;
    // a cell rising from (near-)zero is genuinely emerging; cap its lift so it
    // doesn't dominate purely on a tiny denominator
    const lift = baseRate > 0 ? recentRate / baseRate : 3;
    if (lift < EMERGE_LIFT) continue;
    c.lift = lift;
    c.priority = c.recentScore * (lift - 1);   // heavy AND steeply rising ranks highest
    candidates.push(c);
  }
  candidates.sort((a, b) => b.priority - a.priority);

  // non-max suppression → distinct junctions (same radius as the main index)
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= EMERGE_TOP_N) break;
    const clash = picked.some((p) =>
      Math.abs(p.ci - c.ci) <= SUPPRESS && Math.abs(p.cj - c.cj) <= SUPPRESS);
    if (!clash) picked.push(c);
  }

  return picked.map((c) => {
    const n = c.recent + c.baseline;
    return {
      id: c.key, ci: c.ci, cj: c.cj,
      area: Object.entries(c.areas).sort((a, b) => b[1] - a[1])[0][0],
      lat: c.sumLat / n, lng: c.sumLng / n,
      recent: c.recent, baseline: c.baseline,
      lift: c.lift,
      pctIncrease: Math.round((c.lift - 1) * 100),
      months: c.months,
      rF: c.rF, rS: c.rS, rL: c.rL,
    };
  });
}

function runEmergingEngine() {
  app.emerging = computeEmerging(app.raw);      // strategic view — always over full data
  app.emergingIds = new Set(app.emerging.map((e) => e.id));
}

/* =============================================================================
   Ranked danger index (left rail)
   ========================================================================== */
function renderRail() {
  const list = document.getElementById('railList');
  if (!list) return;
  list.innerHTML = '';

  if (!app.hotspots.length) {
    list.innerHTML = '<div style="padding:18px 16px; font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-3);">No incidents match the current filters.</div>';
    return;
  }

  app.hotspots.forEach((h) => {
    const isSel = app.selected === h.id;
    const rising = app.emergingIds && app.emergingIds.has(h.id);
    const inc = h.count;
    const fw = (h.fatal / inc) * 100;
    const sw = (h.serious / inc) * 100;
    const lw = (h.slight / inc) * 100;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.id = h.id;
    btn.style.cssText =
      "display:grid; grid-template-columns:24px 1fr auto; column-gap:10px; row-gap:7px; align-items:start;" +
      "width:100%; text-align:left; border:none; border-bottom:1px solid var(--border-soft); padding:11px 14px 12px;" +
      "cursor:pointer; color:var(--text); font-family:'IBM Plex Sans',sans-serif;" +
      'background:' + (isSel ? 'rgba(67,176,204,0.07)' : 'transparent') + ';' +
      'box-shadow:' + (isSel ? 'inset 2px 0 0 ' + ACCENT : 'none') + ';';

    const rankColor = h.rank <= 3 ? 'var(--text)' : 'var(--text-2)';
    btn.innerHTML =
      '<span style="font:500 13px \'IBM Plex Mono\',monospace; color:' + rankColor + '; padding-top:1px; font-variant-numeric:tabular-nums;">' + String(h.rank).padStart(2, '0') + '</span>' +
      '<span style="min-width:0;">' +
        '<span style="display:block; font:500 13px \'IBM Plex Sans\',sans-serif; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + (rising ? '<span style="color:' + ACCENT + '; font-size:10px;" title="Emerging — recent incident rate rising">▲ </span>' : '') + h.area + '</span>' +
        '<span style="display:block; font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; letter-spacing:0.02em;">' + h.lat.toFixed(4) + '°N · ' + h.lng.toFixed(4) + '°E</span>' +
      '</span>' +
      '<span style="text-align:right;">' +
        '<span style="display:block; font:500 12.5px \'IBM Plex Mono\',monospace; font-variant-numeric:tabular-nums;">' + fmt(inc) + '</span>' +
        '<span style="display:block; font:400 10px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:2px; font-variant-numeric:tabular-nums;">risk ' + h.score + '</span>' +
      '</span>' +
      '<span style="grid-column:2 / 4; display:flex; height:3px; border-radius:1.5px; overflow:hidden; background:var(--track);">' +
        '<span style="width:' + fw.toFixed(1) + '%; background:#E4404E;"></span>' +
        '<span style="width:' + sw.toFixed(1) + '%; background:#F2933E;"></span>' +
        '<span style="width:' + lw.toFixed(1) + '%; background:#E7C64B;"></span>' +
      '</span>';

    btn.addEventListener('mouseenter', () => { if (app.selected !== h.id) btn.style.background = 'var(--row-hover)'; });
    btn.addEventListener('mouseleave', () => { if (app.selected !== h.id) btn.style.background = 'transparent'; });
    btn.addEventListener('focus', () => { btn.style.outline = '1px solid ' + ACCENT; btn.style.outlineOffset = '-2px'; });
    btn.addEventListener('blur', () => { btn.style.outline = 'none'; });
    btn.addEventListener('click', () => selectHotspot(h.id, { pan: true }));
    list.appendChild(btn);
  });
}

/* =============================================================================
   Risk blooms (signature map markers for the top 10)
   ========================================================================== */
function bloomIcon(h, selected) {
  const color = SEV[h.dominant].color;
  const d = 26 + Math.sqrt(h.score) * 5.4;           // glow diameter, scaled by risk score
  const ringD = d * 0.62 + 20;
  const delay = (0.05 * h.rank).toFixed(2);
  return L.divIcon({
    className: 'bloom-icon',
    iconSize: [d, d],
    iconAnchor: [d / 2, d / 2],
    html:
      '<div class="bloom' + (selected ? ' is-selected' : '') + '" style="width:' + d + 'px; height:' + d + 'px; animation-delay:' + delay + 's;">' +
        '<span class="bloom-glow" style="background:radial-gradient(circle, ' + color + 'D9 0%, ' + color + '55 38%, ' + color + '00 70%);"></span>' +
        '<span class="bloom-core" style="background:' + color + '; box-shadow:0 0 8px ' + color + 'AA;"></span>' +
        '<span class="bloom-ring" style="width:' + ringD + 'px; height:' + ringD + 'px;"></span>' +
      '</div>',
  });
}

function renderBlooms() {
  if (app.bloomLayer) app.bloomLayer.remove();
  app.bloomLayer = L.layerGroup();
  app.bloomMarkers = {};

  app.hotspots.forEach((h) => {
    const m = L.marker([h.lat, h.lng], {
      icon: bloomIcon(h, app.selected === h.id),
      keyboard: true,
      title: h.area + ' · rank ' + h.rank + ' · ' + fmt(h.count) + ' incidents',
      riseOnHover: true,
      zIndexOffset: 400 - h.rank,        // higher-ranked blooms sit on top
    });
    m.on('click', () => selectHotspot(h.id, { pan: true }));
    app.bloomMarkers[h.id] = m;
    app.bloomLayer.addLayer(m);
  });

  app.bloomLayer.addTo(app.map);

  // make each bloom keyboard-focusable (Tab to it, Enter/Space to select)
  app.hotspots.forEach((h) => {
    const m = app.bloomMarkers[h.id];
    const el = m && m.getElement();
    if (!el) return;
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', h.area + ', rank ' + h.rank + ', ' + fmt(h.count) + ' incidents');
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectHotspot(h.id, { pan: true }); }
    });
  });
}

/* Refresh only the bloom icons' selected state by toggling a class on the
   existing element — never recreate the icon, or the entry animation restarts
   and every bloom pops/shakes. */
function refreshBloomSelection() {
  app.hotspots.forEach((h) => {
    const m = app.bloomMarkers[h.id];
    if (!m) return;
    const el = m.getElement();
    if (!el) { m.setIcon(bloomIcon(h, app.selected === h.id)); return; }
    const bloom = el.querySelector('.bloom');
    if (bloom) bloom.classList.toggle('is-selected', app.selected === h.id);
  });
}

/* =============================================================================
   Emerging-hotspot markers — a slow accent pulse on each surging junction.
   Distinct from the severity blooms so "rising fast" reads separately from
   "worst overall"; a junction can carry both.
   ========================================================================== */
function renderEmergeMarkers() {
  if (app.emergeLayer) app.emergeLayer.remove();
  app.emergeLayer = L.layerGroup();
  app.emerging.forEach((e, i) => {
    const d0 = (0.3 * i).toFixed(2);                     // stagger each junction's pulse
    const d1 = (0.3 * i + 1.2).toFixed(2);               // second ring, offset for a double pulse
    const icon = L.divIcon({
      className: 'em-icon',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      html:
        '<div class="em-mark">' +
          '<span class="em-pulse" style="animation-delay:' + d0 + 's;"></span>' +
          '<span class="em-pulse" style="animation-delay:' + d1 + 's;"></span>' +
          '<span class="em-core"></span>' +
        '</div>',
    });
    const m = L.marker([e.lat, e.lng], {
      icon,
      zIndexOffset: 250,               // above points, below the top-10 blooms
      title: e.area + ' · emerging · +' + e.pctIncrease + '% recent rate',
      riseOnHover: true,
    });
    m.on('click', () => selectHotspot(e.id, { pan: true }));
    app.emergeLayer.addLayer(m);
  });
  app.emergeLayer.addTo(app.map);
}

/* =============================================================================
   Selection — keep list ↔ map in sync
   ========================================================================== */
/* Draw / move / remove the accent focus ring to match the current selection */
function syncFocusRing() {
  const h = selectedCell();
  if (!h) {
    if (app.focusRing) { app.focusRing.remove(); app.focusRing = null; }
    return;
  }
  if (app.focusRing) {
    app.focusRing.setLatLng([h.lat, h.lng]);
  } else {
    app.focusRing = L.circle([h.lat, h.lng], {
      radius: 165, color: ACCENT, weight: 1.5, opacity: 0.95,
      fill: false, className: 'focus-ring', interactive: false,
    }).addTo(app.map);
  }
}

function selectHotspot(id, opts) {
  opts = opts || {};
  app.selected = id;
  app.dossierTab = 'zone';    // selecting a place always shows its zone dossier
  const h = app.cellById[id];
  // remember stable info so the selection survives filter changes even if the
  // cell temporarily has no incidents under the active filter
  if (h) app.selInfo = { id: h.id, ci: h.ci, cj: h.cj, lat: h.lat, lng: h.lng, area: h.area };

  ensureDossierVisible();     // un-collapse the details panel if it was hidden
  renderRail();               // re-highlight the ranked list
  refreshBloomSelection();    // ring the chosen bloom (if it's a top-10)
  syncFocusRing();            // accent ring on the map

  if (h && opts.pan) {
    app.map.flyTo([h.lat, h.lng], Math.max(app.map.getZoom(), SELECT_ZOOM), { duration: 0.6 });
  }
  renderDossier();
}

/* Resolve the selected cell to a display object, falling back to the stored
   info (with zero counts) when the current filter empties the cell. */
function selectedCell() {
  if (!app.selected) return null;
  // prefer the filtered cell; fall back to the full-data cell so the details
  // panel always has real numbers, never "not available"
  return app.cellById[app.selected] || app.cellByIdFull[app.selected] || null;
}

function clearSelection() {
  if (app.selected === null) return;
  app.selected = null;
  app.selInfo = null;
  syncFocusRing();
  renderRail();
  refreshBloomSelection();
  renderDossier();
}

/* =============================================================================
   Dossier insight panel (right)
   ========================================================================== */
function currentRecords() { return app.filtered || app.raw; }   // Phase 5 sets app.filtered

function accidentsForHotspot(h, records) {
  const [ci, cj] = h.id.split('_').map(Number);
  return (records || currentRecords()).filter((a) =>
    Math.floor((a.lat - BBOX.latMin) / CELL) === ci &&
    Math.floor((a.lng - BBOX.lngMin) / CELL) === cj);
}

const pad2 = (n) => String(n).padStart(2, '0');
const WEATHER_LABEL = { clear: 'Clear', rain: 'Rain', fog: 'Fog' };

/* Uppercase mono section label used across the dossier */
function dsLabel(text) {
  return '<div style="padding:14px 18px 8px; font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">' + text + '</div>';
}

/* Ranked horizontal-bar breakdown of a categorical field (count + %), desc */
function rankedBars(recs, field, topN, color) {
  const counts = {};
  recs.forEach((r) => { const k = r[field]; if (k) counts[k] = (counts[k] || 0) + 1; });
  const total = recs.length || 1;
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
  if (!sorted.length) return '<div style="padding:4px 18px 8px; font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-3);">No data</div>';
  const max = sorted[0][1];
  return sorted.map(([label, n]) =>
    '<div style="padding:5px 18px;">' +
      '<div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;">' +
        '<span style="font:400 11.5px \'IBM Plex Sans\',sans-serif; color:var(--text); min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + label + '</span>' +
        '<span style="flex:none; font:500 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); font-variant-numeric:tabular-nums;">' + fmt(n) + ' · ' + Math.round((n / total) * 100) + '%</span>' +
      '</div>' +
      '<div style="margin-top:4px; height:4px; background:var(--track); border-radius:2px; overflow:hidden;">' +
        '<div style="height:4px; width:' + ((n / max) * 100).toFixed(1) + '%; background:' + color + '; opacity:0.92; border-radius:2px;"></div>' +
      '</div>' +
    '</div>'
  ).join('');
}

/* =============================================================================
   Intervention engine — city-wide leverage + priority queue (Phase 3)
   ========================================================================== */
/* How concentrated the city's SEVERE (fatal + serious) harm is in the top-10
   junction cells — the leverage argument for targeting them first. */
function cityLeverage() {
  const top = app.hotspotsFull.length ? app.hotspotsFull : app.hotspots;
  let sevCity = 0;
  for (const a of app.raw) if (a.severity === 'fatal' || a.severity === 'serious') sevCity++;
  let sevTop = 0;
  top.forEach((h) => { const c = app.cellByIdFull[h.id]; if (c) sevTop += c.fatal + c.serious; });
  return { sevCity, sevTop, n: top.length, pct: sevCity ? Math.round((sevTop / sevCity) * 100) : 0 };
}

/* Rank the top junctions by ESTIMATED preventable severe crashes — the order a
   limited safety budget should work down. Computed over ALL data (strategic). */
function priorityQueue() {
  const M = window.CRASH_INTERVENTIONS;
  const top = app.hotspotsFull.length ? app.hotspotsFull : app.hotspots;
  const rows = top.map((h) => {
    const acc = accidentsForHotspot(h, app.raw);
    let fatal = 0, serious = 0, night = 0;
    const cc = {};
    acc.forEach((a) => {
      if (a.severity === 'fatal') fatal++; else if (a.severity === 'serious') serious++;
      if (a._night) night++;
      cc[a.cause] = (cc[a.cause] || 0) + 1;
    });
    const n = acc.length || 1;
    const domCause = Object.entries(cc).sort((a, b) => b[1] - a[1])[0][0] || '—';
    const iv = M ? M.pick(domCause, night / n) : { fix: '—', cost: 'High', eff: 0.2 };
    const prevent = M ? M.preventable(fatal, serious, iv.eff) : 0;
    return { id: h.id, area: h.area, fatal, serious, domCause, iv, prevent };
  });
  rows.sort((a, b) => b.prevent - a.prevent || (b.fatal * 3 + b.serious) - (a.fatal * 3 + a.serious));
  return rows;
}

/* City-wide "Contributing factors" tab — leverage + intervention priority queue
   (Phase 3, over all data) then full cause + vehicle distributions (filtered) */
function renderCity() {
  const c = document.getElementById('dossierCity');
  if (!c) return;
  const recs = currentRecords();
  const anyFilter = app.filters.sev !== 'all' || app.filters.time !== 'all' || app.filters.weather !== 'all' ||
    app.filters.dow !== 'all' || app.filters.cause !== 'all';

  const lev = cityLeverage();
  const queue = priorityQueue();

  const queueRows = queue.map((r, i) =>
    '<button data-pq="' + r.id + '" type="button" style="display:block; width:100%; text-align:left; border:none; border-bottom:1px solid var(--border-soft); background:transparent; cursor:pointer; padding:11px 18px 13px; color:var(--text); font-family:\'IBM Plex Sans\',sans-serif;">' +
      '<div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">' +
        '<span style="font:500 13px \'Space Grotesk\',sans-serif; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"><span style="color:var(--text-2); font:500 11px \'IBM Plex Mono\',monospace;">' + pad2(i + 1) + '</span> ' + r.area + '</span>' +
        '<span style="flex:none; font:600 13px \'Space Grotesk\',sans-serif; color:var(--accent); font-variant-numeric:tabular-nums;">≈ ' + fmt(r.prevent) + '</span>' +
      '</div>' +
      '<div style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + r.domCause + ' → ' + r.iv.fix + '</div>' +
      '<div style="display:flex; align-items:center; gap:7px; margin-top:7px;">' +
        '<span style="font:500 8.5px \'IBM Plex Mono\',monospace; letter-spacing:0.08em; color:var(--text-3); text-transform:uppercase;">Cost</span>' + costMeter(r.iv.cost) +
        '<span style="font:400 9.5px \'IBM Plex Mono\',monospace; color:var(--text-2);">' + r.iv.cost + '</span>' +
        '<span style="margin-left:auto; font:400 9.5px \'IBM Plex Mono\',monospace; color:var(--text-3); font-variant-numeric:tabular-nums;">' + fmt(r.fatal) + ' fatal · ' + fmt(r.serious) + ' serious</span>' +
      '</div>' +
    '</button>'
  ).join('');

  c.innerHTML =
    '<div style="flex:none; padding:15px 18px 13px; border-bottom:1px solid var(--border);">' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">City strategy</div>' +
      '<div style="display:flex; align-items:baseline; gap:9px; margin-top:5px;">' +
        '<span style="font:600 30px \'Space Grotesk\',sans-serif; line-height:1; font-variant-numeric:tabular-nums;">' + fmt(recs.length) + '</span>' +
        '<span style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2);">incidents' + (anyFilter ? ' · filtered' : ' · all data') + '</span>' +
      '</div>' +
    '</div>' +
    '<div style="flex:1; overflow-y:auto; min-height:0; padding-bottom:18px;">' +
      // ---- leverage headline ----
      '<div style="padding:15px 18px 2px;">' +
        '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--accent); text-transform:uppercase;">The leverage</div>' +
        '<div style="margin-top:10px; padding:14px 15px; background:rgba(67,176,204,0.07); border:1px solid rgba(67,176,204,0.22); border-radius:8px;">' +
          '<div style="display:flex; align-items:baseline; gap:11px;">' +
            '<span style="font:600 40px \'Space Grotesk\',sans-serif; color:var(--accent); line-height:0.85; font-variant-numeric:tabular-nums;">' + lev.pct + '%</span>' +
            '<span style="font:400 12px \'IBM Plex Sans\',sans-serif; color:var(--text); line-height:1.5;">of the city’s severe crashes occur in just <b>' + lev.n + '</b> junction cells</span>' +
          '</div>' +
          '<div style="font:400 10px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:9px; letter-spacing:0.02em;">' + fmt(lev.sevTop) + ' of ' + fmt(lev.sevCity) + ' fatal + serious incidents · 250 m cells · all data</div>' +
        '</div>' +
      '</div>' +
      // ---- intervention priority queue ----
      '<div style="padding:16px 18px 6px;">' +
        '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Intervention priority</div>' +
        '<div style="font:400 10.5px \'IBM Plex Sans\',sans-serif; color:var(--text-3); margin-top:4px; line-height:1.5;">Ranked by estimated severe crashes preventable if the fix targets each zone’s dominant cause. <span style="color:var(--text-3);">Planning estimate.</span></div>' +
      '</div>' +
      queueRows +
      // ---- distributions (respond to filters) ----
      '<div style="margin-top:16px; border-top:1px solid var(--track);"></div>' +
      dsLabel('Cause distribution' + (anyFilter ? ' · filtered' : '')) + rankedBars(recs, 'cause', CAUSES.length, 'var(--accent)') +
      '<div style="margin-top:12px; border-top:1px solid var(--track);"></div>' +
      dsLabel('Vehicles involved' + (anyFilter ? ' · filtered' : '')) + rankedBars(recs, 'vehicle', VEHICLES.length, 'var(--chart-day)') +
    '</div>';

  c.querySelectorAll('[data-pq]').forEach((el) => {
    el.addEventListener('click', () => selectHotspot(el.dataset.pq, { pan: true }));
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--row-hover)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    el.addEventListener('focus', () => { el.style.outline = '1px solid ' + ACCENT; el.style.outlineOffset = '-2px'; });
    el.addEventListener('blur', () => { el.style.outline = 'none'; });
  });
}

/* Tiny 24-month trend sparkline; the recent window is drawn in the accent
   colour so the upswing reads at a glance. */
function emergeSparkline(months) {
  const max = Math.max(1, ...months);
  const cut = months.length - RECENT_MONTHS;
  return '<div style="display:flex; align-items:flex-end; gap:1.5px; height:32px; margin-top:10px;">' +
    months.map((v, i) =>
      '<span title="' + v + ' incidents" style="flex:1; min-width:2px; height:' + Math.max(7, (v / max) * 100).toFixed(1) + '%; border-radius:1px 1px 0 0; background:' + (i >= cut ? 'var(--accent)' : 'var(--hist)') + ';"></span>'
    ).join('') +
  '</div>' +
  '<div style="display:flex; justify-content:space-between; margin-top:4px; font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);"><span>' + monthCount24Label() + '</span><span style="color:var(--accent);">last 6 mo</span></div>';
}
function monthCount24Label() { return app.monthCount + ' mo'; }

/* City-wide "Emerging hotspots" tab — the predictive watch list */
function renderEmerging() {
  const c = document.getElementById('dossierEmerging');
  if (!c) return;
  const list = app.emerging;

  const header =
    '<div style="flex:none; padding:15px 18px 13px; border-bottom:1px solid var(--border);">' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Emerging hotspots</div>' +
      '<div style="display:flex; align-items:baseline; gap:9px; margin-top:5px;">' +
        '<span style="font:600 30px \'Space Grotesk\',sans-serif; line-height:1; font-variant-numeric:tabular-nums;">' + list.length + '</span>' +
        '<span style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2);">zones trending up</span>' +
      '</div>' +
      '<div style="font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-2); margin-top:7px; line-height:1.5;">Rising fastest by monthly incident rate — last 6 months vs the prior 18. Watch these before they reach the top index.</div>' +
    '</div>';

  let body;
  if (!list.length) {
    body = '<div style="padding:26px 18px; font:400 12px \'IBM Plex Sans\',sans-serif; color:var(--text-3); line-height:1.65;">No zone shows a significant recent surge. Every junction is stable or improving against its 18-month baseline.</div>';
  } else {
    body = list.map((e, i) => {
      const rn = (e.rF + e.rS + e.rL) || 1;
      return (
        '<button data-emerge="' + e.id + '" type="button" style="display:block; width:100%; text-align:left; border:none; border-bottom:1px solid var(--border-soft); background:transparent; cursor:pointer; padding:14px 18px 16px; color:var(--text); font-family:\'IBM Plex Sans\',sans-serif;">' +
          '<div style="display:flex; align-items:baseline; justify-content:space-between; gap:10px;">' +
            '<span style="font:500 14.5px \'Space Grotesk\',sans-serif; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' +
              '<span style="color:var(--text-2); font:500 12px \'IBM Plex Mono\',monospace;">' + pad2(i + 1) + '</span> ' + e.area +
            '</span>' +
            '<span style="flex:none; font:600 12.5px \'IBM Plex Mono\',monospace; color:var(--accent); font-variant-numeric:tabular-nums;">▲ ' + e.pctIncrease + '%</span>' +
          '</div>' +
          '<div style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:4px; letter-spacing:0.02em; font-variant-numeric:tabular-nums;">' +
            e.recent + ' recent · ' + e.baseline + ' prior · ' + e.lift.toFixed(1) + '× monthly rate</div>' +
          emergeSparkline(e.months) +
          '<div style="display:flex; height:3px; border-radius:1.5px; overflow:hidden; background:var(--track); margin-top:10px;">' +
            '<span style="width:' + ((e.rF / rn) * 100).toFixed(1) + '%; background:#E4404E;"></span>' +
            '<span style="width:' + ((e.rS / rn) * 100).toFixed(1) + '%; background:#F2933E;"></span>' +
            '<span style="width:' + ((e.rL / rn) * 100).toFixed(1) + '%; background:#E7C64B;"></span>' +
          '</div>' +
        '</button>'
      );
    }).join('');
  }

  c.innerHTML = header + '<div style="flex:1; overflow-y:auto; min-height:0; padding-bottom:18px;">' + body + '</div>';

  c.querySelectorAll('[data-emerge]').forEach((el) => {
    el.addEventListener('click', () => selectHotspot(el.dataset.emerge, { pan: true }));
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--row-hover)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    el.addEventListener('focus', () => { el.style.outline = '1px solid ' + ACCENT; el.style.outlineOffset = '-2px'; });
    el.addEventListener('blur', () => { el.style.outline = 'none'; });
  });
}

/* Dossier tab switch (Zone ↔ City ↔ Emerging) */
function setDossierTab(tab) {
  app.dossierTab = tab;
  renderDossier();
}
function setupDossierTabs() {
  document.querySelectorAll('.dtab').forEach((b) => {
    b.addEventListener('click', () => setDossierTab(b.dataset.tab));
  });
}

/* Dossier identity header (rank/area/coords + close button) — shared by the
   full dossier and the empty-under-filter state. */
function dossierHeaderHtml(h) {
  return '<div style="flex:none; padding:15px 18px 14px; border-bottom:1px solid var(--border);">' +
    '<div style="display:flex; align-items:flex-start; justify-content:space-between; gap:10px;">' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase; padding-top:6px;">' + (h.rank ? 'Hotspot ' + pad2(h.rank) : 'Area inspection') + '</div>' +
      '<button data-close type="button" aria-label="Close dossier" style="width:26px; height:26px; flex:none; display:flex; align-items:center; justify-content:center; background:transparent; border:1px solid var(--border); border-radius:4px; cursor:pointer; color:var(--text-2); padding:0;">' +
        '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><line x1="1" y1="1" x2="9" y2="9" style="stroke:currentColor; stroke-width:1.3;"></line><line x1="9" y1="1" x2="1" y2="9" style="stroke:currentColor; stroke-width:1.3;"></line></svg>' +
      '</button>' +
    '</div>' +
    '<div style="font:500 19px \'Space Grotesk\',sans-serif; line-height:1.2; margin-top:4px;">' + h.area + '</div>' +
    '<div style="font:400 11.5px \'IBM Plex Sans\',sans-serif; color:var(--text-2); margin-top:3px;">' + SEV[h.dominant].label + '-dominant risk cell · 250 m</div>' +
    '<div style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:7px; letter-spacing:0.04em;">' + h.lat.toFixed(4) + '° N · ' + h.lng.toFixed(4) + '° E</div>' +
    '<a href="./compare.html?a=' + encodeURIComponent(h.area) + '" title="Compare ' + h.area + ' with another area" style="display:inline-flex; align-items:center; gap:6px; margin-top:10px; font:500 10.5px \'IBM Plex Mono\',monospace; letter-spacing:0.04em; color:var(--accent); text-decoration:none;">' +
      '<svg width="12" height="12" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 6h9l-2.5-2.5M14 12H5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      'Compare this area</a>' +
  '</div>';
}

/* Recommended intervention derived from a zone's DOMINANT cause (+ night
   pattern) via the shared model — returns { fix, cost, eff } so each area gets a
   fix, a capital-cost tier, and an estimated impact matching why its crashes
   happen. Falls back gracefully if the model script did not load. */
function interventionFor(cause, nightShare) {
  var M = window.CRASH_INTERVENTIONS;
  return M ? M.pick(cause, nightShare) : { fix: 'Junction redesign and signage review', cost: 'High', eff: 0.20 };
}

/* Small three-dot meter for a capital-cost tier (Low ● / Medium ●● / High ●●●). */
function costMeter(tier) {
  var lvl = tier === 'Low' ? 1 : tier === 'Medium' ? 2 : 3;
  var dots = '';
  for (var i = 1; i <= 3; i++) {
    dots += '<span style="width:6px; height:6px; border-radius:50%; display:inline-block; margin-left:2px; background:' + (i <= lvl ? 'var(--accent)' : 'var(--track)') + ';"></span>';
  }
  return dots;
}

/* Day-of-week chips shown inside the zone dossier — a quicker, more intuitive
   way to slice the selected zone by day (wired to the same live day filter). */
function zoneDayChipsHtml() {
  const chips = [['All', 'all'], ['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]];
  return '<div style="padding:13px 18px 4px;">' +
    '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase; margin-bottom:8px;">Filter by day of week</div>' +
    '<div style="display:flex; flex-wrap:wrap; gap:5px;">' +
    chips.map(([label, value]) => {
      const active = app.filters.dow === value;
      return '<button type="button" class="zdaychip" data-dow="' + value + '" style="' +
        "font:500 11px 'IBM Plex Mono',monospace; padding:5px 9px; cursor:pointer; border-radius:5px; white-space:nowrap;" +
        'border:1px solid ' + (active ? ACCENT : 'var(--border)') + '; background:' + (active ? 'rgba(67,176,204,0.12)' : 'var(--bg)') +
        '; color:' + (active ? ACCENT : 'var(--text-2)') + ';">' + label + '</button>';
    }).join('') +
    '</div></div>';
}
function wireZoneDayChips(full) {
  full.querySelectorAll('.zdaychip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.dow;
      onSegmentClick('dow', d === 'all' ? 'all' : +d);
    });
  });
}

function wireDossierClose(full) {
  const closeBtn = full.querySelector('[data-close]');
  if (!closeBtn) return;
  closeBtn.addEventListener('click', clearSelection);
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'var(--row-alt)'; closeBtn.style.color = 'var(--text)'; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'transparent'; closeBtn.style.color = 'var(--text-2)'; });
  closeBtn.addEventListener('focus', () => { closeBtn.style.outline = '1px solid ' + ACCENT; closeBtn.style.outlineOffset = '1px'; });
  closeBtn.addEventListener('blur', () => { closeBtn.style.outline = 'none'; });
}

function renderDossier() {
  const empty = document.getElementById('dossierEmpty');
  const full = document.getElementById('dossierFull');
  const aside = document.getElementById('dossier');
  const zone = document.getElementById('dossierZone');
  const cityEl = document.getElementById('dossierCity');
  const emergeEl = document.getElementById('dossierEmerging');

  // tab visuals
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === app.dossierTab));

  if (app.dossierTab === 'city') {
    if (zone) zone.style.display = 'none';
    if (emergeEl) emergeEl.style.display = 'none';
    if (cityEl) cityEl.style.display = 'flex';
    renderCity();
    aside.setAttribute('data-open', 'true');
    return;
  }
  if (app.dossierTab === 'emerging') {
    if (zone) zone.style.display = 'none';
    if (cityEl) cityEl.style.display = 'none';
    if (emergeEl) emergeEl.style.display = 'flex';
    renderEmerging();
    aside.setAttribute('data-open', 'true');
    return;
  }
  if (cityEl) cityEl.style.display = 'none';
  if (emergeEl) emergeEl.style.display = 'none';
  if (zone) zone.style.display = 'flex';

  const h = selectedCell();

  if (!h) {
    empty.style.display = 'flex';
    full.style.display = 'none';
    full.innerHTML = '';
    aside.setAttribute('data-open', 'false');
    return;
  }

  // details always show real data: use the filtered incidents for this cell,
  // and if the active filter empties it, fall back to the cell's full record
  // set so the panel never reads "not available".
  let acc = accidentsForHotspot(h);
  if (acc.length === 0) acc = accidentsForHotspot(h, app.raw);
  const n = acc.length || 1;

  let fatal = 0, serious = 0, slight = 0, night = 0, rain = 0, fog = 0, clear = 0;
  const hours = new Array(24).fill(0);
  const dow = new Array(7).fill(0);
  for (const a of acc) {
    if (a.severity === 'fatal') fatal++; else if (a.severity === 'serious') serious++; else slight++;
    hours[a._hour]++;
    if (a._night) night++;
    if (a.weather === 'rain') rain++; else if (a.weather === 'fog') fog++; else clear++;
    dow[a._dow]++;                                         // 0=Mon..6=Sun (precomputed)
  }
  const day = n - night;
  const pc = (x) => Math.round((x / n) * 100);

  const maxH = Math.max(1, ...hours);
  const peak = hours.indexOf(Math.max(...hours));
  const maxD = Math.max(1, ...dow);

  // intervention derived from the zone's dominant cause (+ night pattern)
  const causeCounts = {};
  acc.forEach((a) => { causeCounts[a.cause] = (causeCounts[a.cause] || 0) + 1; });
  const domCause = Object.entries(causeCounts).sort((a, b) => b[1] - a[1])[0][0];
  const domPct = Math.round((causeCounts[domCause] / n) * 100);
  const intervention = interventionFor(domCause, night / n);
  const preventable = window.CRASH_INTERVENTIONS
    ? window.CRASH_INTERVENTIONS.preventable(fatal, serious, intervention.eff) : 0;

  const sevRow = (label, color, val) =>
    '<div style="display:grid; grid-template-columns:62px 1fr 40px 36px; align-items:center; gap:8px; padding:5px 18px;">' +
      '<span style="display:flex; align-items:center; gap:6px;"><span style="width:7px; height:7px; border-radius:50%; background:' + color + '; flex:none;"></span><span style="font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-2);">' + label + '</span></span>' +
      '<span style="display:block; height:4px; background:var(--track); border-radius:2px; overflow:hidden;"><span style="display:block; height:4px; width:' + ((val / n) * 100).toFixed(1) + '%; background:' + color + '; opacity:0.9;"></span></span>' +
      '<span style="font:500 11.5px \'IBM Plex Mono\',monospace; text-align:right; font-variant-numeric:tabular-nums;">' + fmt(val) + '</span>' +
      '<span style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); text-align:right; font-variant-numeric:tabular-nums;">' + pc(val) + '%</span>' +
    '</div>';

  const weatherRow = (key, val) =>
    '<div style="display:grid; grid-template-columns:62px 1fr 40px 36px; align-items:center; gap:8px; padding:5px 18px;">' +
      '<span style="font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-2);">' + WEATHER_LABEL[key] + '</span>' +
      '<span style="display:block; height:4px; background:var(--track); border-radius:2px; overflow:hidden;"><span style="display:block; height:4px; width:' + ((val / n) * 100).toFixed(1) + '%; background:var(--chart-day);"></span></span>' +
      '<span style="font:500 11.5px \'IBM Plex Mono\',monospace; text-align:right; font-variant-numeric:tabular-nums;">' + fmt(val) + '</span>' +
      '<span style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2); text-align:right; font-variant-numeric:tabular-nums;">' + pc(val) + '%</span>' +
    '</div>';

  const hourBars = hours.map((v, t) =>
    '<span style="flex:1; height:' + Math.max(4, (v / maxH) * 100).toFixed(1) + '%; background:' + (t === peak ? 'var(--hist-peak)' : 'var(--hist)') + '; min-height:1px; border-radius:1px 1px 0 0;"></span>'
  ).join('');

  const dowCells = dow.map((v, i) =>
    '<span title="' + v + ' incidents" style="height:30px; border-radius:3px; background:rgba(110,139,163,' + (0.1 + 0.55 * (v / maxD)).toFixed(2) + '); display:flex; align-items:center; justify-content:center; font:500 9px \'IBM Plex Mono\',monospace; color:var(--dow-text);">' + 'MTWTFSS'[i] + '</span>'
  ).join('');

  const recBlock =
    '<div style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:2px; letter-spacing:0.02em;">Dominant cause · ' + domCause + ' · ' + domPct + '%</div>' +
    '<div style="font:400 12.5px \'IBM Plex Sans\',sans-serif; line-height:1.6; color:var(--text); margin-top:7px;">' + intervention.fix + '.</div>' +
    '<div style="display:flex; align-items:center; gap:8px; margin-top:11px; font:500 10px \'IBM Plex Mono\',monospace; letter-spacing:0.08em; color:var(--text-2); text-transform:uppercase;">' +
      '<span>Capital cost</span>' + costMeter(intervention.cost) + '<span style="color:var(--text); letter-spacing:0.02em;">' + intervention.cost + '</span>' +
    '</div>' +
    '<div style="margin-top:11px; padding:11px 12px; background:rgba(67,176,204,0.08); border:1px solid rgba(67,176,204,0.22); border-radius:7px;">' +
      '<div style="display:flex; align-items:baseline; gap:8px;">' +
        '<span style="font:600 22px \'Space Grotesk\',sans-serif; color:var(--accent); line-height:1; font-variant-numeric:tabular-nums;">≈ ' + fmt(preventable) + '</span>' +
        '<span style="font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-2);">severe crashes preventable · 24 mo</span>' +
      '</div>' +
      '<div style="font:400 10px \'IBM Plex Mono\',monospace; color:var(--text-3); margin-top:6px; letter-spacing:0.02em;">At stake · ' + fmt(fatal) + ' fatal · ' + fmt(serious) + ' serious &nbsp;·&nbsp; planning estimate</div>' +
    '</div>';

  full.innerHTML =
    dossierHeaderHtml(h) +
    '<div style="flex:none; display:flex; align-items:baseline; gap:10px; padding:14px 18px; border-bottom:1px solid var(--border);">' +
      '<span style="font:600 42px \'Space Grotesk\',sans-serif; line-height:1; letter-spacing:-0.01em; font-variant-numeric:tabular-nums;">' + h.score + '</span>' +
      '<span style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2);">/ 100 risk score</span>' +
      '<span style="margin-left:auto; text-align:right;">' +
        '<span style="display:block; font:500 14px \'IBM Plex Mono\',monospace; font-variant-numeric:tabular-nums;">' + fmt(acc.length) + '</span>' +
        '<span style="display:block; font:400 9px \'IBM Plex Mono\',monospace; letter-spacing:0.1em; color:var(--text-2); text-transform:uppercase; margin-top:2px;">Incidents · 24 mo</span>' +
      '</span>' +
    '</div>' +
    '<div id="dossierBody" style="flex:1; overflow-y:auto; min-height:0; padding-bottom:18px;">' +
      zoneDayChipsHtml() +
      '<div style="margin-top:12px; border-top:1px solid var(--track);"></div>' +
      '<div style="padding:14px 18px 8px; font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Severity breakdown</div>' +
      sevRow('Fatal', '#E4404E', fatal) + sevRow('Serious', '#F2933E', serious) + sevRow('Slight', '#E7C64B', slight) +
      '<div style="margin-top:12px; border-top:1px solid var(--track);">' +
        '<div style="padding:14px 18px 8px; font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Time of day</div>' +
        '<div style="padding:0 18px;">' +
          '<div style="display:flex; height:6px; border-radius:2px; overflow:hidden;">' +
            '<span style="width:' + ((day / n) * 100).toFixed(1) + '%; background:var(--chart-day);"></span>' +
            '<span style="width:' + ((night / n) * 100).toFixed(1) + '%; background:var(--chart-night);"></span>' +
          '</div>' +
          '<div style="display:flex; justify-content:space-between; margin-top:6px;">' +
            '<span style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text-2);">Day ' + pc(day) + '%</span>' +
            '<span style="font:400 10.5px \'IBM Plex Mono\',monospace; color:var(--text);">Night ' + pc(night) + '%</span>' +
          '</div>' +
        '</div>' +
        '<div style="padding:14px 18px 4px; font:400 10px \'IBM Plex Mono\',monospace; color:var(--text-3);">Incidents by hour · peak ' + pad2(peak) + ':00–' + pad2((peak + 1) % 24) + ':00</div>' +
        '<div style="display:flex; align-items:flex-end; gap:2px; height:54px; padding:0 18px;">' + hourBars + '</div>' +
        '<div style="display:flex; justify-content:space-between; padding:4px 18px 0; border-top:1px solid var(--track);">' +
          '<span style="font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);">00</span><span style="font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);">06</span><span style="font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);">12</span><span style="font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);">18</span><span style="font:400 8.5px \'IBM Plex Mono\',monospace; color:var(--text-3);">23</span>' +
        '</div>' +
        '<div style="padding:12px 18px 0;">' +
          '<div style="display:grid; grid-template-columns:repeat(7, 1fr); gap:3px;">' + dowCells + '</div>' +
          '<div style="font:400 9px \'IBM Plex Mono\',monospace; color:var(--text-3); margin-top:5px;">Day of week · Mon – Sun</div>' +
        '</div>' +
      '</div>' +
      '<div style="margin-top:14px; border-top:1px solid var(--track);">' +
        dsLabel('Top causes') + rankedBars(acc, 'cause', 5, 'var(--accent)') +
      '</div>' +
      '<div style="margin-top:14px; border-top:1px solid var(--track);">' +
        dsLabel('Vehicles involved') + rankedBars(acc, 'vehicle', 5, 'var(--chart-day)') +
      '</div>' +
      '<div style="margin-top:14px; border-top:1px solid var(--track);">' +
        '<div style="padding:14px 18px 8px; font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Weather at incident</div>' +
        weatherRow('clear', clear) + weatherRow('rain', rain) + weatherRow('fog', fog) +
      '</div>' +
      '<div style="margin-top:14px; border-top:1px solid var(--track); padding:14px 18px 0;">' +
        '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--accent); text-transform:uppercase;">Recommended intervention</div>' +
        recBlock +
      '</div>' +
    '</div>';

  wireDossierClose(full);
  wireZoneDayChips(full);

  empty.style.display = 'none';
  full.style.display = 'flex';
  aside.setAttribute('data-open', 'true');
}

/* =============================================================================
   Header readouts (fully wired to filters in Phase 5)
   ========================================================================== */
function renderHeader() {
  const recs = currentRecords();
  const fatalities = recs.filter((a) => a.severity === 'fatal').length;
  setText('hdrTotal', fmt(recs.length));
  setText('hdrFatal', fmt(fatalities));
  setText('hdrZones', fmt(app.highRiskZones));
  setText('hdrTop', app.hotspots.length ? app.hotspots[0].area : '—');
}
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

/* =============================================================================
   Boot
   ========================================================================== */
async function boot() {
  renderThemeToggle();
  const tt = document.getElementById('themeToggle');
  if (tt) tt.addEventListener('click', toggleTheme);
  renderSegments();
  renderCauseFilter();
  setupFilterPanel();
  setupDossierTabs();
  setupResizers();
  initMap();

  let data;
  try {
    const res = await fetch('./data/accidents.json?v=7');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.error('Failed to load accidents.json:', err);
    const ph = document.getElementById('railPlaceholder');
    if (ph) ph.textContent = 'Could not load ./data/accidents.json — run via a local server.';
    return;
  }

  app.raw = data;
  // precompute time fields once (hour, night flag, weekday 0=Mon, month index)
  // for fast filtering + the emerging-trend analysis
  let minYM = Infinity, maxYM = -Infinity;
  app.raw.forEach((a) => {
    a._hour = parseInt(a.datetime.slice(11, 13), 10);
    a._night = a._hour < 6 || a._hour >= 18;
    const d = a.datetime.slice(0, 10).split('-');
    a._dow = (new Date(+d[0], +d[1] - 1, +d[2]).getDay() + 6) % 7;
    a._ym = (+d[0]) * 12 + (+d[1] - 1);                    // absolute year-month
    if (a._ym < minYM) minYM = a._ym;
    if (a._ym > maxYM) maxYM = a._ym;
  });
  app.monthCount = maxYM - minYM + 1;                       // ~24
  app.lastMonth = app.monthCount - 1;
  app.raw.forEach((a) => { a._month = a._ym - minYM; });    // 0 .. monthCount-1

  runHotspotEngine();
  app.cellByIdFull = app.cellById;   // snapshot full-data cells (survives filtering)
  app.hotspotsFull = app.hotspots.slice();   // Phase 3: fixed top-10 for the strategy view
  runEmergingEngine();               // Phase 2: predictive emerging watch list (over full data)
  frameToChennai();      // tight Chennai view, locked so you can't pan out to all of TN
  renderPoints();
  renderBlooms();
  renderEmergeMarkers();  // pulsing markers on the surging junctions
  renderRail();
  renderDossier();
  renderHeader();
  enableMapClickSelect(); // click anywhere on the map to inspect that cell

  // fade the "calibrating basemap" overlay once everything is mounted
  const overlay = document.getElementById('loadOverlay');
  if (overlay) {
    requestAnimationFrame(() => { overlay.style.opacity = '0'; });
    setTimeout(() => { overlay.style.display = 'none'; }, 800);
  }

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') clearSelection(); });

  // keep Leaflet in sync when the layout reflows (window resize / responsive breakpoints)
  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => app.map.invalidateSize(), 150);
  });
}

document.addEventListener('DOMContentLoaded', boot);
