/* =============================================================================
   CRASH — PDF report generator (Phase 5)
   Self-contained: recomputes aggregates from raw records with the SAME engine
   constants as the dashboard, so the report always matches what's on screen.
   Builds two branded PDFs via jsPDF + autotable:
     CRASHReport.city(records)         — city-wide safety report
     CRASHReport.zone(records, meta)   — per-zone report from a subset of records
   Depends on: window.jspdf (+ autotable plugin) and window.CRASH_INTERVENTIONS.
   ========================================================================== */
'use strict';
(function (root) {

  const W = { fatal: 3, serious: 2, slight: 1 };
  const BBOX = { latMin: 12.83, lngMin: 80.03 }, CELL = 0.0022, SUP = 2, TOP_N = 10, HIGH_RISK_MIN = 40;
  const RECENT_MONTHS = 6, EMERGE_LIFT = 1.5, EMERGE_MIN_RECENT = 8, EMERGE_TOP_N = 6;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // palette (RGB)
  const C = { accent: [27, 143, 172], dark: [22, 32, 43], gray: [86, 100, 114], light: [240, 243, 247],
    calloutBg: [231, 244, 248], white: [255, 255, 255], rule: [214, 222, 230], head: [22, 32, 43], row: [246, 248, 251] };

  const fmt = (n) => Number(n).toLocaleString('en-US');
  const pad2 = (n) => String(n).padStart(2, '0');
  const pct = (v, t) => Math.round(100 * v / (t || 1)) + '%';
  const sortedEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '').trim() || 'report';   // strip chars illegal in filenames

  /* jsPDF's built-in fonts only encode Latin-1; typographic characters outside
     that range (≈, en/em dash, curly quotes, ×, ·, °) render as garbage bytes
     (e.g. "≈" -> the two bytes 0x22 0x48 = '"H'). Map every non-ASCII glyph we
     use to a safe ASCII equivalent before it reaches the PDF. */
  function A(s) {
    return String(s)
      .replace(/≈/g, '~')            // ≈
      .replace(/[–—]/g, '-')    // – —
      .replace(/[‘’]/g, "'")    // ‘ ’
      .replace(/[“”]/g, '"')    // “ ”
      .replace(/×/g, 'x')            // ×
      .replace(/·/g, '-')            // · (separator)
      .replace(/°/g, '')             // ° (degree)
      .replace(/[^\x00-\x7F]/g, '');      // drop anything else non-ASCII
  }

  /* ---------------- compute ---------------- */
  function monthMeta(records) {
    let mn = Infinity, mx = -Infinity;
    for (const a of records) { const ym = (+a.datetime.slice(0, 4)) * 12 + (+a.datetime.slice(5, 7) - 1); if (ym < mn) mn = ym; if (ym > mx) mx = ym; }
    return { min: mn, max: mx, count: mx - mn + 1 };
  }
  function gridCells(records, mm) {
    const map = new Map();
    for (const a of records) {
      const ci = Math.floor((a.lat - BBOX.latMin) / CELL), cj = Math.floor((a.lng - BBOX.lngMin) / CELL), k = ci + '_' + cj;
      let c = map.get(k);
      if (!c) { c = { ci, cj, count: 0, score: 0, fatal: 0, serious: 0, slight: 0, night: 0, areas: {}, cause: {}, recent: 0, baseline: 0, recentScore: 0, sumLat: 0, sumLng: 0 }; map.set(k, c); }
      c.count++; c.score += W[a.severity]; c[a.severity]++;
      const h = +a.datetime.slice(11, 13); if (h < 6 || h >= 18) c.night++;
      c.areas[a.area] = (c.areas[a.area] || 0) + 1; c.cause[a.cause] = (c.cause[a.cause] || 0) + 1;
      const month = ((+a.datetime.slice(0, 4)) * 12 + (+a.datetime.slice(5, 7) - 1)) - mm.min;
      if (month > mm.count - 1 - RECENT_MONTHS) { c.recent++; c.recentScore += W[a.severity]; } else c.baseline++;
      c.sumLat += a.lat; c.sumLng += a.lng;
    }
    const arr = [...map.values()];
    arr.forEach((c) => { c.area = sortedEntries(c.areas)[0][0]; c.lat = c.sumLat / c.count; c.lng = c.sumLng / c.count; });
    return arr;
  }
  function topJunctions(cells) {
    const byScore = cells.slice().sort((a, b) => b.score - a.score || b.count - a.count);
    const top = [];
    for (const c of byScore) { if (top.length >= TOP_N) break; if (top.some((p) => Math.abs(p.ci - c.ci) <= SUP && Math.abs(p.cj - c.cj) <= SUP)) continue; top.push(c); }
    const topRaw = top.length ? top[0].score : 1;
    top.forEach((c) => { c.norm = Math.max(1, Math.round(100 * Math.pow(c.score / topRaw, 0.6))); });
    return top;
  }
  function emergingCells(cells, mm) {
    const baseMonths = Math.max(1, mm.count - RECENT_MONTHS);
    const cand = [];
    for (const c of cells) {
      if (c.recent < EMERGE_MIN_RECENT) continue;
      const rr = c.recent / RECENT_MONTHS, br = c.baseline / baseMonths, lift = br > 0 ? rr / br : 3;
      if (lift < EMERGE_LIFT) continue;
      cand.push({ area: c.area, ci: c.ci, cj: c.cj, recent: c.recent, baseline: c.baseline, lift: lift, pct: Math.round((lift - 1) * 100), priority: c.recentScore * (lift - 1) });
    }
    cand.sort((a, b) => b.priority - a.priority);
    const pick = [];
    for (const c of cand) { if (pick.length >= EMERGE_TOP_N) break; if (pick.some((p) => Math.abs(p.ci - c.ci) <= SUP && Math.abs(p.cj - c.cj) <= SUP)) continue; pick.push(c); }
    return pick;
  }
  function priorityQueue(top) {
    const M = root.CRASH_INTERVENTIONS;
    return top.map((c) => {
      const dom = sortedEntries(c.cause)[0][0];
      const iv = M ? M.pick(dom, c.night / c.count) : { fix: '-', cost: 'High', eff: 0.2 };
      const prevent = M ? M.preventable(c.fatal, c.serious, iv.eff) : 0;
      return { area: c.area, dom: dom, iv: iv, prevent: prevent, fatal: c.fatal, serious: c.serious };
    }).sort((a, b) => b.prevent - a.prevent);
  }
  function cityData(records) {
    const mm = monthMeta(records);
    const sev = { fatal: 0, serious: 0, slight: 0 }, cause = {}, veh = {};
    for (const a of records) { sev[a.severity]++; cause[a.cause] = (cause[a.cause] || 0) + 1; veh[a.vehicle] = (veh[a.vehicle] || 0) + 1; }
    const cells = gridCells(records, mm);
    const top = topJunctions(cells);
    const sevCity = sev.fatal + sev.serious; let sevTop = 0; top.forEach((c) => { sevTop += c.fatal + c.serious; });
    return { mm, total: records.length, sev, cause, veh, top, highRisk: cells.filter((c) => c.score >= HIGH_RISK_MIN).length,
      sevCity, sevTop, leveragePct: sevCity ? Math.round(100 * sevTop / sevCity) : 0, emerging: emergingCells(cells, mm), queue: priorityQueue(top) };
  }
  function zoneData(records) {
    const sev = { fatal: 0, serious: 0, slight: 0 }, cause = {}, veh = {}, weather = { clear: 0, rain: 0, fog: 0 };
    const hour = new Array(24).fill(0), dow = new Array(7).fill(0); let night = 0;
    for (const a of records) {
      sev[a.severity]++; cause[a.cause] = (cause[a.cause] || 0) + 1; veh[a.vehicle] = (veh[a.vehicle] || 0) + 1; weather[a.weather] = (weather[a.weather] || 0) + 1;
      const h = +a.datetime.slice(11, 13); hour[h]++; if (h < 6 || h >= 18) night++;
      const d = a.datetime.slice(0, 10).split('-'); dow[(new Date(+d[0], +d[1] - 1, +d[2]).getDay() + 6) % 7]++;
    }
    const M = root.CRASH_INTERVENTIONS, total = records.length || 1;
    const domCause = sortedEntries(cause).length ? sortedEntries(cause)[0][0] : '-';
    const iv = M ? M.pick(domCause, night / total) : { fix: '-', cost: 'High', eff: 0.2 };
    return { total: records.length, sev, cause, veh, weather, hour, dow, night, domCause, iv,
      preventable: M ? M.preventable(sev.fatal, sev.serious, iv.eff) : 0,
      peakHour: hour.indexOf(Math.max(...hour)), peakDow: dow.indexOf(Math.max(...dow)) };
  }

  /* ---------------- pdf helpers ---------------- */
  const M = 40;
  const tc = (doc, col) => doc.setTextColor(col[0], col[1], col[2]);
  const fc = (doc, col) => doc.setFillColor(col[0], col[1], col[2]);
  const dcol = (doc, col) => doc.setDrawColor(col[0], col[1], col[2]);
  const PW = (doc) => doc.internal.pageSize.getWidth();
  const PH = (doc) => doc.internal.pageSize.getHeight();

  function today() { const d = new Date(); return pad2(d.getDate()) + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear(); }
  function todayFile() { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function ymRange(mm) { const y0 = Math.floor(mm.min / 12), m0 = mm.min % 12, y1 = Math.floor(mm.max / 12), m1 = mm.max % 12; return MON[m0] + ' ' + y0 + ' – ' + MON[m1] + ' ' + y1; }

  function header(doc, title, subtitle, metaLines) {
    let y = 46;
    fc(doc, C.accent); doc.roundedRect(M, y - 17, 27, 27, 5, 5, 'F');
    tc(doc, C.white); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text('C', M + 13.5, y + 2.5, { align: 'center' });
    tc(doc, C.dark); doc.setFont('helvetica', 'bold'); doc.setFontSize(16.5); doc.text(title, M + 38, y - 3);
    tc(doc, C.gray); doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(subtitle, M + 38, y + 11);
    doc.setFontSize(8.5);
    metaLines.forEach((ln, i) => { doc.text(ln, PW(doc) - M, (y - 9) + i * 11, { align: 'right' }); });
    y += 28; dcol(doc, C.accent); doc.setLineWidth(1.4); doc.line(M, y, PW(doc) - M, y);
    return y + 20;
  }
  function ensureSpace(doc, y, need) { if (y + need > PH(doc) - 46) { doc.addPage(); return 54; } return y; }
  function sectionTitle(doc, y, label) {
    y = ensureSpace(doc, y, 72);
    tc(doc, C.dark); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(label, M, y);
    return y + 9;
  }
  function kpiRow(doc, y, items) {
    const gap = 9, n = items.length, w = (PW(doc) - 2 * M - gap * (n - 1)) / n, h = 46;
    items.forEach((it, i) => {
      const x = M + i * (w + gap);
      fc(doc, C.light); doc.roundedRect(x, y, w, h, 5, 5, 'F');
      tc(doc, C.dark); doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.text(String(it.v), x + 10, y + 23);
      tc(doc, C.gray); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text(String(it.l).toUpperCase(), x + 10, y + 37);
    });
    return y + h + 18;
  }
  function callout(doc, y, big, text) {
    const w = PW(doc) - 2 * M, h = 46;
    fc(doc, C.calloutBg); doc.roundedRect(M, y, w, h, 6, 6, 'F');
    tc(doc, C.accent); doc.setFont('helvetica', 'bold'); doc.setFontSize(23); doc.text(big, M + 15, y + 30);
    const bw = doc.getTextWidth(big);
    tc(doc, C.dark); doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    const lines = doc.splitTextToSize(text, w - bw - 44);
    doc.text(lines, M + 15 + bw + 14, y + (h - (lines.length - 1) * 13) / 2 + 3);
    return y + h + 20;
  }
  function table(doc, head, body, startY, colStyles) {
    doc.autoTable({
      head: [head], body: body, startY: startY, margin: { left: M, right: M }, theme: 'grid',
      styles: { font: 'helvetica', fontSize: 9, cellPadding: 4.5, lineColor: C.rule, lineWidth: 0.5, textColor: [40, 50, 62], overflow: 'linebreak' },
      headStyles: { fillColor: C.head, textColor: C.white, fontStyle: 'bold', fontSize: 8.5 },
      alternateRowStyles: { fillColor: C.row },
      columnStyles: colStyles || {},
      didParseCell: function (data) { const t = data.cell.text; if (Array.isArray(t)) data.cell.text = t.map(A); else if (t != null) data.cell.text = A(String(t)); },
    });
    return doc.lastAutoTable.finalY + 20;
  }
  function ivBox(doc, y, d) {
    const w = PW(doc) - 2 * M;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10.5);
    const lines = doc.splitTextToSize('Dominant cause: ' + d.domCause + '.  ' + d.iv.fix + '.', w - 26);
    const h = 22 + lines.length * 14 + 30;
    y = ensureSpace(doc, y, h + 10);
    fc(doc, C.calloutBg); doc.roundedRect(M, y, w, h, 6, 6, 'F');
    tc(doc, C.dark); doc.text(lines, M + 13, y + 20);
    const by = y + 22 + lines.length * 14;
    tc(doc, C.accent); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text('≈ ' + fmt(d.preventable) + ' severe crashes preventable', M + 13, by);
    tc(doc, C.gray); doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('Capital cost: ' + d.iv.cost + '   ·   planning estimate over the record window', M + 13, by + 15);
    return y + h + 18;
  }
  function footer(doc) {
    const n = doc.internal.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i);
      dcol(doc, C.rule); doc.setLineWidth(0.5); doc.line(M, PH(doc) - 34, PW(doc) - M, PH(doc) - 34);
      tc(doc, C.gray); doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5);
      doc.text('CRASH · Simulated data for demonstration — not an official record. Impact figures are planning estimates.', M, PH(doc) - 22);
      doc.text('Page ' + i + ' of ' + n, PW(doc) - M, PH(doc) - 22, { align: 'right' });
    }
  }
  function newDoc() {
    const JS = root.jspdf && root.jspdf.jsPDF;
    if (!JS) { try { alert('PDF library failed to load — check your connection and reload.'); } catch (e) {} return null; }
    const doc = new JS({ unit: 'pt', format: 'a4' });
    if (typeof doc.autoTable !== 'function') { try { alert('PDF table plugin failed to load.'); } catch (e) {} return null; }
    // sanitise every string drawn directly with doc.text() to ASCII
    const _text = doc.text;
    doc.text = function (s) { const a = Array.prototype.slice.call(arguments); a[0] = Array.isArray(s) ? s.map(A) : A(s); return _text.apply(doc, a); };
    return doc;
  }

  /* ---------------- reports ---------------- */
  function city(records) {
    const doc = newDoc(); if (!doc) return;
    const d = cityData(records), t = d.total || 1;
    let y = header(doc, 'Chennai Road Accident Safety Hub', 'City-wide safety report · Greater Chennai', [ymRange(d.mm), 'Generated ' + today()]);
    y = kpiRow(doc, y, [
      { v: fmt(d.total), l: 'Incidents' }, { v: fmt(d.sev.fatal), l: 'Fatalities' }, { v: fmt(d.sev.fatal + d.sev.serious), l: 'Severe' },
      { v: fmt(d.highRisk), l: 'Risk zones' }, { v: fmt(d.emerging.length), l: 'Emerging' }, { v: fmt(Math.round(d.total / d.mm.count)), l: 'Per month' },
    ]);
    y = callout(doc, y, d.leveragePct + '%', 'of the city’s severe crashes occur in the top ' + d.top.length + ' junction cells (' + fmt(d.sevTop) + ' of ' + fmt(d.sevCity) + ' fatal + serious).');
    y = sectionTitle(doc, y, 'Top 10 ranked junctions');
    y = table(doc, ['#', 'Area', 'Incidents', 'Fatal', 'Serious', 'Risk /100'],
      d.top.map((c, i) => [i + 1, c.area, fmt(c.count), fmt(c.fatal), fmt(c.serious), c.norm]),
      y, { 0: { cellWidth: 24, halign: 'center' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Contributing causes');
    y = table(doc, ['Cause', 'Incidents', 'Share'], sortedEntries(d.cause).map((e) => [e[0], fmt(e[1]), pct(e[1], t)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Vehicles involved');
    y = table(doc, ['Vehicle', 'Incidents', 'Share'], sortedEntries(d.veh).map((e) => [e[0], fmt(e[1]), pct(e[1], t)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Emerging hotspots · recent 6 mo vs prior 18 mo');
    y = table(doc, ['Area', 'Recent', 'Prior', 'Rate lift', 'Increase'],
      d.emerging.length ? d.emerging.map((e) => [e.area, fmt(e.recent), fmt(e.baseline), e.lift.toFixed(2) + '×', '+' + e.pct + '%']) : [['— none surging —', '', '', '', '']],
      y, { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Intervention priority · est. severe crashes preventable');
    y = table(doc, ['#', 'Area', 'Dominant cause', 'Recommended intervention', 'Cost', 'Prevent'],
      d.queue.map((r, i) => [i + 1, r.area, r.dom, r.iv.fix, r.iv.cost, '≈ ' + fmt(r.prevent)]),
      y, { 0: { cellWidth: 22, halign: 'center' }, 3: { cellWidth: 148 }, 5: { halign: 'right' } });
    footer(doc);
    doc.save('Complete Report.pdf');
  }

  function zone(records, meta) {
    const doc = newDoc(); if (!doc) return;
    meta = meta || {};
    const d = zoneData(records), t = d.total || 1;
    const sub = meta.subtitle || ((meta.rank ? 'Hotspot ' + pad2(meta.rank) + ' · ' : '') + 'Zone safety report · 250 m cell');
    const metaLines = [];
    if (meta.lat != null && meta.lng != null) metaLines.push(meta.lat.toFixed(4) + '° N · ' + meta.lng.toFixed(4) + '° E');
    metaLines.push('Generated ' + today());
    let y = header(doc, meta.title || 'Zone report', sub, metaLines);
    y = kpiRow(doc, y, [
      { v: fmt(d.total), l: 'Incidents' }, { v: fmt(d.sev.fatal), l: 'Fatal' }, { v: fmt(d.sev.serious), l: 'Serious' },
      { v: fmt(d.sev.slight), l: 'Slight' }, { v: pct(d.night, t), l: 'Night' }, { v: pad2(d.peakHour) + ':00', l: 'Peak hour' },
    ]);
    y = sectionTitle(doc, y, 'Severity breakdown');
    y = table(doc, ['Severity', 'Incidents', 'Share'], [['Fatal', fmt(d.sev.fatal), pct(d.sev.fatal, t)], ['Serious', fmt(d.sev.serious), pct(d.sev.serious, t)], ['Slight', fmt(d.sev.slight), pct(d.sev.slight, t)]], y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Top causes');
    y = table(doc, ['Cause', 'Incidents', 'Share'], sortedEntries(d.cause).slice(0, 6).map((e) => [e[0], fmt(e[1]), pct(e[1], t)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Vehicles involved');
    y = table(doc, ['Vehicle', 'Incidents', 'Share'], sortedEntries(d.veh).slice(0, 6).map((e) => [e[0], fmt(e[1]), pct(e[1], t)]), y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Weather at incident · peak day ' + DOW[d.peakDow]);
    y = table(doc, ['Condition', 'Incidents', 'Share'], [['Clear', fmt(d.weather.clear), pct(d.weather.clear, t)], ['Rain', fmt(d.weather.rain), pct(d.weather.rain, t)], ['Fog', fmt(d.weather.fog), pct(d.weather.fog, t)]], y, { 1: { halign: 'right' }, 2: { halign: 'right' } });
    y = sectionTitle(doc, y, 'Recommended intervention');
    y = ivBox(doc, y, d);
    footer(doc);
    doc.save(safeName(meta.title || 'Zone') + '.pdf');
  }

  root.CRASHReport = { city: city, zone: zone };
})(typeof window !== 'undefined' ? window : this);
