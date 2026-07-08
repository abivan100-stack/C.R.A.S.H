/* =============================================================================
   CRASH — Analytics & insights page
   Loads the same accidents.json as the dashboard, recomputes every aggregate
   with the SAME engine constants (cells, emerging, interventions), and renders
   a full set of Chart.js charts themed to match the design.
   ========================================================================== */
'use strict';
(function () {

  /* ---- engine constants (mirror app.js) ---- */
  const SEV = {
    fatal:   { c: '#E4404E', l: 'Fatal',   w: 3 },
    serious: { c: '#F2933E', l: 'Serious', w: 2 },
    slight:  { c: '#E7C64B', l: 'Slight',  w: 1 },
  };
  const CAUSES = ['Over-speeding', 'Wrong-side driving', 'Signal jumping', 'Drunken driving',
    'Mobile phone use', 'Hit and run', 'Pothole / bad road', 'Pedestrian crossing error',
    'Improper overtaking', 'Vehicle defect', 'Poor visibility'];
  const VEHICLES = ['Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus (MTC/Private)',
    'Lorry / Truck', 'LCV / Van', 'Bicycle', 'Unknown (fled)'];
  const BBOX = { latMin: 12.83, lngMin: 80.03 };
  const CELL = 0.0022, SUPPRESS = 2, TOP_N = 10, HIGH_RISK_MIN = 40;
  const RECENT_MONTHS = 6, EMERGE_LIFT = 1.5, EMERGE_MIN_RECENT = 8, EMERGE_TOP_N = 6;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  let DATA = [], AGG = null, charts = [];
  let MONTHS = 0, LASTM = 0, MIN_YM = 0;

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const sortedEntries = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  function ymLabel(monthIndex) { const ym = MIN_YM + monthIndex; return MON[ym % 12] + " '" + String(Math.floor(ym / 12)).slice(2); }

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

  function gridCells() {
    const map = new Map();
    for (const a of DATA) {
      const ci = Math.floor((a.lat - BBOX.latMin) / CELL);
      const cj = Math.floor((a.lng - BBOX.lngMin) / CELL);
      const k = ci + '_' + cj;
      let c = map.get(k);
      if (!c) {
        c = { ci, cj, count: 0, score: 0, fatal: 0, serious: 0, slight: 0, night: 0,
              areas: {}, cause: {}, recent: 0, baseline: 0, recentScore: 0,
              months: new Array(MONTHS).fill(0), sumLat: 0, sumLng: 0 };
        map.set(k, c);
      }
      c.count++; c.score += SEV[a.severity].w; c[a.severity]++;
      if (a._night) c.night++;
      c.areas[a.area] = (c.areas[a.area] || 0) + 1;
      c.cause[a.cause] = (c.cause[a.cause] || 0) + 1;
      c.months[a._month]++;
      if (a._month > LASTM - RECENT_MONTHS) { c.recent++; c.recentScore += SEV[a.severity].w; } else c.baseline++;
      c.sumLat += a.lat; c.sumLng += a.lng;
    }
    const arr = [...map.values()];
    arr.forEach((c) => { c.area = sortedEntries(c.areas)[0][0]; c.lat = c.sumLat / c.count; c.lng = c.sumLng / c.count; });
    return arr;
  }

  function computeEmerging(cells) {
    const baseMonths = Math.max(1, MONTHS - RECENT_MONTHS);
    const cand = [];
    for (const c of cells) {
      if (c.recent < EMERGE_MIN_RECENT) continue;
      const rr = c.recent / RECENT_MONTHS, br = c.baseline / baseMonths;
      const lift = br > 0 ? rr / br : 3;
      if (lift < EMERGE_LIFT) continue;
      cand.push({ area: c.area, ci: c.ci, cj: c.cj, recent: c.recent, baseline: c.baseline,
        recentRate: rr, baseRate: br, lift: lift, pct: Math.round((lift - 1) * 100),
        priority: c.recentScore * (lift - 1) });
    }
    cand.sort((a, b) => b.priority - a.priority);
    const pick = [];
    for (const c of cand) {
      if (pick.length >= EMERGE_TOP_N) break;
      if (pick.some((p) => Math.abs(p.ci - c.ci) <= SUPPRESS && Math.abs(p.cj - c.cj) <= SUPPRESS)) continue;
      pick.push(c);
    }
    return pick;
  }

  function computeAgg() {
    const sev = { fatal: 0, serious: 0, slight: 0 };
    const cause = {}, veh = {}, weather = { clear: 0, rain: 0, fog: 0 };
    const hour = new Array(24).fill(0), dow = new Array(7).fill(0);
    const monthTotal = new Array(MONTHS).fill(0);
    const monthSev = { fatal: new Array(MONTHS).fill(0), serious: new Array(MONTHS).fill(0), slight: new Array(MONTHS).fill(0) };
    const heat = Array.from({ length: 7 }, () => new Array(24).fill(0));
    const wsev = { clear: { fatal: 0, serious: 0, slight: 0 }, rain: { fatal: 0, serious: 0, slight: 0 }, fog: { fatal: 0, serious: 0, slight: 0 } };
    CAUSES.forEach((c) => { cause[c] = 0; });
    VEHICLES.forEach((v) => { veh[v] = 0; });

    for (const a of DATA) {
      sev[a.severity]++;
      cause[a.cause] = (cause[a.cause] || 0) + 1;
      veh[a.vehicle] = (veh[a.vehicle] || 0) + 1;
      weather[a.weather] = (weather[a.weather] || 0) + 1;
      hour[a._h]++; dow[a._dow]++;
      monthTotal[a._month]++; monthSev[a.severity][a._month]++;
      heat[a._dow][a._h]++;
      wsev[a.weather][a.severity]++;
    }

    const cells = gridCells();
    const byScore = cells.slice().sort((a, b) => b.score - a.score || b.count - a.count);
    const top = [];
    for (const c of byScore) {
      if (top.length >= TOP_N) break;
      if (top.some((p) => Math.abs(p.ci - c.ci) <= SUPPRESS && Math.abs(p.cj - c.cj) <= SUPPRESS)) continue;
      top.push(c);
    }
    const topRaw = top.length ? top[0].score : 1;
    top.forEach((c) => { c.norm = Math.max(1, Math.round(100 * Math.pow(c.score / topRaw, 0.6))); });

    const sevCity = sev.fatal + sev.serious;
    let sevTop = 0; top.forEach((c) => { sevTop += c.fatal + c.serious; });

    const bySevere = cells.map((c) => ({ area: c.area, severe: c.fatal + c.serious }))
      .filter((c) => c.severe > 0).sort((a, b) => b.severe - a.severe);

    const highRisk = cells.filter((c) => c.score >= HIGH_RISK_MIN).length;
    const emerging = computeEmerging(cells);

    const M = window.CRASH_INTERVENTIONS;
    const queue = top.map((c) => {
      const dom = sortedEntries(c.cause)[0][0];
      const iv = M ? M.pick(dom, c.night / c.count) : { fix: '—', cost: 'High', eff: 0.2 };
      const prevent = M ? M.preventable(c.fatal, c.serious, iv.eff) : 0;
      return { area: c.area, dom, iv, prevent, fatal: c.fatal, serious: c.serious, norm: c.norm };
    }).sort((a, b) => b.prevent - a.prevent);

    return { sev, cause, veh, weather, hour, dow, monthTotal, monthSev, heat, wsev,
      cells, top, sevCity, sevTop, leveragePct: sevCity ? Math.round(100 * sevTop / sevCity) : 0,
      bySevere, highRisk, emerging, queue };
  }

  /* =========================== theme + palette =========================== */
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function palette() {
    return { text: cssv('--text'), text2: cssv('--text-2'), text3: cssv('--text-3'),
      grid: cssv('--track'), border: cssv('--border'), accent: cssv('--accent'), accent2: cssv('--accent-2'),
      day: cssv('--chart-day'), night: cssv('--chart-night'), panel: cssv('--panel'), bg: cssv('--bg') };
  }
  function hexToRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  function rgba(hex, a) { const c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }

  function renderThemeToggle() {
    if (window.CRASH_SHELL) return;   // the shell owns the single header theme toggle
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const light = currentTheme() === 'light';
    btn.title = light ? 'Switch to dark theme' : 'Switch to light theme';
    btn.innerHTML = light
      ? '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><line x1="10" y1="1.5" x2="10" y2="4"/><line x1="10" y1="16" x2="10" y2="18.5"/><line x1="1.5" y1="10" x2="4" y2="10"/><line x1="16" y1="10" x2="18.5" y2="10"/><line x1="3.9" y1="3.9" x2="5.6" y2="5.6"/><line x1="14.4" y1="14.4" x2="16.1" y2="16.1"/><line x1="16.1" y1="3.9" x2="14.4" y2="5.6"/><line x1="5.6" y1="14.4" x2="3.9" y2="16.1"/></g></svg>'
      : '<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true"><path d="M16 11.5A6.5 6.5 0 0 1 8.5 4a6.5 6.5 0 1 0 7.5 7.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }
  function toggleTheme() {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('cra-theme', next); } catch (e) {}
    renderThemeToggle();
    buildAll();     // rebuild every chart + DOM piece with the new palette
  }

  /* =========================== chart helpers =========================== */
  function newChart(id, cfg) {
    const el = document.getElementById(id);
    if (!el) return;
    charts.push(new Chart(el, cfg));
  }
  function setChartDefaults(pal) {
    Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.color = pal.text2;
    Chart.defaults.borderColor = pal.grid;
    const lg = Chart.defaults.plugins.legend;
    lg.labels.color = pal.text2; lg.labels.boxWidth = 10; lg.labels.boxHeight = 10;
    lg.labels.font = { family: "'IBM Plex Mono', monospace", size: 10 };
    const tt = Chart.defaults.plugins.tooltip;
    tt.backgroundColor = pal.panel; tt.titleColor = pal.text; tt.bodyColor = pal.text2;
    tt.borderColor = pal.border; tt.borderWidth = 1; tt.padding = 10; tt.displayColors = true; tt.boxPadding = 4;
    tt.titleFont = { family: "'IBM Plex Sans', sans-serif", weight: '600', size: 12 };
    tt.bodyFont = { family: "'IBM Plex Mono', monospace", size: 11 };
  }
  function catAxis(pal, extra) {
    return Object.assign({ grid: { display: false }, border: { color: pal.border },
      ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }, extra || {});
  }
  function valAxis(pal, extra) {
    return Object.assign({ grid: { color: pal.grid, drawTicks: false }, border: { display: false },
      ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, precision: 0 } }, extra || {});
  }
  const baseOpts = { responsive: true, maintainAspectRatio: false, animation: { duration: 500 } };

  /* =========================== builders =========================== */
  function buildKPIs(A) {
    const total = DATA.length;
    document.getElementById('kpiTotal').textContent = fmt(total);
    document.getElementById('kpiFatal').textContent = fmt(A.sev.fatal);
    document.getElementById('kpiSevere').textContent = fmt(A.sev.fatal + A.sev.serious);
    document.getElementById('kpiZones').textContent = fmt(A.highRisk);
    document.getElementById('kpiEmerging').textContent = fmt(A.emerging.length);
    document.getElementById('kpiAvg').textContent = fmt(Math.round(total / MONTHS));
  }

  function buildLeverage(A) {
    document.getElementById('levPct').textContent = A.leveragePct + '%';
    document.getElementById('levN').textContent = A.top.length;
    document.getElementById('levMeta').textContent = fmt(A.sevTop) + ' of ' + fmt(A.sevCity) + ' severe incidents · 250 m cells · all data';
  }

  function buildPareto(pal, A) {
    const N = Math.min(28, A.bySevere.length);
    const bars = A.bySevere.slice(0, N);
    let cum = 0; const cumline = bars.map((c) => { cum += c.severe; return Math.round(1000 * cum / A.sevCity) / 10; });
    const barColors = bars.map((_, i) => i < TOP_N ? pal.accent : rgba(pal.day, 0.55));
    newChart('chartPareto', {
      data: {
        labels: bars.map((_, i) => i + 1),
        datasets: [
          { type: 'bar', label: 'Severe incidents', data: bars.map((c) => c.severe), backgroundColor: barColors, borderRadius: 2, order: 2, yAxisID: 'y' },
          { type: 'line', label: 'Cumulative %', data: cumline, borderColor: pal.text, backgroundColor: pal.text, borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 4, tension: 0.3, order: 1, yAxisID: 'y1' },
        ],
      },
      options: Object.assign({}, baseOpts, {
        plugins: {
          legend: { display: true, position: 'top', align: 'end' },
          tooltip: { callbacks: {
            title: (items) => 'Junction #' + items[0].label + (bars[items[0].dataIndex] ? ' · ' + bars[items[0].dataIndex].area : ''),
            label: (i) => i.dataset.type === 'line' ? '  Cumulative ' + i.raw + '% of severe' : '  ' + fmt(i.raw) + ' severe incidents',
          } },
        },
        scales: {
          x: catAxis(pal, { title: { display: true, text: 'Junction cells, worst first (top 10 in accent)', color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }),
          y: valAxis(pal, { title: { display: true, text: 'Severe incidents', color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }),
          y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, border: { display: false }, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, callback: (v) => v + '%' } },
        },
      }),
    });
  }

  function buildSeverity(pal, A) {
    newChart('chartSeverity', {
      type: 'doughnut',
      data: { labels: ['Fatal', 'Serious', 'Slight'],
        datasets: [{ data: [A.sev.fatal, A.sev.serious, A.sev.slight], backgroundColor: [SEV.fatal.c, SEV.serious.c, SEV.slight.c], borderColor: pal.panel, borderWidth: 2, hoverOffset: 6 }] },
      options: Object.assign({}, baseOpts, {
        cutout: '58%',
        plugins: { legend: { display: true, position: 'right' },
          tooltip: { callbacks: { label: (i) => '  ' + i.label + ' · ' + fmt(i.raw) + ' · ' + Math.round(100 * i.raw / DATA.length) + '%' } } },
      }),
    });

    const labels = A.monthTotal.map((_, i) => ymLabel(i));
    newChart('chartMonthlySeverity', {
      type: 'bar',
      data: { labels: labels, datasets: [
        { label: 'Slight', data: A.monthSev.slight, backgroundColor: SEV.slight.c, stack: 's' },
        { label: 'Serious', data: A.monthSev.serious, backgroundColor: SEV.serious.c, stack: 's' },
        { label: 'Fatal', data: A.monthSev.fatal, backgroundColor: SEV.fatal.c, stack: 's' },
      ] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: true, position: 'top', align: 'end' } },
        scales: { x: catAxis(pal, { stacked: true, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }),
          y: valAxis(pal, { stacked: true }) },
      }),
    });
  }

  function buildCausesVehicles(pal, A) {
    const cz = sortedEntries(A.cause);
    newChart('chartCauses', {
      type: 'bar',
      data: { labels: cz.map((e) => e[0]), datasets: [{ data: cz.map((e) => e[1]), backgroundColor: rgba(pal.accent, 0.85), borderRadius: 3 }] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => '  ' + fmt(i.raw) + ' · ' + Math.round(100 * i.raw / DATA.length) + '%' } } },
        scales: { x: valAxis(pal), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } } }) },
      }),
    });
    const vz = sortedEntries(A.veh);
    newChart('chartVehicles', {
      type: 'bar',
      data: { labels: vz.map((e) => e[0]), datasets: [{ data: vz.map((e) => e[1]), backgroundColor: rgba(pal.day, 0.9), borderRadius: 3 }] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => '  ' + fmt(i.raw) + ' · ' + Math.round(100 * i.raw / DATA.length) + '%' } } },
        scales: { x: valAxis(pal), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } } }) },
      }),
    });
  }

  function buildTime(pal, A) {
    const peak = A.hour.indexOf(Math.max(...A.hour));
    newChart('chartHour', {
      type: 'bar',
      data: { labels: A.hour.map((_, h) => String(h).padStart(2, '0')),
        datasets: [{ data: A.hour, backgroundColor: A.hour.map((_, h) => h === peak ? pal.accent : rgba(pal.day, 0.7)), borderRadius: 2 }] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => i[0].label + ':00–' + String((+i[0].label + 1) % 24).padStart(2, '0') + ':00', label: (i) => '  ' + fmt(i.raw) + ' incidents' } } },
        scales: { x: catAxis(pal, { ticks: { color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 8.5 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } }), y: valAxis(pal) },
      }),
    });
    newChart('chartDow', {
      type: 'bar',
      data: { labels: DOW, datasets: [{ data: A.dow, backgroundColor: rgba(pal.accent, 0.8), borderRadius: 3 }] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => '  ' + fmt(i.raw) + ' incidents' } } },
        scales: { x: catAxis(pal), y: valAxis(pal) },
      }),
    });

    // city-wide monthly trend, recent window in accent
    const labels = A.monthTotal.map((_, i) => ymLabel(i));
    const cut = MONTHS - RECENT_MONTHS;
    newChart('chartMonthlyTrend', {
      type: 'line',
      data: { labels: labels, datasets: [{ data: A.monthTotal, borderWidth: 2, tension: 0.32,
        pointRadius: A.monthTotal.map((_, i) => i >= cut ? 3 : 0), pointHoverRadius: 5,
        pointBackgroundColor: A.monthTotal.map((_, i) => i >= cut ? pal.accent : pal.day),
        borderColor: pal.day, fill: true, backgroundColor: rgba(pal.accent, 0.08),
        segment: { borderColor: (ctx) => ctx.p1DataIndex >= cut ? pal.accent : pal.day } }] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (i) => '  ' + fmt(i.raw) + ' incidents' + (i.dataIndex >= cut ? ' · recent window' : '') } } },
        scales: { x: catAxis(pal, { ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }), y: valAxis(pal, { beginAtZero: true }) },
      }),
    });

    buildHeatmap(pal, A);
  }

  function buildHeatmap(pal, A) {
    const wrap = document.getElementById('heatmap');
    if (!wrap) return;
    let max = 1;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) max = Math.max(max, A.heat[d][h]);
    let html = '<div class="heat-grid">';
    html += '<div></div>';
    for (let h = 0; h < 24; h++) html += '<div class="heat-collabel">' + (h % 3 === 0 ? String(h).padStart(2, '0') : '') + '</div>';
    for (let d = 0; d < 7; d++) {
      html += '<div class="heat-rowlabel">' + DOW[d] + '</div>';
      for (let h = 0; h < 24; h++) {
        const v = A.heat[d][h];
        const a = v === 0 ? 0.04 : 0.10 + 0.85 * (v / max);
        html += '<div class="heat-cell" title="' + DOW[d] + ' ' + String(h).padStart(2, '0') + ':00 · ' + v + ' incidents" style="background:' + rgba(pal.accent, a) + ';"></div>';
      }
    }
    html += '</div>';
    wrap.innerHTML = html;
    [0.10, 0.35, 0.6, 0.9].forEach((a, i) => { const s = document.getElementById('hsw' + i); if (s) s.style.background = rgba(pal.accent, a); });
  }

  function buildWeather(pal, A) {
    newChart('chartWeather', {
      type: 'doughnut',
      data: { labels: ['Clear', 'Rain', 'Fog'],
        datasets: [{ data: [A.weather.clear, A.weather.rain, A.weather.fog], backgroundColor: [rgba(pal.day, 0.9), pal.accent, pal.night], borderColor: pal.panel, borderWidth: 2, hoverOffset: 6 }] },
      options: Object.assign({}, baseOpts, { cutout: '58%',
        plugins: { legend: { display: true, position: 'right' },
          tooltip: { callbacks: { label: (i) => '  ' + i.label + ' · ' + fmt(i.raw) + ' · ' + Math.round(100 * i.raw / DATA.length) + '%' } } } }),
    });

    const keys = ['clear', 'rain', 'fog'];
    const pctOf = (k, s) => { const t = A.weather[k] || 1; return Math.round(1000 * A.wsev[k][s] / t) / 10; };
    newChart('chartWeatherSeverity', {
      type: 'bar',
      data: { labels: ['Clear', 'Rain', 'Fog'], datasets: [
        { label: 'Fatal', data: keys.map((k) => pctOf(k, 'fatal')), backgroundColor: SEV.fatal.c, stack: 'w' },
        { label: 'Serious', data: keys.map((k) => pctOf(k, 'serious')), backgroundColor: SEV.serious.c, stack: 'w' },
        { label: 'Slight', data: keys.map((k) => pctOf(k, 'slight')), backgroundColor: SEV.slight.c, stack: 'w' },
      ] },
      options: Object.assign({}, baseOpts, {
        plugins: { legend: { display: true, position: 'top', align: 'end' }, tooltip: { callbacks: { label: (i) => '  ' + i.dataset.label + ' · ' + i.raw + '%' } } },
        scales: { x: catAxis(pal, { stacked: true }), y: valAxis(pal, { stacked: true, max: 100, ticks: { color: pal.text2, font: { family: "'IBM Plex Mono', monospace", size: 10 }, callback: (v) => v + '%' } }) },
      }),
    });
  }

  function buildTopJunctions(pal, A) {
    newChart('chartTopJunctions', {
      type: 'bar',
      data: { labels: A.top.map((c) => c.area), datasets: [{ data: A.top.map((c) => c.norm), backgroundColor: A.top.map((_, i) => rgba(pal.accent, 0.95 - i * 0.055)), borderRadius: 3 }] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => i[0].label, label: (i) => { const c = A.top[i.dataIndex]; return ['  risk score ' + c.norm + ' / 100', '  ' + fmt(c.count) + ' incidents', '  ' + fmt(c.fatal) + ' fatal · ' + fmt(c.serious) + ' serious']; } } } },
        scales: { x: valAxis(pal, { max: 100 }), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } } }) },
      }),
    });
  }

  function buildEmerging(pal, A) {
    const e = A.emerging;
    newChart('chartEmerging', {
      type: 'bar',
      data: { labels: e.map((x) => x.area + '  +' + x.pct + '%'), datasets: [
        { label: 'Prior 18 mo · /month', data: e.map((x) => Math.round(x.baseRate * 10) / 10), backgroundColor: rgba(pal.day, 0.75), borderRadius: 3 },
        { label: 'Recent 6 mo · /month', data: e.map((x) => Math.round(x.recentRate * 10) / 10), backgroundColor: pal.accent, borderRadius: 3 },
      ] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: true, position: 'top', align: 'end' },
          tooltip: { callbacks: { title: (i) => e[i[0].dataIndex].area, label: (i) => '  ' + i.dataset.label.split(' · ')[0] + ' · ' + i.raw + ' /mo' } } },
        scales: { x: valAxis(pal, { title: { display: true, text: 'incidents per month', color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } } }) },
      }),
    });
  }

  function buildInterventions(pal, A) {
    const COSTCOLOR = { Low: pal.accent, Medium: rgba(pal.day, 0.95), High: pal.night };
    newChart('chartPreventable', {
      type: 'bar',
      data: { labels: A.queue.map((r) => r.area), datasets: [{ data: A.queue.map((r) => r.prevent), backgroundColor: A.queue.map((r) => COSTCOLOR[r.iv.cost] || pal.day), borderRadius: 3 }] },
      options: Object.assign({}, baseOpts, {
        indexAxis: 'y',
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: (i) => A.queue[i.dataIndex].area, label: (i) => { const r = A.queue[i.dataIndex]; return ['  ≈ ' + fmt(r.prevent) + ' severe preventable', '  cause · ' + r.dom, '  cost · ' + r.iv.cost]; } } } },
        scales: { x: valAxis(pal, { title: { display: true, text: 'est. preventable severe crashes · 24 mo', color: pal.text3, font: { family: "'IBM Plex Mono', monospace", size: 10 } } }), y: catAxis(pal, { ticks: { color: pal.text, font: { family: "'IBM Plex Sans', sans-serif", size: 11 } } }) },
      }),
    });

    // priority cards
    const dot = (on) => '<span class="costdot" style="background:' + (on ? 'var(--accent)' : 'var(--track)') + '"></span>';
    const meter = (tier) => { const lvl = tier === 'Low' ? 1 : tier === 'Medium' ? 2 : 3; return dot(lvl >= 1) + dot(lvl >= 2) + dot(lvl >= 3); };
    const cards = document.getElementById('priorityCards');
    if (cards) {
      cards.innerHTML = A.queue.map((r, i) =>
        '<div class="pqcard">' +
          '<div class="rank">PRIORITY ' + String(i + 1).padStart(2, '0') + '</div>' +
          '<div class="area">' + r.area + '</div>' +
          '<div class="fix">' + r.dom + ' → ' + r.iv.fix + '.</div>' +
          '<div class="row">' +
            '<span class="prevent">≈ ' + fmt(r.prevent) + ' <small>severe preventable</small></span>' +
          '</div>' +
          '<div class="row" style="justify-content:space-between;">' +
            '<span style="display:flex; align-items:center; gap:6px;"><span class="tag">Cost</span>' + meter(r.iv.cost) + '<span class="tag" style="color:var(--text);">' + r.iv.cost + '</span></span>' +
            '<span class="tag" style="color:var(--text-3);">' + fmt(r.fatal) + ' fatal · ' + fmt(r.serious) + ' serious</span>' +
          '</div>' +
        '</div>'
      ).join('');
    }
    const totalPrevent = A.queue.reduce((s, r) => s + r.prevent, 0);
    const foot = document.getElementById('ivFootnote');
    if (foot) foot.innerHTML = 'Addressing all ' + A.queue.length + ' priority junctions could prevent an estimated <b style="color:var(--accent);">' + fmt(totalPrevent) + '</b> severe crashes over 24 months. ' +
      'Cost tiers: <span style="color:var(--accent);">■</span> Low · <span style="color:' + pal.day + ';">■</span> Medium · <span style="color:' + pal.night + ';">■</span> High. Impact figures are planning estimates, not measured outcomes.';
  }

  /* =========================== orchestrate =========================== */
  function buildAll() {
    charts.forEach((c) => { try { c.destroy(); } catch (e) {} });
    charts = [];
    const pal = palette();
    setChartDefaults(pal);
    buildKPIs(AGG);
    buildLeverage(AGG);
    buildPareto(pal, AGG);
    buildSeverity(pal, AGG);
    buildCausesVehicles(pal, AGG);
    buildTime(pal, AGG);
    buildWeather(pal, AGG);
    buildTopJunctions(pal, AGG);
    buildEmerging(pal, AGG);
    buildInterventions(pal, AGG);
  }

  async function boot() {
    renderThemeToggle();
    const tt = document.getElementById('themeToggle');
    if (tt && !window.CRASH_SHELL) tt.addEventListener('click', toggleTheme);
    const rb = document.getElementById('reportBtn');
    if (rb) rb.addEventListener('click', () => { if (window.CRASHReport && DATA.length) window.CRASHReport.city(DATA); });

    let data;
    try {
      const res = await fetch('./data/accidents.json?v=7');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (err) {
      console.error('Failed to load accidents.json:', err);
      const main = document.querySelector('main');
      if (main) main.insertAdjacentHTML('afterbegin', '<div style="padding:16px; border:1px solid var(--border); border-radius:8px; color:var(--text-2); font:400 13px \'IBM Plex Sans\',sans-serif;">Could not load ./data/accidents.json — run this page via the local server.</div>');
      return;
    }

    let seed = [];
    try { const sres = await fetch('./data/citizen_seed.json?v=1'); if (sres.ok) seed = await sres.json(); } catch (e) { /* optional */ }
    DATA = data.concat(loadSeed(seed)).concat(loadCitizen());   // base + shipped seed + this browser's reports
    precompute();
    AGG = computeAgg();
    buildAll();

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { charts.forEach((c) => c.resize()); }, 150); });
  }

  document.addEventListener('DOMContentLoaded', boot);

  /* ---- shell integration (index.html single-page shell) ---- */
  // the shell's single theme toggle dispatches this; recolour every chart
  document.addEventListener('crash:themechange', function () { if (AGG) buildAll(); });
  // the charts are built while the Analytics section is hidden (0-size); the
  // shell calls this once the section becomes visible so they size correctly
  window.__crashResizeAnalytics = function () { charts.forEach(function (c) { try { c.resize(); } catch (e) {} }); };

  /* citizen reports saved by the Reports-section form (same localStorage key as
     app.js). Kept self-sufficient so analytics.html works standalone too. */
  function validReport(r) {
    return r && typeof r.lat === 'number' && typeof r.lng === 'number' && SEV[r.severity] &&
      typeof r.datetime === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(r.datetime) &&
      typeof r.cause === 'string' && typeof r.vehicle === 'string' && typeof r.area === 'string';
  }
  function loadCitizen() {
    try {
      var raw = localStorage.getItem('citizen_reports');
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(validReport);
    } catch (e) { return []; }
  }
  function loadSeed(arr) { return Array.isArray(arr) ? arr.filter(validReport) : []; }

  /* the shell calls this after a new citizen report is added, with the live
     dataset (app.raw), so the heatmap + KPI stats update immediately */
  window.__crashRebuildAnalytics = function (records) {
    if (!Array.isArray(records)) return;
    DATA = records;
    precompute();
    AGG = computeAgg();
    buildAll();
  };
})();
