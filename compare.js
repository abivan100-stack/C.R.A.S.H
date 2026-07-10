/* =============================================================================
   CRASH — Area comparison (Phase 4)
   Pick any two of the 29 areas and compare them head to head. Reuses the same
   data + intervention model as the map and analytics page.
   ========================================================================== */
'use strict';
(function () {

  const SEV = { fatal: { c: '#BE2F2A', l: 'Fatal', w: 3 }, serious: { c: '#CE8A2E', l: 'Serious', w: 2 }, slight: { c: '#E7C64B', l: 'Slight', w: 1 } };
  const CAUSES = ['Over-speeding', 'Wrong-side driving', 'Signal jumping', 'Drunken driving',
    'Mobile phone use', 'Hit and run', 'Pothole / bad road', 'Pedestrian crossing error',
    'Improper overtaking', 'Vehicle defect', 'Poor visibility'];
  const VEHICLES = ['Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus (MTC/Private)',
    'Lorry / Truck', 'LCV / Van', 'Bicycle', 'Unknown (fled)'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const RECENT_MONTHS = 6;

  const DIMS = [
    { key: 'volume', label: 'Volume', get: (s) => s.total },
    { key: 'fatalRate', label: 'Fatal rate', get: (s) => s.total ? s.fatal / s.total : 0 },
    { key: 'severeShare', label: 'Severe share', get: (s) => s.total ? s.severe / s.total : 0 },
    { key: 'nightShare', label: 'Night risk', get: (s) => s.total ? s.night / s.total : 0 },
    { key: 'weekendShare', label: 'Weekend', get: (s) => s.total ? s.weekend / s.total : 0 },
    { key: 'trend', label: 'Rising trend', get: (s) => s.lift },
  ];

  let DATA = [], MONTHS = 0, LASTM = 0, MIN_YM = 0;
  let STATS = {}, ORDER = [], MAXSCORE = 1, NORM = {};
  let charts = [];
  const state = { a: null, b: null, swapped: false };   // swapped = user overrode the rank ordering

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const pct0 = (x) => Math.round(x) + '%';
  const pct1 = (x) => (Math.round(x * 10) / 10) + '%';
  const mult = (x) => (Math.round(x * 10) / 10) + '×';
  const sortedEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);

  /* =========================== compute =========================== */
  function precompute() {
    let minYM = Infinity, maxYM = -Infinity;
    DATA.forEach((a) => {
      a._h = parseInt(a.datetime.slice(11, 13), 10);
      a._night = a._h < 6 || a._h >= 18;
      const d = a.datetime.slice(0, 10).split('-');
      a._dow = (new Date(+d[0], +d[1] - 1, +d[2]).getDay() + 6) % 7;
      a._ym = (+d[0]) * 12 + (+d[1] - 1);
      if (a._ym < minYM) minYM = a._ym;
      if (a._ym > maxYM) maxYM = a._ym;
    });
    MIN_YM = minYM; MONTHS = maxYM - minYM + 1; LASTM = MONTHS - 1;
    DATA.forEach((a) => { a._month = a._ym - minYM; });
  }

  function computeAll() {
    const areas = {};
    for (const a of DATA) {
      let s = areas[a.area];
      if (!s) {
        s = { area: a.area, total: 0, fatal: 0, serious: 0, slight: 0, night: 0, score: 0,
          hour: new Array(24).fill(0), dow: new Array(7).fill(0), cause: {}, vehicle: {},
          weather: { clear: 0, rain: 0, fog: 0 }, month: new Array(MONTHS).fill(0), recent: 0, baseline: 0 };
        CAUSES.forEach((c) => { s.cause[c] = 0; }); VEHICLES.forEach((v) => { s.vehicle[v] = 0; });
        areas[a.area] = s;
      }
      s.total++; s[a.severity]++; s.score += SEV[a.severity].w;
      if (a._night) s.night++;
      s.hour[a._h]++; s.dow[a._dow]++;
      s.cause[a.cause] = (s.cause[a.cause] || 0) + 1;
      s.vehicle[a.vehicle] = (s.vehicle[a.vehicle] || 0) + 1;
      s.weather[a.weather] = (s.weather[a.weather] || 0) + 1;
      s.month[a._month]++;
      if (a._month > LASTM - RECENT_MONTHS) s.recent++; else s.baseline++;
    }
    const baseMonths = Math.max(1, MONTHS - RECENT_MONTHS);
    const M = window.CRASH_INTERVENTIONS;
    Object.values(areas).forEach((s) => {
      s.severe = s.fatal + s.serious;
      s.weekend = s.dow[5] + s.dow[6];
      s.fatalRate = s.total ? s.fatal / s.total : 0;
      s.severeShare = s.total ? s.severe / s.total : 0;
      s.nightShare = s.total ? s.night / s.total : 0;
      s.weekendShare = s.total ? s.weekend / s.total : 0;
      s.recentRate = s.recent / RECENT_MONTHS;
      s.baseRate = s.baseline / baseMonths;
      s.lift = s.baseRate > 0 ? s.recentRate / s.baseRate : (s.recent >= 8 ? 2 : 1);
      s.peakHour = s.hour.indexOf(Math.max(...s.hour));
      s.peakDow = s.dow.indexOf(Math.max(...s.dow));
      s.domCause = sortedEntries(s.cause)[0][0];
      s.domVehicle = sortedEntries(s.vehicle)[0][0];
      s.iv = M ? M.pick(s.domCause, s.nightShare) : { fix: '—', cost: 'High', eff: 0.2 };
      s.preventable = M ? M.preventable(s.fatal, s.serious, s.iv.eff) : 0;
    });
    STATS = areas;
    ORDER = Object.values(areas).sort((a, b) => b.score - a.score).map((s) => s.area);
    MAXSCORE = STATS[ORDER[0]].score || 1;
    ORDER.forEach((name, i) => { STATS[name].rank = i + 1; STATS[name].normScore = Math.round(100 * STATS[name].score / MAXSCORE); });
    // normalisation ranges for the radar
    NORM = {};
    DIMS.forEach((d) => {
      let mn = Infinity, mx = -Infinity;
      ORDER.forEach((n) => { const v = d.get(STATS[n]); if (v < mn) mn = v; if (v > mx) mx = v; });
      NORM[d.key] = { min: mn, max: mx };
    });
  }
  function normDim(key, s) { const r = NORM[key]; const v = DIMS.find((d) => d.key === key).get(s); return r.max > r.min ? Math.round(100 * (v - r.min) / (r.max - r.min)) : 50; }

  /* =========================== theme + charts =========================== */
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function palette() {
    return { text: cssv('--text'), text2: cssv('--text-2'), text3: cssv('--text-3'), grid: cssv('--track'), border: cssv('--border'),
      a: cssv('--cmpA'), b: cssv('--cmpB'), accent: cssv('--accent'), panel: cssv('--panel') };
  }
  function hexToRgb(h) { h = (h || '').replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  function rgba(hex, al) { const c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + al + ')'; }

  function setChartDefaults(pal) {
    Chart.defaults.font.family = "'Roboto', sans-serif";
    Chart.defaults.font.size = 11; Chart.defaults.color = pal.text2; Chart.defaults.borderColor = pal.grid;
    const lg = Chart.defaults.plugins.legend; lg.labels.color = pal.text2; lg.labels.boxWidth = 10; lg.labels.boxHeight = 10;
    lg.labels.font = { family: "'IBM Plex Mono', monospace", size: 10 };
    const tt = Chart.defaults.plugins.tooltip; tt.backgroundColor = pal.panel; tt.titleColor = pal.text; tt.bodyColor = pal.text2;
    tt.borderColor = pal.border; tt.borderWidth = 1; tt.padding = 10; tt.boxPadding = 4;
    tt.titleFont = { family: "'Roboto', sans-serif", weight: '600', size: 12 };
    tt.bodyFont = { family: "'IBM Plex Mono', monospace", size: 11 };
  }
  function newChart(id, cfg) { const el = document.getElementById(id); if (el) charts.push(new Chart(el, cfg)); }
  function catAxis(pal, extra) { return Object.assign({ grid: { display: false }, border: { color: pal.border }, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }, extra || {}); }
  function valAxis(pal, extra) { return Object.assign({ grid: { color: pal.grid, drawTicks: false }, border: { display: false }, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }, extra || {}); }
  const baseOpts = { responsive: true, maintainAspectRatio: false, animation: { duration: 450 } };

  function buildCharts(pal, A, B) {
    // radar
    newChart('cmpRadar', {
      type: 'radar',
      data: { labels: DIMS.map((d) => d.label), datasets: [
        { label: A.area, data: DIMS.map((d) => normDim(d.key, A)), borderColor: pal.a, backgroundColor: rgba(pal.a, 0.18), pointBackgroundColor: pal.a, borderWidth: 2, pointRadius: 3 },
        { label: B.area, data: DIMS.map((d) => normDim(d.key, B)), borderColor: pal.b, backgroundColor: rgba(pal.b, 0.16), pointBackgroundColor: pal.b, borderWidth: 2, pointRadius: 3 },
      ] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: true, position: 'top' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + ' / 100' } } },
        scales: { r: { min: 0, max: 100, angleLines: { color: pal.grid }, grid: { color: pal.grid }, pointLabels: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 } }, ticks: { display: false, stepSize: 25 } } },
      }),
    });

    // severity mix (100% stacked horizontal)
    const sevPct = (s, k) => s.total ? Math.round(1000 * s[k] / s.total) / 10 : 0;
    newChart('cmpSeverity', {
      type: 'bar',
      data: { labels: [A.area, B.area], datasets: [
        { label: 'Fatal', data: [sevPct(A, 'fatal'), sevPct(B, 'fatal')], backgroundColor: SEV.fatal.c, stack: 's' },
        { label: 'Serious', data: [sevPct(A, 'serious'), sevPct(B, 'serious')], backgroundColor: SEV.serious.c, stack: 's' },
        { label: 'Slight', data: [sevPct(A, 'slight'), sevPct(B, 'slight')], backgroundColor: SEV.slight.c, stack: 's' },
      ] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + '%' } } },
        scales: { x: valAxis(pal, { stacked: true, max: 100, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, callback: (v) => v + '%' } }), y: catAxis(pal, { stacked: true, ticks: { color: pal.text, font: { family: "'Roboto', sans-serif", size: 11 } } }) },
      }),
    });

    // hourly shape (% of each area's incidents)
    const hourPct = (s) => s.hour.map((v) => s.total ? Math.round(1000 * v / s.total) / 10 : 0);
    newChart('cmpHour', {
      type: 'line',
      data: { labels: Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')), datasets: [
        { label: A.area, data: hourPct(A), borderColor: pal.a, backgroundColor: rgba(pal.a, 0.08), borderWidth: 2, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, fill: false },
        { label: B.area, data: hourPct(B), borderColor: pal.b, backgroundColor: rgba(pal.b, 0.08), borderWidth: 2, tension: 0.35, pointRadius: 0, pointHoverRadius: 4, fill: false },
      ] },
      options: Object.assign({}, baseOpts, {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { title: (i) => i[0].label + ':00', label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + '%' } } },
        scales: { x: catAxis(pal, { ticks: { color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 8.5 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }), y: valAxis(pal, { ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 9 }, callback: (v) => v + '%' } }) },
      }),
    });

    // causes grouped (% share), sorted by combined
    const causeOrder = CAUSES.slice().sort((x, y) => ((B.cause[y] / (B.total || 1) + A.cause[y] / (A.total || 1)) - (B.cause[x] / (B.total || 1) + A.cause[x] / (A.total || 1))));
    const sharePct = (s, obj, k) => s.total ? Math.round(1000 * (obj[k] || 0) / s.total) / 10 : 0;
    newChart('cmpCauses', {
      type: 'bar',
      data: { labels: causeOrder, datasets: [
        { label: A.area, data: causeOrder.map((c) => sharePct(A, A.cause, c)), backgroundColor: rgba(pal.a, 0.9), borderRadius: 3 },
        { label: B.area, data: causeOrder.map((c) => sharePct(B, B.cause, c)), backgroundColor: rgba(pal.b, 0.9), borderRadius: 3 },
      ] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + '%' } } },
        scales: { x: valAxis(pal, { ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, callback: (v) => v + '%' } }), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'Roboto', sans-serif", size: 10.5 } } }) },
      }),
    });

    // vehicles grouped (% share)
    const vehOrder = VEHICLES.slice().sort((x, y) => ((B.vehicle[y] / (B.total || 1) + A.vehicle[y] / (A.total || 1)) - (B.vehicle[x] / (B.total || 1) + A.vehicle[x] / (A.total || 1))));
    newChart('cmpVehicles', {
      type: 'bar',
      data: { labels: vehOrder, datasets: [
        { label: A.area, data: vehOrder.map((v) => sharePct(A, A.vehicle, v)), backgroundColor: rgba(pal.a, 0.9), borderRadius: 3 },
        { label: B.area, data: vehOrder.map((v) => sharePct(B, B.vehicle, v)), backgroundColor: rgba(pal.b, 0.9), borderRadius: 3 },
      ] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + '%' } } },
        scales: { x: valAxis(pal, { ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, callback: (v) => v + '%' } }), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'Roboto', sans-serif", size: 10.5 } } }) },
      }),
    });

    // monthly trend (counts)
    const labels = A.month.map((_, i) => { const ym = MIN_YM + i; return MON[ym % 12] + " '" + String(Math.floor(ym / 12)).slice(2); });
    newChart('cmpMonthly', {
      type: 'line',
      data: { labels: labels, datasets: [
        { label: A.area, data: A.month, borderColor: pal.a, backgroundColor: rgba(pal.a, 0.08), borderWidth: 2, tension: 0.32, pointRadius: 0, pointHoverRadius: 4, fill: true },
        { label: B.area, data: B.month, borderColor: pal.b, backgroundColor: rgba(pal.b, 0.08), borderWidth: 2, tension: 0.32, pointRadius: 0, pointHoverRadius: 4, fill: true },
      ] },
      options: Object.assign({}, baseOpts, {
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + fmt(i.raw) + ' incidents' } } },
        scales: { x: catAxis(pal, { ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }), y: valAxis(pal, { beginAtZero: true }) },
      }),
    });
  }

  /* =========================== DOM render =========================== */
  const costMeter = (tier) => { const lvl = tier === 'Low' ? 1 : tier === 'Medium' ? 2 : 3; let s = ''; for (let i = 1; i <= 3; i++) s += '<span class="costdot" style="background:' + (i <= lvl ? 'var(--accent)' : 'var(--track)') + '"></span>'; return s; };

  function renderHeadToHead(A, B) {
    const metrics = [
      { label: 'Incidents', a: A.total, b: B.total, fmt: fmt },
      { label: 'Fatalities', a: A.fatal, b: B.fatal, fmt: fmt },
      { label: 'Severe (F+S)', a: A.severe, b: B.severe, fmt: fmt },
      { label: 'Risk /100', a: A.normScore, b: B.normScore, fmt: (x) => x },
      { label: 'Fatality rate', a: A.fatalRate * 100, b: B.fatalRate * 100, fmt: pct1 },
      { label: 'Night share', a: A.nightShare * 100, b: B.nightShare * 100, fmt: pct0 },
      { label: 'Weekend share', a: A.weekendShare * 100, b: B.weekendShare * 100, fmt: pct0 },
      { label: 'Recent trend', a: A.lift, b: B.lift, fmt: mult },
    ];
    document.getElementById('h2h').innerHTML = metrics.map((m) => {
      const max = Math.max(m.a, m.b, 1e-9);
      const wa = (m.a / max) * 100, wb = (m.b / max) * 100;
      const aWin = m.a > m.b + 1e-9, bWin = m.b > m.a + 1e-9;
      const lo = Math.min(m.a, m.b), hi = Math.max(m.a, m.b);
      const delta = lo > 0 ? mult(hi / lo) : (hi > 0 ? '—' : '=');
      const dColor = aWin ? 'var(--cmpA)' : bWin ? 'var(--cmpB)' : 'var(--text-3)';
      const wStr = (v, w) => v > 0 ? 'max(3px, ' + w.toFixed(1) + '%)' : '0';
      return '<div class="h2h-row">' +
          '<div class="h2h-track a"><span class="h2h-bar ' + (bWin ? 'dim' : '') + '" style="width:' + wStr(m.a, wa) + '; background:var(--cmpA)"></span></div>' +
          '<div class="h2h-val a ' + (bWin ? 'dim' : '') + '" style="color:var(--cmpA)">' + m.fmt(m.a) + '</div>' +
          '<div class="h2h-mid"><div class="h2h-metric">' + m.label + '</div><div class="h2h-delta" style="color:' + dColor + '">' + (aWin || bWin ? delta : '=') + '</div></div>' +
          '<div class="h2h-val b ' + (aWin ? 'dim' : '') + '" style="color:var(--cmpB)">' + m.fmt(m.b) + '</div>' +
          '<div class="h2h-track b"><span class="h2h-bar ' + (aWin ? 'dim' : '') + '" style="width:' + wStr(m.b, wb) + '; background:var(--cmpB)"></span></div>' +
        '</div>';
    }).join('');
  }

  function renderFacts(A, B) {
    const hourLbl = (h) => String(h).padStart(2, '0') + ':00';
    const rows = [
      ['#' + A.rank + ' of ' + ORDER.length, 'City rank', '#' + B.rank + ' of ' + ORDER.length],
      [A.domCause, 'Top cause', B.domCause],
      [A.domVehicle, 'Top vehicle', B.domVehicle],
      [hourLbl(A.peakHour), 'Peak hour', hourLbl(B.peakHour)],
      [DOW[A.peakDow], 'Peak day', DOW[B.peakDow]],
      [pct0(A.nightShare * 100), 'Night share', pct0(B.nightShare * 100)],
    ];
    document.getElementById('facts').innerHTML = rows.map((r, i) =>
      (i ? '<div class="row-sep"></div>' : '') +
      '<div class="fa" style="color:var(--cmpA)">' + r[0] + '</div>' +
      '<div class="fm">' + r[1] + '</div>' +
      '<div class="fb" style="color:var(--cmpB)">' + r[2] + '</div>'
    ).join('');
  }

  function renderVerdict(A, B) {
    const head = document.getElementById('verdictHead');
    const meta = document.getElementById('verdictMeta');
    const hi = A.normScore >= B.normScore ? A : B, lo = A.normScore >= B.normScore ? B : A;
    const hiC = hi === A ? 'var(--cmpA)' : 'var(--cmpB)', loC = lo === A ? 'var(--cmpA)' : 'var(--cmpB)';
    const ratio = lo.normScore > 0 ? hi.normScore / lo.normScore : 1;
    const name = (s, c) => '<b style="color:' + c + '">' + s.area + '</b>';
    if (ratio < 1.1) {
      head.innerHTML = name(A, 'var(--cmpA)') + ' and ' + name(B, 'var(--cmpB)') + ' carry <b>comparable</b> overall risk (index ' + A.normScore + ' vs ' + B.normScore + ').';
    } else {
      head.innerHTML = name(hi, hiC) + ' is <b>' + mult(ratio) + ' more dangerous</b> than ' + name(lo, loC) + ' by risk index (' + hi.normScore + ' vs ' + lo.normScore + ').';
    }
    const clauses = [];
    clauses.push(A.area + ' records ' + fmt(A.fatal) + ' fatalities to ' + B.area + '’s ' + fmt(B.fatal));
    const rising = [A, B].filter((s) => s.lift >= 1.2).sort((x, y) => y.lift - x.lift)[0];
    if (rising) clauses.push(rising.area + '’s incident rate is climbing (+' + Math.round((rising.lift - 1) * 100) + '% recent vs baseline)');
    else clauses.push('neither area is surging against its baseline');
    meta.textContent = clauses.join(' · ') + '.';
  }

  function renderInterventions(A, B) {
    const card = (s, cls) =>
      '<div class="ivcard ' + cls + '">' +
        '<div class="an">' + s.area + '</div>' +
        '<div class="cause">Dominant cause · ' + s.domCause + '</div>' +
        '<div class="fix">' + s.iv.fix + '.</div>' +
        '<div class="row"><span class="prevent">≈ ' + fmt(s.preventable) + ' <small>severe preventable · 24 mo</small></span></div>' +
        '<div class="row" style="justify-content:space-between;">' +
          '<span style="display:flex; align-items:center; gap:6px;"><span class="tag2">Cost</span>' + costMeter(s.iv.cost) + '<span class="tag2" style="color:var(--text);">' + s.iv.cost + '</span></span>' +
          '<span class="tag2" style="color:var(--text-3);">' + fmt(s.fatal) + ' fatal · ' + fmt(s.serious) + ' serious</span>' +
        '</div>' +
      '</div>';
    document.getElementById('ivGrid').innerHTML = card(A, 'a') + card(B, 'b');
    document.getElementById('ivFoot').innerHTML = 'Impact figures are indicative planning estimates from the shared intervention model, not measured outcomes.';
  }

  /* =========================== combobox =========================== */
  function makeCombo(rootId, side) {
    const root = document.getElementById(rootId);
    const input = root.querySelector('.combo-input');
    const list = root.querySelector('.combo-list');
    let active = -1, opts = [];

    function draw(filter) {
      const q = (filter || '').trim().toLowerCase();
      opts = ORDER.filter((n) => n.toLowerCase().includes(q));
      if (!opts.length) { list.innerHTML = '<div class="combo-empty">No area matches “' + filter + '”.</div>'; return; }
      const cur = state[side];
      list.innerHTML = opts.map((n, i) =>
        '<div class="combo-opt' + (n === cur ? ' chosen' : '') + (i === active ? ' active' : '') + '" data-i="' + i + '">' +
          '<span>' + n + '</span><span class="cnt">' + fmt(STATS[n].total) + ' · #' + STATS[n].rank + '</span>' +
        '</div>'
      ).join('');
      list.querySelectorAll('.combo-opt').forEach((el) => {
        el.addEventListener('mousedown', (e) => { e.preventDefault(); choose(opts[+el.dataset.i]); });
      });
    }
    function open() { active = Math.max(0, opts.indexOf ? opts.indexOf(state[side]) : -1); draw(''); list.classList.add('open'); }
    function close() { list.classList.remove('open'); }
    function choose(name) { close(); input.blur(); pickArea(side, name); }

    input.addEventListener('focus', () => { input.select(); open(); });
    input.addEventListener('input', () => { active = 0; draw(input.value); list.classList.add('open'); });
    input.addEventListener('blur', () => { setTimeout(() => { close(); input.value = state[side] || ''; }, 120); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(opts.length - 1, active + 1); draw(input.value); scrollActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); draw(input.value); scrollActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (opts[active]) choose(opts[active]); }
      else if (e.key === 'Escape') { close(); input.value = state[side] || ''; input.blur(); }
    });
    function scrollActive() { const el = list.querySelector('.combo-opt.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }

    return { setDisplay: (name) => { input.value = name; } };
  }
  let comboA, comboB;

  /* =========================== orchestrate =========================== */
  function pickArea(side, name) {
    if (!STATS[name]) return;
    const other = side === 'a' ? 'b' : 'a';
    if (name === state[other]) state[other] = state[side];   // keep the two distinct by swapping
    state[side] = name;
    state.swapped = false;                                    // fresh pick re-applies rank ordering
    render();
  }
  function swap() { const t = state.a; state.a = state.b; state.b = t; state.swapped = true; render(); }

  function render() {
    // present the higher-risk (lower rank number) area as A, unless the user
    // explicitly swapped — so the comparison always reads worst-first by default.
    if (!state.swapped && STATS[state.a].rank > STATS[state.b].rank) { const t = state.a; state.a = state.b; state.b = t; }
    const A = STATS[state.a], B = STATS[state.b];
    comboA.setDisplay(A.area); comboB.setDisplay(B.area);
    document.getElementById('nameA').textContent = A.area;
    document.getElementById('nameB').textContent = B.area;
    document.getElementById('metaA').textContent = fmt(A.total) + ' incidents · rank #' + A.rank;
    document.getElementById('metaB').textContent = fmt(B.total) + ' incidents · rank #' + B.rank;
    document.getElementById('legA').textContent = A.area;
    document.getElementById('legB').textContent = B.area;

    renderVerdict(A, B);
    renderHeadToHead(A, B);
    renderFacts(A, B);
    renderInterventions(A, B);

    charts.forEach((c) => { try { c.destroy(); } catch (e) {} });
    charts = [];
    const pal = palette();
    setChartDefaults(pal);
    buildCharts(pal, A, B);

    try { const u = new URL(window.location.href); u.searchParams.set('a', A.area); u.searchParams.set('b', B.area); window.history.replaceState(null, '', u); } catch (e) {}
  }

  function renderThemeToggle() {
    const btn = document.getElementById('themeToggle'); if (!btn) return;
    const light = currentTheme() === 'light';
    btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
    btn.innerHTML = light
      ? '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/><line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/><line x1="3.9" y1="3.9" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="16.1" y2="16.1"/><line x1="16.1" y1="3.9" x2="14.4" y2="5.6"/></g></svg>'
      : '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }
  function toggleTheme() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cra-theme', next); } catch (e) {}
    renderThemeToggle(); render();
  }

  async function boot() {
    renderThemeToggle();
    const tt = document.getElementById('themeToggle'); if (tt) tt.addEventListener('click', toggleTheme);
    const sw = document.getElementById('swapBtn'); if (sw) sw.addEventListener('click', swap);

    let data;
    try { const res = await fetch('./data/accidents.json?v=9'); if (!res.ok) throw new Error('HTTP ' + res.status); data = await res.json(); }
    catch (err) { console.error(err); const m = document.querySelector('main'); if (m) m.insertAdjacentHTML('afterbegin', '<div style="padding:16px;border:1px solid var(--border);border-radius:8px;color:var(--text-2);">Could not load ./data/accidents.json — run via the local server.</div>'); return; }

    DATA = data; precompute(); computeAll();

    // initial selection: URL params, else top-2 by risk
    const params = new URLSearchParams(window.location.search);
    const qa = params.get('a'), qb = params.get('b');
    state.a = STATS[qa] ? qa : ORDER[0];
    state.b = (STATS[qb] && qb !== state.a) ? qb : (ORDER[1] === state.a ? ORDER[2] : ORDER[1]);

    comboA = makeCombo('comboA', 'a');
    comboB = makeCombo('comboB', 'b');
    render();

    let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => charts.forEach((c) => c.resize()), 150); });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
