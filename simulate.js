/* =============================================================================
   Simulate — Monte Carlo risk projection
   A probabilistic projection of WHERE accidents are likely to concentrate under
   user-chosen conditions, derived from historical accident patterns. It is NOT a
   prediction of specific future events (the UI carries that framing prominently).

   STEP 1: section shell + scenario controls + a themed Leaflet map that matches
   the main map. The historical model, the Monte Carlo engine, the animated map
   layer, and the results sidebar arrive in later steps.

   Loads after app.js and reuses the shared window.CRASH_APP bridge (tiles, bbox)
   so this map is visually identical to the main one — and, in later steps, so the
   model reuses the SAME ~250 m grid and the SAME in-memory dataset.
   ========================================================================== */
(function () {
  'use strict';

  var map = null, tileLayer = null, wired = false, simulated = false;
  var pointLayer = null, heatLayer = null, rankLayer = null, animRaf = 0, canvasRenderer = null;   // STEP 4 projection layers
  var simChart = null, lastProjection = null;   // STEP 5 results sidebar
  var SEV_COLOR = { fatal: '#E4404E', serious: '#F2933E', slight: '#E7C64B' };
  var SEV_LABEL = { fatal: 'Fatal', serious: 'Serious', slight: 'Slight' };
  // STEP 6 — results-panel empty-state copy: default vs. a scenario with no history
  var EMPTY_TITLE = 'No projection yet';
  var EMPTY_NOTE = 'Run the simulation to project where accidents are likely to concentrate — with a projected total, ranked hotspots, and a chart.';
  var NOMATCH_TITLE = 'No historical match';
  var NOMATCH_NOTE = 'No past accidents match this exact combination of conditions, so there is nothing to project. Broaden a filter — set one back to “Any” — and run again.';

  // scenario state — read by the engine in later steps. Defaults to Any/Any/Any.
  var scenario = { timeOfDay: 'any', weather: 'any', dayType: 'any', horizonMonths: 6 };
  function getScenario() {
    return { timeOfDay: scenario.timeOfDay, weather: scenario.weather, dayType: scenario.dayType, horizonMonths: scenario.horizonMonths };
  }

  function bridge() { return window.CRASH_APP; }

  /* ---- themed projection map (mirrors app.js initMap + frameToChennai) ---- */
  function initMap() {
    if (map || !document.getElementById('simMap') || !bridge()) return;
    map = L.map('simMap', {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,                 // fast layer for the projected points (step 4)
      minZoom: 9, maxZoom: 19,
      zoomSnap: 0.25, zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90, wheelDebounceTime: 25,
      zoomAnimation: true,
      maxBoundsViscosity: 1.0,
    });
    L.control.zoom({ position: 'bottomright', zoomInTitle: 'Zoom in', zoomOutTitle: 'Zoom out' }).addTo(map);

    tileLayer = L.tileLayer(bridge().tileUrl(), {
      subdomains: 'abcd', maxZoom: 20, attribution: '© OpenStreetMap contributors © CARTO',
    }).addTo(map);

    var bb = bridge().bbox();
    var bounds = L.latLngBounds([bb.latMin, bb.lngMin], [bb.latMax, bb.lngMax]);
    map.fitBounds(bounds, { padding: [24, 24] });
    map.setMaxBounds(bounds.pad(0.08));   // hard-leash panning to Chennai
    map.setMinZoom(map.getZoom());        // can't zoom out past the city frame
    map.__homeBounds = bounds;            // remembered so Reset can zoom back out

    // keep the basemap (and, if shown, the results chart) in sync with the theme toggle
    document.addEventListener('crash:themechange', function () {
      if (tileLayer) tileLayer.setUrl(bridge().tileUrl());
      if (lastProjection && simChart) renderChart(lastProjection.pts);
    });
  }

  function goHome() {
    if (map && map.__homeBounds) {
      map.flyToBounds(map.__homeBounds, { padding: [24, 24], duration: 0.7, easeLinearity: 0.2 });
    }
  }

  /* ---- scenario controls ---- */
  function setSeg(id, v) {
    var wrap = document.getElementById(id);
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
    });
  }
  function wireSeg(id, key) {
    var wrap = document.getElementById(id);
    if (!wrap) return;
    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-v]');
      if (!btn) return;
      scenario[key] = btn.dataset.v;
      setSeg(id, btn.dataset.v);
      applyLive();                           // filters update the projection live (after a run)
    });
  }

  // filters are LOCKED until a simulation has run; then any change re-projects live
  function setFiltersLocked(locked) {
    var el = document.getElementById('simFilters');
    if (el) el.classList.toggle('locked', locked);
    var hint = document.getElementById('simFilterHint');
    if (hint) hint.textContent = locked
      ? 'Run the projection, then filter it here.'
      : 'Filtering the projection live — change any control to update.';
  }
  function applyLive() {
    if (!simulated) return;                  // ignore until the first run
    var s = getScenario();
    renderProjection(runSimulation(s), s, false);   // instant update (no re-animation) when filtering
  }

  function wireControls() {
    if (wired) return;
    wired = true;
    wireSeg('simTime', 'timeOfDay');
    wireSeg('simWeather', 'weather');
    wireSeg('simDayType', 'dayType');

    var hz = document.getElementById('simHorizon');
    if (hz) hz.addEventListener('change', function () { scenario.horizonMonths = parseInt(hz.value, 10) || 6; applyLive(); });

    // "Run simulation" runs the full projection first; filters unlock afterwards
    var run = document.getElementById('simRun');
    if (run) run.addEventListener('click', function () {
      simulated = true;
      setFiltersLocked(false);
      var s = getScenario();
      renderProjection(runSimulation(s), s, true);   // animated reveal on the run
    });

    var reset = document.getElementById('simReset');
    if (reset) reset.addEventListener('click', resetScenario);

    setFiltersLocked(true);                 // start locked until the first run
  }

  function resetScenario() {
    scenario = { timeOfDay: 'any', weather: 'any', dayType: 'any', horizonMonths: 6 };
    setSeg('simTime', 'any');
    setSeg('simWeather', 'any');
    setSeg('simDayType', 'any');
    var hz = document.getElementById('simHorizon');
    if (hz) hz.value = '6';
    simulated = false;
    setFiltersLocked(true);                // re-lock the filters
    clearProjection();                     // clear the projected points + heat field
    goHome();                              // return to the default Chennai view
  }

  /* =========================================================================
     STEP 2 — the historical model (statistical foundation, pure functions)

     Grounded in the VERIFIED historical record (accidents.json). Citizen-submitted
     reports (flagged .citizen) are EXCLUDED so a handful of unverified submissions
     can't skew the projection. Reuses the SAME ~250 m grid, cell key, cell centre
     (accident centroid = sumLat/count) and severity weights (fatal 3 / serious 2 /
     slight 1) as the main hotspot engine — no second, inconsistent grid.
     ======================================================================== */
  var _model = null;          // cached after first build (base data is static post-load)

  function baseRecords() {
    return (bridge().records() || []).filter(function (a) { return !a.citizen; });
  }
  function severityWeightOf(sev) { return sev === 'fatal' ? 3 : sev === 'serious' ? 2 : 1; }

  function buildModel() {
    var grid = bridge().grid();
    var recs = baseRecords();
    var cells = {};
    var joint = {};            // "time|weather|dayType" -> count (city-wide, for prevalence)
    var minYM = Infinity, maxYM = -Infinity;

    for (var i = 0; i < recs.length; i++) {
      var a = recs[i];
      var ci = Math.floor((a.lat - grid.latMin) / grid.cell);
      var cj = Math.floor((a.lng - grid.lngMin) / grid.cell);
      var key = ci + '_' + cj;
      var c = cells[key];
      if (!c) {
        c = cells[key] = { cellId: key, ci: ci, cj: cj, count: 0, severityWeight: 0, sumLat: 0, sumLng: 0,
          night: 0, day: 0, clear: 0, rain: 0, fog: 0, weekday: 0, weekend: 0,
          fatal: 0, serious: 0, slight: 0, areas: {}, causes: {} };
      }
      c.count++;
      c.sumLat += a.lat; c.sumLng += a.lng;
      c.severityWeight += severityWeightOf(a.severity);
      if (a.severity === 'fatal') c.fatal++; else if (a.severity === 'serious') c.serious++; else c.slight++;

      var hh = parseInt(a.datetime.slice(11, 13), 10);        // "YYYY-MM-DD HH:MM"
      var isNight = hh < 6 || hh >= 18;                       // night = 18:00–06:00 (matches app)
      if (isNight) c.night++; else c.day++;
      var wKey = a.weather === 'rain' ? 'rain' : a.weather === 'fog' ? 'fog' : 'clear';
      c[wKey]++;
      var p = a.datetime.slice(0, 10).split('-');
      var dow = new Date(+p[0], +p[1] - 1, +p[2]).getDay();   // 0=Sun … 6=Sat
      var isWeekend = dow === 0 || dow === 6;
      if (isWeekend) c.weekend++; else c.weekday++;

      c.areas[a.area] = (c.areas[a.area] || 0) + 1;
      c.causes[a.cause] = (c.causes[a.cause] || 0) + 1;

      var jk = (isNight ? 'night' : 'day') + '|' + wKey + '|' + (isWeekend ? 'weekend' : 'weekday');
      joint[jk] = (joint[jk] || 0) + 1;

      var ym = (+p[0]) * 12 + (+p[1] - 1);
      if (ym < minYM) minYM = ym;
      if (ym > maxYM) maxYM = ym;
    }

    var monthCount = (isFinite(minYM) ? (maxYM - minYM + 1) : 0) || 1;
    var list = Object.keys(cells).map(function (k) {
      var c = cells[k], n = c.count;
      var domArea = null, domN = -1;
      for (var ar in c.areas) { if (c.areas[ar] > domN) { domN = c.areas[ar]; domArea = ar; } }
      return {
        cellId: c.cellId,
        centerLat: c.sumLat / n,                 // accident centroid — same as the hotspot engine
        centerLng: c.sumLng / n,
        count: n,
        severityWeight: c.severityWeight,
        nightFrac: c.night / n, dayFrac: c.day / n,
        clearFrac: c.clear / n, rainFrac: c.rain / n, fogFrac: c.fog / n,
        weekdayFrac: c.weekday / n, weekendFrac: c.weekend / n,
        // internal fields consumed by the sampler + results (steps 3 & 5):
        _ci: c.ci, _cj: c.cj, _area: domArea,
        _sev: { fatal: c.fatal, serious: c.serious, slight: c.slight },
        _causes: c.causes,
      };
    });
    list.sort(function (x, y) { return y.count - x.count; });   // densest cells first

    return {
      cells: list,
      joint: joint,
      // city-wide monthly accident rate — scales the horizon to a realistic volume
      cityRate: { totalCount: recs.length, monthCount: monthCount, monthlyRate: recs.length / monthCount },
    };
  }

  function model() {
    if (_model) return _model;
    if (!bridge() || baseRecords().length === 0) return null;   // data not loaded yet
    _model = buildModel();
    return _model;
  }

  function getCellModel() { var m = model(); return m ? m.cells : []; }
  function getCityRate() { var m = model(); return m ? m.cityRate : null; }

  /* =========================================================================
     STEP 3 — Monte Carlo projection engine (pure, deterministic)

       runSimulation(scenario) -> [{lat, lng, cellId, projectedSeverity}]

     Base intensity per cell = severityWeight (NOT raw count): the projection is a
     RISK field, so cells with more severe crashes carry proportionally more
     projected risk — consistent with the hotspot engine's severity-weighted score.

     Deterministic: mulberry32 is seeded from the scenario, so the same scenario
     always reproduces the exact same set of points (repeatable live demos).
     ======================================================================== */

  // small seeded PRNG (mulberry32) — deterministic, unlike Math.random()
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // FNV-1a hash of the scenario -> 32-bit seed
  function seedFrom(s) {
    var str = s.timeOfDay + '|' + s.weather + '|' + s.dayType + '|' + s.horizonMonths;
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  // standard normal via Box–Muller (consumes 2 draws). u = 1 - rng() ∈ (0,1] so
  // Math.log(u) is always finite (never log(0)).
  function gaussian(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // keep a jittered point inside [lo,hi] by REFLECTING off the boundary — avoids
  // the thin edge pile-up a hard clamp would create — with a clamp as a final
  // guard for the (never-hit in practice) case of an excess larger than the range.
  function reflect(v, lo, hi) {
    if (v < lo) v = lo + (lo - v);
    if (v > hi) v = hi - (v - hi);
    return v < lo ? lo : (v > hi ? hi : v);
  }

  function normScenario(scenario) {
    scenario = scenario || {};
    return {
      timeOfDay: scenario.timeOfDay || 'any',
      weather: scenario.weather || 'any',
      dayType: scenario.dayType || 'any',
      horizonMonths: parseInt(scenario.horizonMonths, 10) || 6,
    };
  }

  // how well a cell matches the scenario — product of its conditional fractions
  // (Any on a dimension contributes 1). Rainy-night up-weights cells with high
  // rainFrac AND high nightFrac.
  function scenarioMultiplier(cell, s) {
    var t = s.timeOfDay === 'night' ? cell.nightFrac : s.timeOfDay === 'day' ? cell.dayFrac : 1;
    var w = s.weather === 'rain' ? cell.rainFrac : s.weather === 'fog' ? cell.fogFrac : s.weather === 'clear' ? cell.clearFrac : 1;
    var d = s.dayType === 'weekday' ? cell.weekdayFrac : s.dayType === 'weekend' ? cell.weekendFrac : 1;
    return t * w * d;
  }

  // city-wide JOINT prevalence of the chosen conditions (fraction of all base
  // accidents that match). Any/Any/Any -> 1.
  function scenarioPrevalence(s, m) {
    var total = m.cityRate.totalCount || 1, matched = 0;
    for (var key in m.joint) {
      var p = key.split('|');                       // [time, weather, dayType]
      if ((s.timeOfDay === 'any' || s.timeOfDay === p[0]) &&
          (s.weather === 'any' || s.weather === p[1]) &&
          (s.dayType === 'any' || s.dayType === p[2])) matched += m.joint[key];
    }
    return matched / total;
  }

  // sample a severity from the cell's historical mix (fatal-heavy cells -> more fatal)
  function sampleSeverity(cell, rng) {
    var sv = cell._sev, n = sv.fatal + sv.serious + sv.slight;
    if (n <= 0) return 'slight';
    var r = rng() * n;
    if (r < sv.fatal) return 'fatal';
    if (r < sv.fatal + sv.serious) return 'serious';
    return 'slight';
  }

  function runSimulation(scenario) {
    var m = model();
    if (!m) return [];
    var s = normScenario(scenario);
    var grid = bridge().grid();

    // 1) projected TOTAL = expected volume over the horizon (city monthly rate ×
    //    months), then only the slice matching these conditions (joint prevalence).
    //    Any/Any/Any -> full expected volume; a rare scenario -> proportionally fewer.
    var prevalence = scenarioPrevalence(s, m);
    var projectedTotal = Math.round(m.cityRate.monthlyRate * s.horizonMonths * prevalence);
    if (projectedTotal <= 0) return [];

    // 2) per-cell scenario weight = base risk intensity × conditional match; build
    //    the cumulative array for weighted (roulette-wheel) allocation.
    var cells = m.cells, n = cells.length;
    var cum = new Array(n), W = 0;
    for (var i = 0; i < n; i++) { W += cells[i].severityWeight * scenarioMultiplier(cells[i], s); cum[i] = W; }
    if (W <= 0) return [];

    // 3) allocate each projected point to a cell (proportional to weight), jitter
    //    around the cell centre (Gaussian ~cell radius), sample severity from mix.
    var rng = mulberry32(seedFrom(s));
    var sigma = grid.cell * 0.5;                     // ~cell radius (~125 m)
    var pts = new Array(projectedTotal);
    for (var k = 0; k < projectedTotal; k++) {
      var target = rng() * W;
      // smallest index with cum[idx] > target  (cell idx owns [cum[idx-1], cum[idx]))
      var lo = 0, hi = n - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] <= target) lo = mid + 1; else hi = mid; }
      var cell = cells[lo];
      var la = reflect(cell.centerLat + gaussian(rng) * sigma, grid.latMin, grid.latMax);
      var ln = reflect(cell.centerLng + gaussian(rng) * sigma, grid.lngMin, grid.lngMax);
      pts[k] = { lat: la, lng: ln, cellId: cell.cellId, projectedSeverity: sampleSeverity(cell, rng) };
    }
    return pts;
  }

  /* console inspector for the test — city rate + top-N cells + landmark cells,
     with explicit checks that the conditional fractions each sum to ~1 */
  function logModel(n) {
    var m = model();
    if (!m) { console.warn('[Simulate] model not ready — data still loading.'); return null; }
    n = n || 8;
    var r = m.cityRate;
    console.log('%c[Simulate] historical model — base accidents.json (citizen reports excluded)', 'color:#43B0CC;font-weight:600');
    console.log('  city-wide: ' + r.totalCount + ' accidents over ' + r.monthCount + ' months = ' + r.monthlyRate.toFixed(1) + ' accidents/month');
    console.log('  grid cells with ≥1 accident: ' + m.cells.length + ' (same ~250 m grid as the hotspot engine)');
    console.table(m.cells.slice(0, n).map(function (c) {
      return {
        cell: c.cellId, area: c._area, count: c.count, sevWeight: c.severityWeight,
        night: +c.nightFrac.toFixed(2), day: +c.dayFrac.toFixed(2), 'n+d': +(c.nightFrac + c.dayFrac).toFixed(3),
        clear: +c.clearFrac.toFixed(2), rain: +c.rainFrac.toFixed(2), fog: +c.fogFrac.toFixed(2), 'c+r+f': +(c.clearFrac + c.rainFrac + c.fogFrac).toFixed(3),
        weekday: +c.weekdayFrac.toFixed(2), weekend: +c.weekendFrac.toFixed(2), 'wd+we': +(c.weekdayFrac + c.weekendFrac).toFixed(3),
      };
    }));
    var marks = { 'Kathipara / Guindy': [13.0089, 80.2013], 'OMR / Perungudi': [12.9650, 80.2420], 'T. Nagar': [13.0418, 80.2341] };
    var g = bridge().grid();
    Object.keys(marks).forEach(function (name) {
      var la = marks[name][0], ln = marks[name][1];
      var key = Math.floor((la - g.latMin) / g.cell) + '_' + Math.floor((ln - g.lngMin) / g.cell);
      var cell = null;
      for (var i = 0; i < m.cells.length; i++) { if (m.cells[i].cellId === key) { cell = m.cells[i]; break; } }
      if (cell) console.log('  ' + name + ' [' + key + ']: ' + cell.count + ' accidents · night ' + Math.round(cell.nightFrac * 100) + '% · rain ' + Math.round(cell.rainFrac * 100) + '% · fog ' + Math.round(cell.fogFrac * 100) + '% · weekend ' + Math.round(cell.weekendFrac * 100) + '%');
      else console.log('  ' + name + ' [' + key + ']: no accidents in that exact cell');
    });
    return m;
  }

  /* console inspector for the STEP 3 test — total, prevalence, top projected
     cells, severity mix, and an out-of-bbox check */
  function logSim(scenario) {
    var m = model();
    if (!m) { console.warn('[Simulate] model not ready — data still loading.'); return []; }
    var s = normScenario(scenario);
    var pts = runSimulation(s);
    var prev = scenarioPrevalence(s, m);
    console.log('%c[Simulate] projection ' + JSON.stringify(s), 'color:#43B0CC;font-weight:600');
    console.log('  scenario prevalence in data: ' + (prev * 100).toFixed(1) + '%  →  projected total: ' + pts.length + ' points');
    var cellMap = {};
    m.cells.forEach(function (c) { cellMap[c.cellId] = c; });
    var top = projectedHotspots(pts, cellMap, 10);
    console.log('  top 10 projected places:');
    console.table(top.map(function (h, i) {
      return { rank: i + 1, area: h.area, cell: h.cellId, projected: h.count, fatal: h.fatal, serious: h.serious, slight: h.slight,
        nightFrac: cellMap[h.cellId] ? +cellMap[h.cellId].nightFrac.toFixed(2) : null, rainFrac: cellMap[h.cellId] ? +cellMap[h.cellId].rainFrac.toFixed(2) : null };
    }));
    var sev = { fatal: 0, serious: 0, slight: 0 }, g = bridge().grid(), out = 0;
    pts.forEach(function (p) { sev[p.projectedSeverity]++; if (p.lat < g.latMin || p.lat > g.latMax || p.lng < g.lngMin || p.lng > g.lngMax) out++; });
    console.log('  projected severity mix:', JSON.stringify(sev), '· points outside bbox:', out);
    return pts;
  }

  /* =========================================================================
     STEP 4 — visualise the projection on the map

     A soft heat "risk field" (Leaflet.heat, tuned to the dark basemap) sits
     beneath severity-coloured points drawn on a shared CANVAS renderer (so a few
     thousand points stay smooth). The points are revealed with a brief staggered
     fade + scale-in (~1.2 s) — skipped entirely when prefers-reduced-motion is set.
     ======================================================================== */
  var SEV_RADIUS = { fatal: 4.2, serious: 3.6, slight: 3.0 };
  var SEV_HEAT = { fatal: 1.0, serious: 0.65, slight: 0.4 };

  function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch (e) { return false; }
  }
  function showLegend(on) { var el = document.getElementById('simMapLegend'); if (el) el.hidden = !on; }

  // STEP 6 — show the results panel's empty state, with swappable title/note copy
  function showEmptyState(title, note) {
    var empty = document.getElementById('simEmpty');
    var body = document.getElementById('simResultsBody');
    if (body) body.hidden = true;
    if (empty) empty.hidden = false;
    var t = document.getElementById('simEmptyTitle'); if (t) t.textContent = title;
    var nt = document.getElementById('simEmptyNote'); if (nt) nt.textContent = note;
    var lc = document.getElementById('simLowConf'); if (lc) lc.hidden = true;
  }

  function clearProjection() {
    if (animRaf) { cancelAnimationFrame(animRaf); animRaf = 0; }
    if (map && pointLayer) map.removeLayer(pointLayer);
    if (map && heatLayer) map.removeLayer(heatLayer);
    if (map && rankLayer) map.removeLayer(rankLayer);
    pointLayer = null; heatLayer = null; rankLayer = null;
    showLegend(false);
    // STEP 5: reset the results sidebar back to its empty state
    if (simChart) { try { simChart.destroy(); } catch (e) {} simChart = null; }
    lastProjection = null;
    showEmptyState(EMPTY_TITLE, EMPTY_NOTE);   // reset the results panel to its default copy
  }

  function scenarioLabel(s) {
    var t = { any: 'Any time', day: 'Daytime', night: 'Night' }[s.timeOfDay];
    var w = { any: 'any weather', clear: 'clear', rain: 'rain', fog: 'fog' }[s.weather];
    var d = { any: 'any day', weekday: 'weekday', weekend: 'weekend' }[s.dayType];
    return t + ' · ' + w + ' · ' + d + ' · ' + s.horizonMonths + ' mo';
  }

  var SUPPRESS = 2;   // ~500 m — keep ranked hotspots as DISTINCT junctions (matches the app)
  // group projected points per cell (count + severity mix), ranked, non-max-suppressed, top-N
  function projectedHotspots(pts, cellMap, n) {
    n = n || 10;
    var byCell = {};
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var g = byCell[p.cellId] || (byCell[p.cellId] = { cellId: p.cellId, count: 0, fatal: 0, serious: 0, slight: 0 });
      g.count++; g[p.projectedSeverity]++;
    }
    var all = Object.keys(byCell).map(function (k) {
      var g = byCell[k], c = cellMap[k], parts = k.split('_');
      g.area = c ? c._area : '—';
      g.lat = c ? c.centerLat : null; g.lng = c ? c.centerLng : null;
      g.ci = c ? c._ci : +parts[0]; g.cj = c ? c._cj : +parts[1];
      return g;
    }).sort(function (a, b) { return b.count - a.count; });
    // non-max suppression so ranked markers/rows are separate junctions, not
    // adjacent cells whose markers would overlap
    var picked = [];
    for (var j = 0; j < all.length && picked.length < n; j++) {
      var h = all[j], clash = false;
      for (var q = 0; q < picked.length; q++) {
        if (Math.abs(picked[q].ci - h.ci) <= SUPPRESS && Math.abs(picked[q].cj - h.cj) <= SUPPRESS) { clash = true; break; }
      }
      if (!clash) picked.push(h);
    }
    return picked;
  }

  function pointPopup(p, cell, s) {
    return '<div class="acc-pop-sev"><span class="acc-pop-dot" style="background:' + (SEV_COLOR[p.projectedSeverity] || SEV_COLOR.slight) + '"></span>' + (SEV_LABEL[p.projectedSeverity] || p.projectedSeverity) + '</div>' +
      '<div class="acc-pop-row" style="color:#43B0CC; font-weight:600;">◇ Projected incident</div>' +
      '<div class="acc-pop-row">' + scenarioLabel(s) + '</div>' +
      '<div class="acc-pop-area">' + (cell ? cell._area : '—') + '</div>';
  }
  function rankPopup(rank, h) {
    return '<div class="acc-pop-sev" style="color:#43B0CC; font-weight:600;">◆ Projected hotspot #' + rank + '</div>' +
      '<div class="acc-pop-area">' + h.area + '</div>' +
      '<div class="acc-pop-row">' + h.count + ' projected incidents</div>' +
      '<div class="acc-pop-row">' + h.fatal + ' fatal · ' + h.serious + ' serious · ' + h.slight + ' slight</div>';
  }
  function renderRankMarkers(hs) {
    rankLayer = L.layerGroup().addTo(map);
    for (var i = 0; i < hs.length; i++) {
      var h = hs[i]; if (h.lat == null) continue;
      var rank = i + 1;
      var icon = L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="sim-rank">' + rank + '</div>' });
      var mk = L.marker([h.lat, h.lng], { icon: icon, zIndexOffset: 500, riseOnHover: true, title: 'Projected hotspot #' + rank + ' · ' + h.area });
      mk.bindPopup(rankPopup(rank, h), { closeButton: true, autoPan: true });
      (function (lat, lng) {
        mk.on('click', function () { if (map) map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.7, easeLinearity: 0.2 }); });
      })(h.lat, h.lng);
      mk.addTo(rankLayer);
    }
  }

  function renderProjection(pts, scenario, animate) {
    clearProjection();
    if (!map) return;
    scenario = scenario || getScenario();
    var s6 = normScenario(scenario);
    var mdl = model(), cellMap = {};
    if (mdl) for (var ci = 0; ci < mdl.cells.length; ci++) cellMap[mdl.cells[ci].cellId] = mdl.cells[ci];

    // STEP 6 — degenerate scenario (no historical match): project nothing, but show
    // a clear, explanatory empty state instead of a silently blank map + panel.
    if (!pts || !pts.length) { showEmptyState(NOMATCH_TITLE, NOMATCH_NOTE); return; }

    // STEP 6 — flag a low-confidence projection: a rare scenario backed by little
    // history. Any/Any/Any is the full baseline and is never low-confidence.
    var prevalence = mdl ? scenarioPrevalence(s6, mdl) : 1;
    var isAny = s6.timeOfDay === 'any' && s6.weather === 'any' && s6.dayType === 'any';
    var lowConf = !isAny && (prevalence < 0.05 || pts.length < 60);

    // ---- soft heat field beneath the points; max adapts to projection density ----
    var hs = projectedHotspots(pts, cellMap, 10);
    var maxCell = hs.length ? hs[0].count : 1;
    if (typeof L.heatLayer === 'function') {
      var heatMax = Math.max(2.5, Math.min(30, maxCell * 0.4));
      var heatPts = pts.map(function (p) { return [p.lat, p.lng, SEV_HEAT[p.projectedSeverity] || 0.4]; });
      heatLayer = L.heatLayer(heatPts, {
        radius: 24, blur: 18, minOpacity: 0.12, max: heatMax,
        gradient: { 0.0: 'rgba(67,176,204,0)', 0.25: 'rgba(67,176,204,0.55)', 0.5: '#E7C64B', 0.78: '#F2933E', 1.0: '#E4404E' },
      }).addTo(map);
    }

    // ---- projected points on a shared canvas renderer (each clickable) ----
    if (!canvasRenderer) canvasRenderer = L.canvas({ padding: 0.5 });
    pointLayer = L.layerGroup().addTo(map);
    var reduce = prefersReducedMotion() || animate === false;   // instant when filtering
    var markers = new Array(pts.length);
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var target = SEV_RADIUS[p.projectedSeverity] || 3.0;
      var m = L.circleMarker([p.lat, p.lng], {
        renderer: canvasRenderer, radius: reduce ? target : 0.01, stroke: false,
        fillColor: SEV_COLOR[p.projectedSeverity] || SEV_COLOR.slight, fillOpacity: reduce ? 0.8 : 0,
        bubblingMouseEvents: false,
      });
      m.bindPopup(pointPopup(p, cellMap[p.cellId], scenario), { closeButton: true, autoPan: true });
      m.addTo(pointLayer);
      markers[i] = { m: m, target: target, start: 0, done: false };
    }

    // ---- top-10 projected hotspot markers (ranked, labelled, clickable) ----
    renderRankMarkers(hs);
    showLegend(true);

    // ---- STEP 5: results sidebar (total + ranked hotspots + chart) ----
    lastProjection = { pts: pts, hs: hs, scenario: scenario };
    renderResults(pts, hs, scenario, cellMap, { lowConf: lowConf, prevalence: prevalence });

    if (reduce) return;                          // instant render — no animation

    // ---- staggered fade + scale-in over ~1.2 s (canvas redraws once per frame) ----
    var OP = 0.8, DURATION = 1200, TRANS = 300, n = markers.length;
    var span = Math.max(1, DURATION - TRANS);
    for (var j = 0; j < n; j++) markers[j].start = (n <= 1 ? 0 : (j / (n - 1)) * span);
    var t0 = null;
    function frame(ts) {
      if (t0 === null) t0 = ts;
      var elapsed = ts - t0;
      for (var k = 0; k < n; k++) {
        var mk = markers[k];
        if (mk.done || elapsed < mk.start) continue;
        var pg = Math.min(1, (elapsed - mk.start) / TRANS);
        var e = 1 - Math.pow(1 - pg, 3);         // easeOutCubic
        mk.m.setRadius(mk.target * e);
        mk.m.setStyle({ fillOpacity: OP * e });
        if (pg >= 1) mk.done = true;
      }
      if (elapsed < DURATION) { animRaf = requestAnimationFrame(frame); return; }
      for (var q = 0; q < n; q++) { if (!markers[q].done) { markers[q].m.setRadius(markers[q].target); markers[q].m.setStyle({ fillOpacity: OP }); markers[q].done = true; } }
      animRaf = 0;                               // guarantee every point ends at its final style
    }
    animRaf = requestAnimationFrame(frame);
  }

  /* =========================================================================
     STEP 5 — results sidebar: projected total, ranked hotspots, chart
     ======================================================================== */
  function fmtInt(n) { return Number(n).toLocaleString('en-US'); }

  function renderResults(pts, hs, scenario, cellMap, meta) {
    var empty = document.getElementById('simEmpty');
    var body = document.getElementById('simResultsBody');
    if (empty) empty.hidden = true;
    if (body) body.hidden = false;

    var totalEl = document.getElementById('simTotal');
    if (totalEl) totalEl.textContent = fmtInt(pts.length);
    var horizonEl = document.getElementById('simTotalHorizon');
    if (horizonEl) horizonEl.textContent = 'next ' + scenario.horizonMonths + ' months';
    var noteEl = document.getElementById('simScenarioNote');
    if (noteEl) noteEl.textContent = scenarioLabel(scenario);

    // STEP 6 — low-confidence banner for rare scenarios (hidden otherwise)
    var low = !!(meta && meta.lowConf);
    var lc = document.getElementById('simLowConf');
    if (lc) lc.hidden = !low;
    var lct = document.getElementById('simLowConfText');
    if (lct && low) {
      var pct = (meta.prevalence || 0) * 100;
      var pctStr = pct >= 1 ? Math.round(pct) + '%' : pct.toFixed(1) + '%';
      lct.textContent = 'Rare scenario — only about ' + pctStr + ' of past accidents match these conditions, so this ' +
        fmtInt(pts.length) + '-incident projection is low-confidence. Widen a filter for a steadier estimate.';
    }

    renderList(hs);
    renderChart(pts, cellMap);
  }

  function renderList(hs) {
    var list = document.getElementById('simList');
    if (!list) return;
    list.innerHTML = hs.map(function (h, i) {
      var n = h.count || 1;
      var f = (h.fatal / n * 100), s = (h.serious / n * 100), l = (h.slight / n * 100);
      return '<button class="sim-row" type="button" data-lat="' + h.lat + '" data-lng="' + h.lng + '">' +
        '<span class="sim-row-rank">' + (i + 1) + '</span>' +
        '<span class="sim-row-main">' +
          '<span class="sim-row-area">' + h.area + '</span>' +
          '<span class="sim-mb">' +
            '<span style="width:' + f.toFixed(1) + '%;background:#E4404E"></span>' +
            '<span style="width:' + s.toFixed(1) + '%;background:#F2933E"></span>' +
            '<span style="width:' + l.toFixed(1) + '%;background:#E7C64B"></span>' +
          '</span>' +
        '</span>' +
        '<span class="sim-row-count">' + fmtInt(h.count) + '</span>' +
      '</button>';
    }).join('');
    Array.prototype.forEach.call(list.querySelectorAll('.sim-row'), function (row) {
      row.addEventListener('click', function () {
        var lat = parseFloat(row.dataset.lat), lng = parseFloat(row.dataset.lng);
        if (map && !isNaN(lat) && !isNaN(lng)) map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.7, easeLinearity: 0.2 });
      });
    });
  }

  // projected accident count by top area (bar chart), themed to match the app
  function renderChart(pts, cellMap) {
    var canvas = document.getElementById('simChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (!cellMap) { cellMap = {}; var mm = model(); if (mm) mm.cells.forEach(function (c) { cellMap[c.cellId] = c; }); }

    var byArea = {};
    for (var i = 0; i < pts.length; i++) { var c = cellMap[pts[i].cellId]; var a = c ? c._area : '—'; byArea[a] = (byArea[a] || 0) + 1; }
    var top = Object.keys(byArea).map(function (k) { return [k, byArea[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);

    var css = getComputedStyle(document.documentElement);
    var pv = function (nm, fb) { var v = (css.getPropertyValue(nm) || '').trim(); return v || fb; };
    var accent = pv('--accent', '#43B0CC'), text2 = pv('--text-2', '#8296A9'), border = pv('--border', '#223140');

    if (simChart) { try { simChart.destroy(); } catch (e) {} simChart = null; }
    simChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels: top.map(function (t) { return t[0]; }), datasets: [{ data: top.map(function (t) { return t[1]; }), backgroundColor: accent, borderRadius: 3, maxBarThickness: 30 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return fmtInt(ctx.parsed.y) + ' projected'; } } },
        },
        scales: {
          x: { ticks: { color: text2, font: { family: 'IBM Plex Mono', size: 9 }, maxRotation: 55, minRotation: 45, autoSkip: false }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: text2, font: { family: 'IBM Plex Mono', size: 9 }, precision: 0 }, grid: { color: border } },
        },
      },
    });
  }

  /* ---- shell hook: called when the Simulate section becomes visible ---- */
  var _loggedModel = false;
  window.__crashInitSimulate = function () {
    if (!bridge()) {
      document.addEventListener('crash:ready', function () { window.__crashInitSimulate(); }, { once: true });
      return;
    }
    wireControls();
    initMap();
    requestAnimationFrame(function () { if (map) map.invalidateSize(); });
    // one-time: surface the historical model to the console for inspection (STEP 2)
    if (!_loggedModel) { _loggedModel = true; try { logModel(8); } catch (e) {} }
  };

  // namespace (model exposed for the STEP 2 console test; engine + viz land next)
  window.CRASH_SIM = {
    getScenario: getScenario,
    reset: resetScenario,
    getCellModel: getCellModel,     // → [{cellId, centerLat, centerLng, count, severityWeight, nightFrac, dayFrac, clearFrac, rainFrac, fogFrac, weekdayFrac, weekendFrac, …}]
    getCityRate: getCityRate,       // → {totalCount, monthCount, monthlyRate}
    runSimulation: runSimulation,   // (scenario) → [{lat, lng, cellId, projectedSeverity}]
    render: function (scenario) { var s = scenario || getScenario(); renderProjection(runSimulation(s), s); },
    clear: clearProjection,
    getProjectedHotspots: function (scenario, n) {   // top-N projected places for a scenario
      var s = scenario || getScenario(), mdl = model(), cellMap = {};
      if (mdl) mdl.cells.forEach(function (c) { cellMap[c.cellId] = c; });
      return projectedHotspots(runSimulation(s), cellMap, n || 10);
    },
    getPrevalence: function (scenario) {   // fraction of base accidents matching the conditions (Any/Any/Any → 1)
      var m = model();
      return m ? scenarioPrevalence(normScenario(scenario || getScenario()), m) : 0;
    },
    logModel: logModel,             // console inspector — historical model
    logSim: logSim,                 // console inspector — a projection
    _map: function () { return map; },
  };
})();
