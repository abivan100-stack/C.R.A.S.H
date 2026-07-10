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
const BBOX = { latMin: 12.80, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 };   // south extended to frame Kattankulathur (GST Rd)

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
const SELECT_ZOOM = 15;       // zoom level when a hotspot is selected (instant setView — no animated fly, which would flicker the canvas/bloom layers)

/* Emerging-hotspot engine (Phase 2) — flag cells whose recent monthly rate is
   climbing sharply against their own longer baseline. */
const RECENT_MONTHS = 6;      // "recent" window = last 6 months of the record
const EMERGE_LIFT = 1.5;      // recent monthly rate must be >= 1.5x the baseline rate
const EMERGE_MIN_RECENT = 8;  // and have at least this many recent incidents (noise guard)
const EMERGE_TOP_N = 6;       // how many distinct emerging junctions to surface

/* Segmented filter definitions (wired live in Phase 5) */
const SEGMENTS = {
  source:  { id: 'segSource',  options: [['All', 'all'], ['Official only', 'official'], ['Citizen only', 'citizen']] },
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
  filters: { sev: 'all', time: 'all', weather: 'all', dow: 'all', cause: 'all', source: 'all' },
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
  const { sev, time, weather, dow, cause, source } = app.filters;
  return app.raw.filter((a) => {
    if (source === 'citizen' && !a.citizen) return false;        // isolate citizen reports
    if (source === 'official' && a.citizen) return false;        // isolate official records (base dataset)
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
  el.textContent = (f.source !== 'all' || f.sev !== 'all' || f.time !== 'all' || f.weather !== 'all' || f.dow !== 'all' || f.cause !== 'all')
    ? (f.source === 'citizen' ? 'Citizen reports only'
       : f.source === 'official' ? 'Official records only'
       : 'Counts reflect active filters') : '';
}

/* Active-filter count badge on the Filters button */
function updateFilterCount() {
  const f = app.filters;
  let n = 0;
  if (f.source !== 'all') n++;
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
    app.filters.source = 'all'; app.filters.sev = 'all'; app.filters.time = 'all';
    app.filters.weather = 'all'; app.filters.dow = 'all'; app.filters.cause = 'all';
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
  if (window.CRASH_SHELL) return;   // the shell owns the single header theme toggle
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
  syncEmergeVisibility();   // hide the full-data emerging overlay under "Citizen only"
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
    zoomAnimation: true,             // mouse-wheel zoom stays smooth (it's a small, quick change)
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
  app.homeBounds = bounds;                          // remembered so deselect can zoom back out
}

/* Smoothly return to the original city-wide frame (used on deselect) */
function flyHome() {
  if (app.map && app.homeBounds) {
    // instant, crisp zoom-out on deselect (an animated fitBounds would flicker the
    // canvas/bloom layers the same way the select fly did)
    app.map.fitBounds(app.homeBounds, { padding: [28, 28], animate: false });
  }
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

/* minimal hover card for a single accident dot — mirrors the hospital popup style */
function pointTipHtml(a) {
  const sev = SEV[a.severity] || SEV.slight;
  return (
    '<div class="acc-pop-sev"><span class="acc-pop-dot" style="background:' + sev.color + ';"></span>' + sev.label + (a.citizen ? ' · citizen' : '') + '</div>' +
    '<div class="acc-pop-row">' + a.area + '</div>' +
    '<div class="acc-pop-row" style="color:var(--accent); font-weight:600;">' + a.vehicle + ' · ' + a.cause + '</div>'
  );
}

/* Plot every accident as a small, low-opacity circle coloured by severity */
function renderPoints() {
  if (app.pointLayer) app.pointLayer.remove();
  const canvas = L.canvas({ padding: 0.5 });
  app.pointLayer = L.layerGroup();

  currentRecords().forEach((a) => {
    const sev = SEV[a.severity] || SEV.slight;
    const m = a.citizen
      // citizen report — severity-coloured core inside a bright accent ring, so
      // community submissions stand out from the base incident points
      ? L.circleMarker([a.lat, a.lng], {
          renderer: canvas, radius: 5,
          stroke: true, color: ACCENT, weight: 2, opacity: 0.95,
          fillColor: sev.color, fillOpacity: 0.85,
          bubblingMouseEvents: false,
        })
      : L.circleMarker([a.lat, a.lng], {
          renderer: canvas, radius: 3.2,
          stroke: false, fillColor: sev.color, fillOpacity: 0.5,
          bubblingMouseEvents: false,   // dot click shows only its popup, not the cell select
        });
    m.bindPopup(popupHtml(a), { closeButton: true, autoPan: true });
    m.bindTooltip(pointTipHtml(a), { className: 'hotspot-tip', direction: 'top', opacity: 1 });
    app.pointLayer.addLayer(m);
  });

  app.pointLayer.addTo(app.map);
}

function popupHtml(a) {
  const sev = SEV[a.severity] || SEV.slight;
  return (
    '<div class="acc-pop-sev"><span class="acc-pop-dot" style="background:' + sev.color + '"></span>' +
      sev.label + '</div>' +
    (a.citizen ? '<div class="acc-pop-row" style="color:' + ACCENT + '; font-weight:600;">◎ Citizen report</div>' : '') +
    '<div class="acc-pop-row">' + a.datetime + '</div>' +
    '<div class="acc-pop-row">' + a.vehicle + ' · ' + a.cause + '</div>' +
    '<div class="acc-pop-row">Weather · ' + a.weather + '</div>' +
    '<div class="acc-pop-area">' + a.area + '</div>'
  );
}

/* Fly the main map to a specific report and highlight it — powers the
   notifications "click to navigate" (STEP 3). Robust to the report being filtered
   out of the live marker set: it draws its OWN temporary pulsing accent ring +
   popup at the exact lat/lng rather than depending on finding the marker. */
var _reportFocus = null, _reportFocusTimer = 0;
function reducedMotionPref() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}
function focusReport(r) {
  if (!app.map || !r || typeof r.lat !== 'number' || typeof r.lng !== 'number' || isNaN(r.lat) || isNaN(r.lng)) return false;
  if (_reportFocus) { app.map.removeLayer(_reportFocus); _reportFocus = null; }
  if (_reportFocusTimer) { clearTimeout(_reportFocusTimer); _reportFocusTimer = 0; }

  app.map.invalidateSize();                 // the map may have just been revealed by the section switch
  var reduce = reducedMotionPref();
  if (reduce) app.map.setView([r.lat, r.lng], 16);
  else app.map.flyTo([r.lat, r.lng], 16, { duration: 0.95, easeLinearity: 0.2 });

  // temporary pulsing accent ring on the exact spot
  var icon = L.divIcon({ className: 'report-focus-icon', iconSize: [44, 44], iconAnchor: [22, 22],
    html: '<div class="report-focus-ring' + (reduce ? ' no-pulse' : '') + '"></div>' });
  _reportFocus = L.marker([r.lat, r.lng], { icon: icon, interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(app.map);

  // its popup — severity, datetime, vehicle · cause, weather, area
  var popup = L.popup({ closeButton: true, autoPan: false, offset: [0, -4] })
    .setLatLng([r.lat, r.lng])
    .setContent(popupHtml({ citizen: true, severity: r.severity, datetime: r.datetime, weather: r.weather, cause: r.cause, vehicle: r.vehicle, area: r.area }));
  app.map.openPopup(popup);

  _reportFocusTimer = setTimeout(function () {
    if (_reportFocus) { app.map.removeLayer(_reportFocus); _reportFocus = null; }
  }, 4500);
  return true;
}

/* "N citizen reports" counter under the Source filter (shell only; guarded so the
   standalone dashboard is unaffected). Isolation itself is the Source filter. */
function citizenTotal() { return app.raw.reduce((s, a) => s + (a.citizen ? 1 : 0), 0); }
function updateCitizenControls() {
  const n = citizenTotal();
  const note = document.getElementById('citizenCountNote');
  if (note) note.textContent = n + ' citizen report' + (n === 1 ? '' : 's');
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
    tooltipAnchor: [0, -(d / 2)],       // hover card opens just above the glow, not over it
    html:
      '<div class="bloom' + (selected ? ' is-selected' : '') + '" style="width:' + d + 'px; height:' + d + 'px; animation-delay:' + delay + 's;">' +
        '<span class="bloom-glow" style="background:radial-gradient(circle, ' + color + 'D9 0%, ' + color + '55 38%, ' + color + '00 70%);"></span>' +
        '<span class="bloom-core" style="background:' + color + '; box-shadow:0 0 8px ' + color + 'AA;"></span>' +
        '<span class="bloom-ring" style="width:' + ringD + 'px; height:' + ringD + 'px;"></span>' +
      '</div>',
  });
}

/* minimal hover card for a hotspot bloom — mirrors the hospital popup style
   (severity dot + junction name, then rank/risk/incidents, then the severity split) */
function hotspotTipHtml(h) {
  const sev = SEV[h.dominant] || SEV.slight;
  const parts = [];
  if (h.fatal) parts.push(h.fatal + ' fatal');
  if (h.serious) parts.push(h.serious + ' serious');
  if (h.slight) parts.push(h.slight + ' slight');
  return (
    '<div class="acc-pop-sev"><span class="acc-pop-dot" style="background:' + sev.color + ';"></span>' + (h.area || 'Junction') + '</div>' +
    '<div class="acc-pop-row">Rank ' + h.rank + ' · risk ' + h.score + ' · ' + fmt(h.count) + ' incidents</div>' +
    '<div class="acc-pop-row" style="color:var(--accent); font-weight:600;">' + (parts.join(' · ') || fmt(h.count) + ' recorded') + '</div>'
  );
}

function renderBlooms() {
  if (app.bloomLayer) app.bloomLayer.remove();
  app.bloomLayer = L.layerGroup();
  app.bloomMarkers = {};

  app.hotspots.forEach((h) => {
    const m = L.marker([h.lat, h.lng], {
      icon: bloomIcon(h, app.selected === h.id),
      keyboard: true,
      riseOnHover: true,
      zIndexOffset: 400 - h.rank,        // higher-ranked blooms sit on top
    });
    m.bindTooltip(hotspotTipHtml(h), { className: 'hotspot-tip', direction: 'top', opacity: 1 });
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
  syncEmergeVisibility();
}

/* The emerging markers are a full-data strategic overlay; hide them when the map
   is isolated to citizen reports so only citizen data is shown. */
function syncEmergeVisibility() {
  if (!app.emergeLayer || !app.map) return;
  const hide = app.filters.source === 'citizen';
  if (hide) { if (app.map.hasLayer(app.emergeLayer)) app.emergeLayer.remove(); }
  else if (!app.map.hasLayer(app.emergeLayer)) app.emergeLayer.addTo(app.map);
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
  syncHospitalLinks();        // distance lines to the nearest + any marked hospital

  if (h && opts.pan) {
    // jump to the hotspot INSTANTLY (no animated fly). An animated zoom from the
    // city view to z15 CSS-scales the canvas point layer (the low-res flash) and
    // scale-snaps the bloom markers; setView({animate:false}) repaints every layer
    // crisp at the target zoom in one pass — no flicker/glitch.
    app.map.setView([h.lat, h.lng], Math.max(app.map.getZoom(), SELECT_ZOOM), { animate: false });
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
  syncHospitalLinks();       // remove the distance lines (nearest + marked)
  renderRail();
  refreshBloomSelection();
  renderDossier();
  flyHome();                 // zoom back out to the original city-wide frame
}

/* =============================================================================
   Hospital layer — real Chennai hospitals with sea / accident-overlap placement
   ========================================================================== */
/* Real Chennai hospitals at their approximate REAL coordinates (can be fine-tuned).
   type: 'Government' | 'Private'. Rendered as a distinct, calm teal/white medical
   marker (never the severity colours) so they read as a separate safety layer. */
const HOSPITALS = [
  { name: 'Rajiv Gandhi Government General Hospital',     lat: 13.0827, lng: 80.2707, area: 'Park Town',        type: 'Government' },
  { name: 'Apollo Hospitals, Greams Road',               lat: 13.0640, lng: 80.2540, area: 'Thousand Lights',  type: 'Private' },
  { name: 'MIOT International',                           lat: 13.0165, lng: 80.1770, area: 'Manapakkam',       type: 'Private' },
  { name: 'Fortis Malar Hospital',                       lat: 13.0060, lng: 80.2570, area: 'Adyar',            type: 'Private' },
  { name: 'Sri Ramachandra Medical Centre',              lat: 13.0380, lng: 80.1430, area: 'Porur',            type: 'Private' },
  { name: 'Kauvery Hospital',                            lat: 13.0480, lng: 80.2490, area: 'Alwarpet',         type: 'Private' },
  { name: 'Global Hospitals (Gleneagles)',               lat: 12.9080, lng: 80.2270, area: 'Perumbakkam',      type: 'Private' },
  { name: 'MGM Healthcare',                              lat: 13.0730, lng: 80.2200, area: 'Aminjikarai',      type: 'Private' },
  { name: 'SIMS Hospital',                               lat: 13.0520, lng: 80.2100, area: 'Vadapalani',       type: 'Private' },
  { name: 'Apollo Hospitals, OMR',                       lat: 12.9640, lng: 80.2420, area: 'Perungudi (OMR)',  type: 'Private' },
  { name: 'Stanley Government Hospital',                 lat: 13.1050, lng: 80.2870, area: 'Old Washermanpet', type: 'Government' },
  { name: 'Government Kilpauk Medical College Hospital', lat: 13.0780, lng: 80.2410, area: 'Kilpauk',          type: 'Government' },
  { name: 'Rela Institute & Medical Centre',             lat: 12.9310, lng: 80.1360, area: 'Chromepet',        type: 'Private' },
  { name: 'Government Royapettah Hospital',              lat: 13.0530, lng: 80.2640, area: 'Royapettah',       type: 'Government' },
];

/* ---- Placement safety constants (editable) ---- */
const HOSP_LAT_MIN = 12.80, HOSP_LAT_MAX = 13.20;   // Chennai land latitude band
const HOSP_LNG_MIN = 80.10;                          // western inland limit
/* Eastern coastline: lng of the Bay of Bengal shore at a given latitude, linearly
   interpolated between these control points (the diagonal Chennai coast). */
const HOSP_COAST = [[12.80, 80.250], [12.95, 80.263], [13.02, 80.272], [13.06, 80.285], [13.10, 80.300], [13.15, 80.322], [13.20, 80.340]];
const COAST_INSET_DEG = 0.004;      // keep clamped points ~440 m inland of the shore
const OVERLAP_THRESHOLD_M = 45;     // a hospital nearer than this to an accident dot is nudged
const NUDGE_STEP_M = 50;            // how far each nudge moves it (kept small — stays ~real)
const MAX_NUDGES = 5;               // cap the walk so a hospital never drifts far from home
const M_PER_DEG_LAT = 111320;       // metres per degree of latitude (~constant)

/* eastern coastline longitude at a latitude (piecewise-linear) */
function hospCoastLngAt(lat) {
  const p = HOSP_COAST;
  if (lat <= p[0][0]) return p[0][1];
  if (lat >= p[p.length - 1][0]) return p[p.length - 1][1];
  for (let i = 1; i < p.length; i++) {
    if (lat <= p[i][0]) {
      const a = p[i - 1], b = p[i], t = (lat - a[0]) / (b[0] - a[0]);
      return a[1] + t * (b[1] - a[1]);
    }
  }
  return p[p.length - 1][1];
}

/* clamp a point back onto valid Chennai land (bounds + coastline) — the SEA CHECK */
function clampToLand(lat, lng) {
  const la = Math.min(Math.max(lat, HOSP_LAT_MIN), HOSP_LAT_MAX);
  let ln = Math.max(lng, HOSP_LNG_MIN);
  const eastLimit = hospCoastLngAt(la) - COAST_INSET_DEG;
  if (ln > eastLimit) ln = eastLimit;
  return [la, ln];
}

/* Haversine great-circle distance in km (pure JS, no API) */
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* fast approximate planar distance in metres — accurate enough at the tens-of-metres
   scale of the overlap check */
function metersBetween(lat1, lng1, lat2, lng2) {
  const mLat = (lat1 - lat2) * M_PER_DEG_LAT;
  const mLng = (lng1 - lng2) * M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  return Math.sqrt(mLat * mLat + mLng * mLng);
}

/* nearest accident point to (lat,lng) in metres, with a cheap bounding-box pre-filter
   so it stays fast over the full ~10k-point set */
function nearestAccidentMeters(lat, lng, records) {
  const box = 0.0025;                 // ~275 m — comfortably larger than threshold + nudge
  let best = Infinity, bestAcc = null;
  for (let i = 0; i < records.length; i++) {
    const a = records[i];
    if (Math.abs(a.lat - lat) > box || Math.abs(a.lng - lng) > box) continue;
    const d = metersBetween(lat, lng, a.lat, a.lng);
    if (d < best) { best = d; bestAcc = a; }
  }
  return { dist: best, acc: bestAcc };
}

/* Resolve each hospital's DISPLAY position: (1) clamp onto land (never the sea), then
   (2) nudge minimally off any accident dot it sits on, re-clamping so a nudge can't
   push it into the sea. Real coords stay in .lat/.lng; display in .dlat/.dlng. */
function placeHospitals(records) {
  records = records || [];
  return HOSPITALS.map((h) => {
    let pos = clampToLand(h.lat, h.lng);
    for (let k = 0; k < MAX_NUDGES; k++) {
      const near = nearestAccidentMeters(pos[0], pos[1], records);
      if (!near.acc || near.dist > OVERLAP_THRESHOLD_M) break;   // clear of accidents — done
      let dLat = pos[0] - near.acc.lat, dLng = pos[1] - near.acc.lng, mag = Math.hypot(dLat, dLng);
      if (mag < 1e-9) { dLat = 1; dLng = 0; mag = 1; }           // exactly coincident — pick a bearing
      const step = NUDGE_STEP_M / M_PER_DEG_LAT;
      pos = clampToLand(pos[0] + (dLat / mag) * step, pos[1] + (dLng / mag) * step);
    }
    return Object.assign({}, h, { dlat: pos[0], dlng: pos[1] });
  });
}

/* nearest hospital to a point (Haversine). list defaults to the placed cache. */
function nearestHospitalTo(lat, lng, list) {
  list = list || app.hospitals || (app.hospitals = placeHospitals(app.raw));
  let best = null, bestKm = Infinity;
  for (let i = 0; i < list.length; i++) {
    const km = haversineKm(lat, lng, list[i].dlat, list[i].dlng);
    if (km < bestKm) { bestKm = km; best = list[i]; }
  }
  return best ? { hospital: best, km: bestKm } : null;
}

/* distinct medical-cross marker; Government (light chip, teal cross) vs Private (teal
   chip, dark cross) — both calm, never the severity red/orange/yellow */
function hospitalIcon(type) {
  const cls = type === 'Government' ? 'hosp-gov' : 'hosp-pri';
  return L.divIcon({
    className: 'hosp-divicon', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -13],
    html: '<span class="hosp-marker ' + cls + '"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M5 0.5h2V5h4.5v2H7v4.5H5V7H0.5V5H5z" fill="currentColor"/></svg></span>',
  });
}

/* Popup for a hospital marker — its identity plus, when a zone is selected, the
   straight-line distance from that zone; otherwise a prompt to pick a zone first.
   Bound as a function so it reflects the CURRENT selection each time it opens. */
function hospitalPopupHtml(h) {
  const sel = selectedCell();
  let dist;
  if (sel) {
    const km = haversineKm(sel.lat, sel.lng, h.dlat, h.dlng);
    dist = '<div class="acc-pop-row" style="color:var(--accent); font-weight:600;">' +
      km.toFixed(1) + ' km from ' + (sel.area || 'the selected zone') + ' · straight-line</div>';
  } else {
    dist = '<div class="acc-pop-row" style="color:var(--text-3);">Select an accident zone to measure distance</div>';
  }
  return (
    '<div class="acc-pop-sev"><span class="hosp-pop-dot"></span>' + h.name + '</div>' +
    '<div class="acc-pop-row">' + h.type + ' hospital · ' + h.area + '</div>' +
    dist
  );
}

/* build (once) the hospital marker layer over the placement-corrected list */
function buildHospitalLayer() {
  app.hospitals = placeHospitals(app.raw);
  app.hospitalLayer = L.layerGroup();
  app.hospitals.forEach((h) => {
    const m = L.marker([h.dlat, h.dlng], { icon: hospitalIcon(h.type), riseOnHover: true, keyboard: false });
    m.bindPopup(() => hospitalPopupHtml(h), { closeButton: true, autoPan: true });   // function → live distance
    m.on('click', () => markHospital(h));                                            // clicking a marker also marks it
    app.hospitalLayer.addLayer(m);
  });
}

/* show/hide the hospital layer (default OFF) + its legend chip */
function setHospitalsVisible(on) {
  app.hospitalsOn = !!on;
  if (!app.hospitalLayer) buildHospitalLayer();
  if (app.hospitalsOn) app.hospitalLayer.addTo(app.map);
  else if (app.map && app.map.hasLayer(app.hospitalLayer)) app.hospitalLayer.remove();
  const btn = document.getElementById('hospitalsBtn');
  if (btn) { btn.classList.toggle('active', app.hospitalsOn); btn.setAttribute('aria-pressed', app.hospitalsOn ? 'true' : 'false'); }
  const leg = document.getElementById('legendHospital');
  if (leg) leg.style.display = app.hospitalsOn ? 'flex' : 'none';
  syncHospitalLinks();          // show/remove the distance line(s) in step with the layer's visibility
}
function setupHospitalsToggle() {
  const btn = document.getElementById('hospitalsBtn');
  if (btn) btn.addEventListener('click', () => setHospitalsVisible(!app.hospitalsOn));
}

/* =============================================================================
   Critical junctions — a curated overlay of Chennai's high-traffic, high-risk
   intersections. These accident counts are junction-level ANNOTATIONS held here,
   deliberately SEPARATE from the incident dataset, so they never skew the hotspot
   engine, the ranked index, or the analytics numbers.
   ========================================================================== */
const CRITICAL_JUNCTIONS = [
  { name: 'Kathipara Junction', lat: 12.9897, lng: 80.2004,
    roads: 'GST Road × Anna Salai × Inner Ring Road', traffic: 'Very high', peak: '08:00–11:00 · 17:30–21:00',
    total: 47, fatal: 9, serious: 21, slight: 17, cause: 'High-speed weaving on the cloverleaf ramps' },
  { name: 'Koyambedu Junction', lat: 13.0694, lng: 80.1948,
    roads: '100 Feet Road × Poonamallee High Road (CMBT)', traffic: 'Very high', peak: '07:00–10:00 · 18:00–21:00',
    total: 38, fatal: 6, serious: 17, slight: 15, cause: 'Bus & lorry turns across dense two-wheeler flow' },
  { name: 'Madhya Kailash Junction', lat: 12.9955, lng: 80.2490,
    roads: 'Sardar Patel Road × Rajiv Gandhi Salai (OMR)', traffic: 'High', peak: '08:30–10:30 · 18:00–20:30',
    total: 34, fatal: 5, serious: 15, slight: 14, cause: 'OMR IT-corridor merging speed' },
  { name: 'Vadapalani Junction', lat: 13.0510, lng: 80.2120,
    roads: 'Arcot Road × 100 Feet Road (JN Salai)', traffic: 'High', peak: '09:00–11:00 · 18:00–21:00',
    total: 29, fatal: 4, serious: 13, slight: 12, cause: 'Signal jumping at the Arcot Road crossing' },
  { name: 'Anna Nagar Roundtana', lat: 13.0850, lng: 80.2101,
    roads: '2nd Avenue × Shanthi Colony Main Road', traffic: 'High', peak: '08:00–10:00 · 18:00–20:00',
    total: 22, fatal: 3, serious: 9, slight: 10, cause: 'Lane-cutting around the roundabout' },
];

/* distinct accent junction node with a crossroads glyph (never a severity colour) */
function junctionIcon() {
  return L.divIcon({
    className: 'junc-divicon', iconSize: [28, 28], iconAnchor: [14, 14], tooltipAnchor: [0, -15],
    html: '<span class="junc-mark"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">' +
          '<path d="M8 1.4v13.2M1.4 8h13.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
          '<circle cx="8" cy="8" r="2.3" fill="currentColor"/></svg></span>',
  });
}

/* hover card for a junction — identity, the roads that meet, traffic + peak, and
   its accident record (severity split coloured by severity) */
function junctionTipHtml(j) {
  return (
    '<div class="acc-pop-sev"><span class="junc-pop-dot"></span>' + j.name + '</div>' +
    '<div class="acc-pop-row">' + j.roads + '</div>' +
    '<div class="acc-pop-row">' + j.traffic + ' traffic · peak ' + j.peak + '</div>' +
    '<div class="acc-pop-row"><b style="color:var(--text); font-weight:600;">' + j.total + '</b> accidents · ' +
      '<span style="color:var(--fatal); font-weight:600;">' + j.fatal + ' fatal</span> · ' +
      '<span style="color:var(--serious); font-weight:600;">' + j.serious + ' serious</span> · ' +
      '<span style="color:var(--slight); font-weight:600;">' + j.slight + ' slight</span></div>' +
    '<div class="acc-pop-row" style="color:var(--accent);">Main cause · ' + j.cause + '</div>'
  );
}

/* select the accident cell under a lat/lng (mirrors the map-click 3×3 fallback) */
function selectNearestCell(lat, lng) {
  const ci = Math.floor((lat - BBOX.latMin) / CELL);
  const cj = Math.floor((lng - BBOX.lngMin) / CELL);
  let cell = app.cellById[ci + '_' + cj];
  if (!cell) {
    let best = null;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const c = app.cellById[(ci + di) + '_' + (cj + dj)];
        if (c && (!best || c.count > best.count)) best = c;
      }
    }
    cell = best;
  }
  if (cell) selectHotspot(cell.id, { pan: true });
}

function buildJunctionLayer() {
  app.junctionLayer = L.layerGroup();
  CRITICAL_JUNCTIONS.forEach((j) => {
    const m = L.marker([j.lat, j.lng], { icon: junctionIcon(), riseOnHover: true, keyboard: false, zIndexOffset: 600 });
    m.bindTooltip(junctionTipHtml(j), { className: 'hotspot-tip junc-tip', direction: 'top', opacity: 1 });
    m.on('click', () => selectNearestCell(j.lat, j.lng));   // open the surrounding area's dossier
    app.junctionLayer.addLayer(m);
  });
}

/* show/hide the critical-junction overlay (default ON) + its legend chip */
function setJunctionsVisible(on) {
  app.junctionsOn = !!on;
  if (!app.junctionLayer) buildJunctionLayer();
  if (app.junctionsOn) app.junctionLayer.addTo(app.map);
  else if (app.map && app.map.hasLayer(app.junctionLayer)) app.junctionLayer.remove();
  const btn = document.getElementById('junctionsBtn');
  if (btn) { btn.classList.toggle('active', app.junctionsOn); btn.setAttribute('aria-pressed', app.junctionsOn ? 'true' : 'false'); }
  const leg = document.getElementById('legendJunction');
  if (leg) leg.style.display = app.junctionsOn ? 'flex' : 'none';
}

function setupJunctionsToggle() {
  const btn = document.getElementById('junctionsBtn');
  if (btn) btn.addEventListener('click', () => setJunctionsVisible(!app.junctionsOn));
}

/* Mark a SPECIFIC hospital for comparison (from a marker click or the dropdown).
   Its distance to the selected zone is shown in the dossier + a white dashed line;
   the choice persists so selecting a new zone recalculates it. */
function markHospital(h) {
  app.markedHospital = h || null;
  const sel = document.getElementById('hospCompareSelect');
  if (sel && app.hospitals) {
    const idx = app.hospitals.findIndex((x) => x.name === (h && h.name));
    sel.value = idx >= 0 ? String(idx) : '';
  }
  renderMarkedDistance();
  syncHospitalLinks();
}

/* fill the dossier "distance to the marked hospital" readout (1 dp, tabular km) */
function renderMarkedDistance() {
  const el = document.getElementById('hospMarkedReadout');
  if (!el) return;
  const h = selectedCell(), m = app.markedHospital;
  if (!h || !m) { el.innerHTML = ''; return; }
  const km = haversineKm(h.lat, h.lng, m.dlat, m.dlng);
  el.innerHTML =
    '<div style="display:flex; align-items:center; gap:8px; margin-top:9px;">' +
      '<span class="hosp-line-swatch marked"></span>' +
      '<span style="font:400 12px \'IBM Plex Sans\',sans-serif; color:var(--text); line-height:1.4;">Distance from this zone to <b style="font-weight:600;">' + m.name + '</b>: <span class="hosp-km">' + km.toFixed(1) + ' km</span></span>' +
    '</div>';
}

/* Draw the distance lines from the selected zone: a solid accent line to the NEAREST
   hospital, and (if one is marked) a white dashed line to the MARKED hospital, so the
   two can be compared. Both are removed whenever there is no selected zone. */
function syncHospitalLinks() {
  if (app.hospitalLinkNearest) { app.hospitalLinkNearest.remove(); app.hospitalLinkNearest = null; }
  if (app.hospitalLinkMarked) { app.hospitalLinkMarked.remove(); app.hospitalLinkMarked = null; }
  if (!app.map) return;
  if (!app.hospitalsOn) return;   // distance lines belong to the hospital layer — no markers shown, no lines
  const h = selectedCell();
  if (!h) return;
  const near = nearestHospitalTo(h.lat, h.lng);
  if (near) {
    app.hospitalLinkNearest = L.polyline([[h.lat, h.lng], [near.hospital.dlat, near.hospital.dlng]], {
      color: ACCENT, weight: 2, opacity: 0.85, interactive: false, className: 'hosp-link',
    }).addTo(app.map);
  }
  const m = app.markedHospital;
  if (m) {
    app.hospitalLinkMarked = L.polyline([[h.lat, h.lng], [m.dlat, m.dlng]], {
      color: '#FFFFFF', weight: 1.6, opacity: 0.9, dashArray: '5 6', interactive: false, className: 'hosp-link',
    }).addTo(app.map);
  }
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

/* City-wide "Contributing factors" tab — cause + vehicle distributions across
   the current (filtered) dataset. (Leverage + priority live in the Strategy tab.) */
function renderCity() {
  const c = document.getElementById('dossierCity');
  if (!c) return;
  const recs = currentRecords();
  const anyFilter = app.filters.sev !== 'all' || app.filters.time !== 'all' || app.filters.weather !== 'all' ||
    app.filters.dow !== 'all' || app.filters.cause !== 'all';
  c.innerHTML =
    '<div style="flex:none; padding:15px 18px 13px; border-bottom:1px solid var(--border);">' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Contributing factors</div>' +
      '<div style="display:flex; align-items:baseline; gap:9px; margin-top:5px;">' +
        '<span style="font:600 30px \'Space Grotesk\',sans-serif; line-height:1; font-variant-numeric:tabular-nums;">' + fmt(recs.length) + '</span>' +
        '<span style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2);">incidents' + (anyFilter ? ' · filtered' : ' · all data') + '</span>' +
      '</div>' +
    '</div>' +
    '<div style="flex:1; overflow-y:auto; min-height:0; padding-bottom:18px;">' +
      dsLabel('Cause distribution' + (anyFilter ? ' · filtered' : '')) + rankedBars(recs, 'cause', CAUSES.length, 'var(--accent)') +
      '<div style="margin-top:12px; border-top:1px solid var(--track);"></div>' +
      dsLabel('Vehicles involved' + (anyFilter ? ' · filtered' : '')) + rankedBars(recs, 'vehicle', VEHICLES.length, 'var(--chart-day)') +
    '</div>';
}

/* City "Strategy" tab (Phase 3, over ALL data) — the leverage headline, the
   intervention priority queue, and the city-report download. Kept in its own
   tab so it never has to be scrolled past the contributing-factors view. */
function renderStrategy() {
  const c = document.getElementById('dossierStrategy');
  if (!c) return;
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
      '<div style="font:400 11px \'IBM Plex Sans\',sans-serif; color:var(--text-2); margin-top:6px; line-height:1.5;">Where the harm concentrates — and the order to fix it.</div>' +
    '</div>' +
    '<div style="flex:1; overflow-y:auto; min-height:0; padding-bottom:18px;">' +
      // ---- leverage headline ----
      '<div style="padding:16px 18px 2px;">' +
        '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--accent); text-transform:uppercase;">The leverage</div>' +
        '<div style="margin-top:11px; padding:16px; background:rgba(67,176,204,0.07); border:1px solid rgba(67,176,204,0.22); border-radius:9px; text-align:left;">' +
          '<div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">' +
            '<span style="font:600 42px \'Space Grotesk\',sans-serif; color:var(--accent); line-height:1; font-variant-numeric:tabular-nums;">' + lev.pct + '%</span>' +
            '<span style="font:500 13px \'IBM Plex Sans\',sans-serif; color:var(--text); line-height:1.4;">of severe crashes</span>' +
          '</div>' +
          '<div style="font:400 13px \'IBM Plex Sans\',sans-serif; color:var(--text); line-height:1.55; margin-top:10px;">are concentrated in just <b>' + lev.n + '</b> junction cells across the whole city.</div>' +
          '<div style="font:400 10px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:10px; letter-spacing:0.02em;">' + fmt(lev.sevTop) + ' of ' + fmt(lev.sevCity) + ' fatal + serious · 250 m cells</div>' +
        '</div>' +
      '</div>' +
      // ---- intervention priority queue ----
      '<div style="padding:18px 18px 6px;">' +
        '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase;">Intervention priority</div>' +
        '<div style="font:400 10.5px \'IBM Plex Sans\',sans-serif; color:var(--text-3); margin-top:4px; line-height:1.5;">Ranked by estimated severe crashes preventable if the fix targets each zone’s dominant cause. <span style="color:var(--text-3);">Planning estimate.</span></div>' +
      '</div>' +
      queueRows +
      // ---- download city report ----
      '<div style="padding:18px 18px 2px;">' +
        '<button data-citypdf type="button" title="Download the full city report as a PDF" style="width:100%; display:inline-flex; align-items:center; justify-content:center; gap:8px; font:500 11px \'IBM Plex Mono\',monospace; letter-spacing:0.04em; color:var(--accent); background:rgba(67,176,204,0.08); border:1px solid rgba(67,176,204,0.35); border-radius:7px; padding:10px; cursor:pointer;">' +
          '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7m0 0 3-3m-3 3L5 6M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          'Download city report (PDF)</button>' +
      '</div>' +
    '</div>';

  c.querySelectorAll('[data-pq]').forEach((el) => {
    el.addEventListener('click', () => selectHotspot(el.dataset.pq, { pan: true }));
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--row-hover)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'transparent'; });
    el.addEventListener('focus', () => { el.style.outline = '1px solid ' + ACCENT; el.style.outlineOffset = '-2px'; });
    el.addEventListener('blur', () => { el.style.outline = 'none'; });
  });

  const cpdf = c.querySelector('[data-citypdf]');
  if (cpdf) cpdf.addEventListener('click', () => { if (window.CRASHReport) window.CRASHReport.city(app.raw); });
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
    '<div style="display:flex; align-items:center; gap:16px; margin-top:11px; flex-wrap:wrap;">' +
      '<a href="./compare.html?a=' + encodeURIComponent(h.area) + '" title="Compare ' + h.area + ' with another area" style="display:inline-flex; align-items:center; gap:6px; font:500 10.5px \'IBM Plex Mono\',monospace; letter-spacing:0.04em; color:var(--accent); text-decoration:none;">' +
        '<svg width="12" height="12" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 6h9l-2.5-2.5M14 12H5l2.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        'Compare this area</a>' +
      '<button data-zonepdf type="button" title="Download this zone as a PDF report" style="display:inline-flex; align-items:center; gap:6px; background:transparent; border:none; padding:0; cursor:pointer; font:500 10.5px \'IBM Plex Mono\',monospace; letter-spacing:0.04em; color:var(--accent);">' +
        '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v7m0 0 3-3m-3 3L5 6M3 13h10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        'Download PDF</button>' +
    '</div>' +
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

/* wire the zone dossier's "distance to a specific hospital" dropdown, and paint the
   marked readout for whatever hospital is currently marked */
function wireHospitalCompare(root) {
  const sel = root.querySelector('#hospCompareSelect');
  if (sel) {
    sel.addEventListener('change', () => {
      const v = sel.value;
      const list = app.hospitals || placeHospitals(app.raw);
      app.markedHospital = (v === '') ? null : list[+v];
      renderMarkedDistance();
      syncHospitalLinks();
    });
  }
  renderMarkedDistance();   // paint the marked distance if a hospital is already marked
}

function renderDossier() {
  const empty = document.getElementById('dossierEmpty');
  const full = document.getElementById('dossierFull');
  const aside = document.getElementById('dossier');
  const zone = document.getElementById('dossierZone');
  const panels = {
    city: document.getElementById('dossierCity'),
    strategy: document.getElementById('dossierStrategy'),
    emerging: document.getElementById('dossierEmerging'),
  };

  // tab visuals (Strategy lives in the header, not the tab bar)
  document.querySelectorAll('.dtab').forEach((b) => b.classList.toggle('active', b.dataset.tab === app.dossierTab));
  const sBtn = document.getElementById('strategyBtn');
  if (sBtn) sBtn.classList.toggle('active', app.dossierTab === 'strategy');

  // hide every panel (and the zone view); the active branch re-shows its own
  Object.keys(panels).forEach((k) => { if (panels[k]) panels[k].style.display = 'none'; });
  if (zone) zone.style.display = 'none';

  if (app.dossierTab === 'city') { if (panels.city) panels.city.style.display = 'flex'; renderCity(); aside.setAttribute('data-open', 'true'); return; }
  if (app.dossierTab === 'strategy') { if (panels.strategy) panels.strategy.style.display = 'flex'; renderStrategy(); aside.setAttribute('data-open', 'true'); return; }
  if (app.dossierTab === 'emerging') { if (panels.emerging) panels.emerging.style.display = 'flex'; renderEmerging(); aside.setAttribute('data-open', 'true'); return; }

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

  // when the map is isolated to citizen reports, the dossier is showing
  // user-reported data — the engineering "recommended intervention" is not
  // meaningful for a handful of unverified reports, so it is dropped as bloat.
  const userReported = app.filters.source === 'citizen';

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

  // hospital distances for this hotspot (Haversine, pure JS): the auto-nearest, plus a
  // dropdown to compare a specific hospital the user marks. Both shown so they compare.
  const nh = nearestHospitalTo(h.lat, h.lng);
  const hospList = app.hospitals || placeHospitals(app.raw);
  const hospOptions = hospList.map((hp, i) =>
    '<option value="' + i + '"' + (app.markedHospital && app.markedHospital.name === hp.name ? ' selected' : '') + '>' + hp.name + '</option>'
  ).join('');
  const hospitalBlock = nh ?
    '<div style="margin-top:14px; border-top:1px solid var(--track); padding:14px 18px 0;">' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--accent); text-transform:uppercase;">Nearest hospital</div>' +
      '<div style="display:flex; align-items:center; gap:8px; margin-top:8px;">' +
        '<span class="hosp-line-swatch nearest"></span>' +
        '<span style="font:500 13px \'IBM Plex Sans\',sans-serif; color:var(--text); line-height:1.35;">' + nh.hospital.name + '</span>' +
      '</div>' +
      '<div style="font:400 11px \'IBM Plex Mono\',monospace; color:var(--text-2); margin-top:5px; letter-spacing:0.02em;">' + nh.hospital.area + ' · ' + nh.hospital.type + ' &nbsp;·&nbsp; <span class="hosp-km">' + nh.km.toFixed(1) + ' km</span></div>' +
      '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--text-2); text-transform:uppercase; margin-top:14px;">Distance to a specific hospital</div>' +
      '<select id="hospCompareSelect" class="hosp-select" aria-label="Choose a hospital to measure its distance from this zone">' +
        '<option value="">— choose a hospital —</option>' + hospOptions +
      '</select>' +
      '<div id="hospMarkedReadout"></div>' +
      '<div class="hosp-note">Straight-line distance · direct, not by road</div>' +
    '</div>' : '';

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
      hospitalBlock +
      (userReported ? '' :
        '<div style="margin-top:14px; border-top:1px solid var(--track); padding:14px 18px 0;">' +
          '<div style="font:500 9.5px \'IBM Plex Mono\',monospace; letter-spacing:0.18em; color:var(--accent); text-transform:uppercase;">Recommended intervention</div>' +
          recBlock +
        '</div>') +
    '</div>';

  wireDossierClose(full);
  wireZoneDayChips(full);
  wireHospitalCompare(full);

  const zpdf = full.querySelector('[data-zonepdf]');
  if (zpdf) zpdf.addEventListener('click', () => {
    if (!window.CRASHReport) return;
    const recs = accidentsForHotspot(h, app.raw);   // full-data profile for this cell
    window.CRASHReport.zone(recs, { title: h.area, rank: h.rank, lat: h.lat, lng: h.lng });
  });

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
  if (tt && !window.CRASH_SHELL) tt.addEventListener('click', toggleTheme);
  renderSegments();
  renderCauseFilter();
  setupFilterPanel();
  setupDossierTabs();
  const sBtn = document.getElementById('strategyBtn');
  if (sBtn) sBtn.addEventListener('click', () => { ensureDossierVisible(); setDossierTab('strategy'); });
  setupResizers();
  setupHospitalsToggle();
  setupJunctionsToggle();
  initMap();

  let data;
  try {
    const res = await fetch('./data/accidents.json?v=9');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.error('Failed to load accidents.json:', err);
    const ph = document.getElementById('railPlaceholder');
    if (ph) ph.textContent = 'Could not load ./data/accidents.json — run via a local server.';
    return;
  }

  // shipped seed of scattered citizen reports (optional file) + any this browser
  // has saved. Both feed every engine exactly like the base data; the seed is
  // never written back to localStorage (see persistCitizenReports).
  let seed = [];
  try { const sres = await fetch('./data/citizen_seed.json?v=1'); if (sres.ok) seed = await sres.json(); }
  catch (e) { /* seed is optional */ }
  // STEP 3 — merge SHARED citizen reports from the backend (so reports filed on
  // OTHER devices show up here) with this browser's LOCAL ones, de-duplicated by
  // content. If the backend is unreachable, fall back silently to the local ones.
  const localReports = loadCitizenReports();
  const sharedReports = await fetchSharedReports();
  app.raw = data.concat(loadSeedReports(seed)).concat(mergeCitizenReports(sharedReports, localReports));
  // precompute time fields once (hour, night flag, weekday 0=Mon, month index)
  // for fast filtering + the emerging-trend analysis
  app.raw.forEach(prepRecord);
  recomputeMonths();                                        // monthCount, lastMonth, _month

  runHotspotEngine();
  app.cellByIdFull = app.cellById;   // snapshot full-data cells (survives filtering)
  app.hotspotsFull = app.hotspots.slice();   // Phase 3: fixed top-10 for the strategy view
  runEmergingEngine();               // Phase 2: predictive emerging watch list (over full data)
  frameToChennai();      // tight Chennai view, locked so you can't pan out to all of TN
  renderPoints();
  renderBlooms();
  setJunctionsVisible(true);   // curated critical-junction overlay, shown by default
  renderEmergeMarkers();  // pulsing markers on the surging junctions
  renderRail();
  renderDossier();
  renderHeader();
  updateCitizenControls();  // initial "N citizen reports" count (incl. any merged from localStorage)
  // tell the notifications system about every citizen report loaded on startup
  // (localStorage + backend), so the bell panel survives a page refresh (STEP 4)
  try { document.dispatchEvent(new CustomEvent('crash:reports-loaded', { detail: app.raw.filter(function (a) { return a.citizen && !a.seed; }) })); } catch (e) {}
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

  // signal the shell's citizen-report form that the live dataset is ready
  window.CRASH_READY = true;
  try { document.dispatchEvent(new Event('crash:ready')); } catch (e) {}
}

document.addEventListener('DOMContentLoaded', boot);

/* =============================================================================
   Shell integration (index.html single-page shell)
   The one header theme toggle lives in the shell and dispatches
   'crash:themechange'; keep the basemap tiles in sync. And expose a hook so the
   shell can re-fit the map after the Map section becomes visible again (Leaflet
   sizes to 0 while its container is display:none).
   ========================================================================== */
document.addEventListener('crash:themechange', function () {
  if (app.tileLayer) app.tileLayer.setUrl(TILES[currentTheme()]);
});
window.__crashRefreshMap = function () { if (app.map) app.map.invalidateSize(); };

/* =============================================================================
   Citizen-report bridge (Phase 8)
   The Reports section hosts a "Report an accident" form. app.js owns the single
   live dataset, so the form talks to the map through this small API instead of
   keeping its own copy. Area helpers resolve a dropped pin to an area (and an
   area back to a point), judged against the same records that drive the map.
   ========================================================================== */
const CITIZEN_KEY = 'citizen_reports';

/* derive the fast-filter fields for one record (hour, night, weekday, year-month) */
function prepRecord(a) {
  a._hour = parseInt(a.datetime.slice(11, 13), 10);
  a._night = a._hour < 6 || a._hour >= 18;
  const d = a.datetime.slice(0, 10).split('-');
  a._dow = (new Date(+d[0], +d[1] - 1, +d[2]).getDay() + 6) % 7;
  a._ym = (+d[0]) * 12 + (+d[1] - 1);                       // absolute year-month
  return a;
}
/* (re)derive the month span across the whole dataset and each record's _month */
function recomputeMonths() {
  let minYM = Infinity, maxYM = -Infinity;
  app.raw.forEach((a) => { if (a._ym < minYM) minYM = a._ym; if (a._ym > maxYM) maxYM = a._ym; });
  app.monthCount = maxYM - minYM + 1;
  app.lastMonth = app.monthCount - 1;
  app.raw.forEach((a) => { a._month = a._ym - minYM; });
}

/* a stored report must be well-formed before we trust it in the engines */
function isValidReport(r) {
  return r && typeof r === 'object' &&
    typeof r.lat === 'number' && isFinite(r.lat) &&
    typeof r.lng === 'number' && isFinite(r.lng) &&
    SEV[r.severity] &&
    typeof r.datetime === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(r.datetime) &&
    typeof r.cause === 'string' && typeof r.vehicle === 'string' && typeof r.area === 'string';
}
function loadCitizenReports() {
  try {
    const raw = localStorage.getItem(CITIZEN_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidReport).map((r) => { r.citizen = true; delete r.seed; delete r.shared; return r; });
  } catch (e) { return []; }
}
/* shipped seed reports — validated, flagged citizen + seed (seed never persisted) */
function loadSeedReports(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(isValidReport).map((r) => { r.citizen = true; r.seed = true; return r; });
}
/* persist just the LOCAL user-submitted citizen reports — not the shipped seed and
   not the backend-shared ones (those live on the server) — in the base
   accidents.json schema (no derived fields) */
function persistCitizenReports() {
  try {
    const out = app.raw.filter((a) => a.citizen && !a.seed && !a.shared).map((a) => ({
      id: a.id, lat: a.lat, lng: a.lng, severity: a.severity, datetime: a.datetime,
      weather: a.weather, cause: a.cause, vehicle: a.vehicle, area: a.area, citizen: true,
    }));
    localStorage.setItem(CITIZEN_KEY, JSON.stringify(out));
  } catch (e) {}
}

/* content signature over the 8 report fields, so the same report coming from two
   sources (the backend AND localStorage) is counted only once when merging */
function reportSignature(r) {
  return [
    Number(r.lat).toFixed(5), Number(r.lng).toFixed(5), r.severity,
    r.datetime, r.weather, r.cause, r.vehicle, r.area,
  ].join('|');
}

/* STEP 3 — fetch the SHARED citizen reports from the backend. Each is validated,
   flagged citizen + shared (so it's never re-persisted locally), and given an id
   from its Mongo _id. Returns [] on ANY failure (bad status, non-array, network,
   timeout) so the app silently falls back to local reports when the backend is
   unreachable — the base map/analytics never break. */
async function fetchSharedReports() {
  const API = window.API_BASE || '';
  const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 6000) : 0;
  try {
    const res = await fetch(API + '/reports', ctrl ? { signal: ctrl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return [];
    const arr = await res.json();
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidReport).map((r) => ({
      lat: r.lat, lng: r.lng, severity: r.severity, datetime: r.datetime,
      weather: r.weather, cause: r.cause, vehicle: r.vehicle, area: r.area,
      citizen: true, shared: true,
      id: r._id ? ('m' + r._id) : ('c' + Math.random().toString(36).slice(2, 8)),
    }));
  } catch (e) { if (timer) clearTimeout(timer); return []; }
}

/* merge SHARED (backend) + LOCAL (localStorage) citizen reports, de-duplicated by
   content signature. Shared come first (the authoritative cross-device store); a
   local report already present on the backend is not added a second time. */
function mergeCitizenReports(shared, local) {
  const seen = Object.create(null), out = [];
  const add = (r) => { const s = reportSignature(r); if (!seen[s]) { seen[s] = true; out.push(r); } };
  (shared || []).forEach(add);
  (local || []).forEach(add);
  return out;
}

let _areaCentroids = null;                        // { area: [lat, lng] }, cached
function areaCentroids() {
  if (_areaCentroids) return _areaCentroids;
  const acc = {};
  app.raw.forEach((a) => {
    const c = acc[a.area] || (acc[a.area] = { lat: 0, lng: 0, n: 0 });
    c.lat += a.lat; c.lng += a.lng; c.n++;
  });
  _areaCentroids = {};
  Object.keys(acc).forEach((k) => { _areaCentroids[k] = [acc[k].lat / acc[k].n, acc[k].lng / acc[k].n]; });
  return _areaCentroids;
}
function invalidateAreaCache() { _areaCentroids = null; }
function uniqueAreas() { return Object.keys(areaCentroids()).sort(); }
function nearestAreaTo(lat, lng) {
  // nearest actual record's area — robust for irregularly-shaped areas
  let best = null, bestD = Infinity;
  for (let i = 0; i < app.raw.length; i++) {
    const a = app.raw[i];
    const dLat = a.lat - lat, dLng = a.lng - lng;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) { bestD = d; best = a.area; }
  }
  return best;
}

window.CRASH_APP = {
  onReady: function (cb) {
    if (window.CRASH_READY) cb();
    else document.addEventListener('crash:ready', function () { cb(); }, { once: true });
  },
  areas: function () { return uniqueAreas(); },
  causes: function () { return CAUSES.slice(); },
  vehicles: function () { return VEHICLES.slice(); },
  areaCentroid: function (area) { return areaCentroids()[area] || null; },
  nearestArea: function (lat, lng) { return nearestAreaTo(lat, lng); },
  bbox: function () { return { latMin: BBOX.latMin, latMax: BBOX.latMax, lngMin: BBOX.lngMin, lngMax: BBOX.lngMax }; },
  center: function () { return CHENNAI.center.slice(); },
  tileUrl: function () { return TILES[currentTheme()]; },
  // the live in-memory dataset + the exact grid definition, so the Simulate model
  // reuses the SAME ~250 m cells and cell key as the hotspot engine
  records: function () { return app.raw; },
  grid: function () { return { cell: CELL, latMin: BBOX.latMin, latMax: BBOX.latMax, lngMin: BBOX.lngMin, lngMax: BBOX.lngMax }; },
  citizenCount: function () { return citizenTotal(); },

  /* Add a citizen report to the live dataset: derive its fields, recompute the
     full-data snapshots (ranking + emerging), re-render the map + rail + header
     under the active filter, and refresh the analytics (heatmap + KPI stats).
     persistLocal controls the localStorage write: the backend is the shared store,
     so we persist locally ONLY as the offline fallback (pass false on a successful
     POST). Omitted/true keeps the original behaviour. Returns the stored record. */
  addReport: function (rec, persistLocal) {
    rec.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    rec.citizen = true;
    prepRecord(rec);
    app.raw.push(rec);
    invalidateAreaCache();                 // a brand-new area may now exist
    recomputeMonths();

    // refresh the strategy/emerging snapshots over ALL data (filter-independent)
    app.filtered = null;
    runHotspotEngine();
    app.cellByIdFull = app.cellById;
    app.hotspotsFull = app.hotspots.slice();
    runEmergingEngine();
    renderEmergeMarkers();

    // re-run the interactive filter → repaints points, blooms, rail, dossier, header
    applyFilters();
    updateCitizenControls();   // bump the "N citizen reports" counter

    // keep the analytics section (heatmap + KPI stats) in lock-step, live
    if (typeof window.__crashRebuildAnalytics === 'function') window.__crashRebuildAnalytics(app.raw);

    if (persistLocal !== false) persistCitizenReports();   // offline fallback / back-compat; skip when the backend saved it
    return rec;
  },

  /* fly / jump the main map to a coordinate + zoom (used by the map place-search) */
  flyTo: function (lat, lng, zoom) {
    if (!app.map || typeof lat !== 'number' || typeof lng !== 'number' || isNaN(lat) || isNaN(lng)) return;
    app.map.invalidateSize();
    var z = zoom || 15;
    if (reducedMotionPref()) app.map.setView([lat, lng], z, { animate: false });
    else app.map.flyTo([lat, lng], z, { duration: 0.9, easeLinearity: 0.2 });
  },

  /* fly the map to a citizen report + highlight it (notifications click-to-navigate) */
  focusReport: function (r) { return focusReport(r); },
};
