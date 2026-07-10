/* =============================================================================
   C.R.A.S.H Bot — AI chat over the Chennai accident dataset.
   The frontend sends the question PLUS a complete statistical digest of the whole
   in-memory dataset to POST /ask (all ~10k raw rows can't fit the model's context,
   so the digest carries every aggregate — each area's full breakdown, all causes,
   vehicles, weather, day/night). The AI answers freely from that data; when the
   answer is about a subset it also returns filters and THIS page's map highlights
   exactly those accidents. Separate Leaflet instance from the home map.
   ========================================================================== */
(function () {
  'use strict';

  var SEV = { fatal: '#BE2F2A', serious: '#CE8A2E', slight: '#E7C64B' };
  var ACCENT = (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#43B0CC');
  var botLastRecs = null;
  var BOT_EXAMPLES = ['Which area has the most fatal accidents?', 'Safest areas in Chennai?', 'Compare Adyar and Velachery', 'What causes most crashes?'];
  var BOT_UNAVAILABLE = 'C.R.A.S.H Bot is unavailable right now — try the example questions or the filters.';

  var botMap = null, botPointLayer = null, botTiles = null, botBounds = null, chatInited = false, busy = false;
  var botBloomLayer = null, botEmergeLayer = null, botHospLayer = null, botHospOn = false;

  function app() { return window.CRASH_APP || null; }
  function records() { var a = app(); return (a && a.records && a.records()) || []; }
  function isNight(a) {
    if (typeof a._night === 'boolean') return a._night;
    var h = parseInt(String(a.datetime || '').slice(11, 13), 10);
    return h < 6 || h >= 18;
  }
  function fmtNum(n) { return Number(n).toLocaleString('en-US'); }

  function cleanFilters(f) {
    f = (f && typeof f === 'object') ? f : {};
    var out = {};
    ['area', 'severity', 'timeOfDay', 'weather', 'cause', 'vehicle'].forEach(function (k) { out[k] = (typeof f[k] === 'string' && f[k]) ? f[k] : null; });
    return out;
  }
  /* SAME field semantics as the home map's filterRecords() — used to highlight the
     subset an answer is about (so the visible dots match what the AI describes) */
  function botFilter(f) {
    f = f || {};
    return records().filter(function (a) {
      if (f.area && a.area !== f.area) return false;
      if (f.severity && a.severity !== f.severity) return false;
      if (f.timeOfDay === 'day' && isNight(a)) return false;
      if (f.timeOfDay === 'night' && !isNight(a)) return false;
      if (f.weather && a.weather !== f.weather) return false;
      if (f.cause && a.cause !== f.cause) return false;
      if (f.vehicle && a.vehicle !== f.vehicle) return false;
      return true;
    });
  }
  function hasActiveFilter(f) { return !!(f && (f.area || f.severity || f.timeOfDay || f.weather || f.cause || f.vehicle)); }
  function filterSummary(f) {
    var p = [];
    if (f.severity) p.push(f.severity);
    p.push('accidents');
    if (f.area) p.push('in ' + f.area);
    if (f.vehicle) p.push('involving a ' + f.vehicle);
    if (f.cause) p.push('caused by ' + f.cause);
    if (f.weather) p.push('in ' + f.weather);
    if (f.timeOfDay) p.push('at ' + f.timeOfDay);
    return p.join(' ');
  }

  // ---- the data digest sent to the AI -------------------------------------
  var _digest = null, _digestKey = '';
  function topKey(obj) { var b = null, bn = -1; Object.keys(obj).forEach(function (k) { if (obj[k] > bn) { bn = obj[k]; b = k; } }); return b; }
  function descList(obj) { return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).map(function (k) { return k + ' ' + obj[k]; }).join(', '); }
  function buildDigest() {
    var recs = records();
    var _key = recs.length + '|' + ((app() && app().hospitals) ? 'h' : '0');
    if (_digest && _digestKey === _key) return _digest;   // cache until dataset OR hospital availability changes
    var g = { total: recs.length, fatal: 0, serious: 0, slight: 0, day: 0, night: 0, clear: 0, rain: 0, fog: 0 };
    var byArea = {}, byCause = {}, byVehicle = {};
    recs.forEach(function (a) {
      if (g[a.severity] !== undefined) g[a.severity]++;
      if (isNight(a)) g.night++; else g.day++;
      if (a.weather === 'rain') g.rain++; else if (a.weather === 'fog') g.fog++; else g.clear++;
      if (a.cause) byCause[a.cause] = (byCause[a.cause] || 0) + 1;
      if (a.vehicle) byVehicle[a.vehicle] = (byVehicle[a.vehicle] || 0) + 1;
      var r = byArea[a.area] || (byArea[a.area] = { total: 0, fatal: 0, serious: 0, slight: 0, day: 0, night: 0, clear: 0, rain: 0, fog: 0, cause: {}, vehicle: {}, latSum: 0, lngSum: 0, geoN: 0 });
      r.total++; if (r[a.severity] !== undefined) r[a.severity]++;
      if (isFinite(a.lat) && isFinite(a.lng)) { r.latSum += a.lat; r.lngSum += a.lng; r.geoN++; }
      if (isNight(a)) r.night++; else r.day++;
      if (a.weather === 'rain') r.rain++; else if (a.weather === 'fog') r.fog++; else r.clear++;
      if (a.cause) r.cause[a.cause] = (r.cause[a.cause] || 0) + 1;
      if (a.vehicle) r.vehicle[a.vehicle] = (r.vehicle[a.vehicle] || 0) + 1;
    });
    var L = [];
    L.push('Chennai road-accident dataset: ' + g.total + ' recorded accidents (period Jul 2024 to Jun 2026).');
    L.push('Severity totals: ' + g.fatal + ' fatal, ' + g.serious + ' serious, ' + g.slight + ' slight.');
    L.push('Time of day: ' + g.day + ' day (06:00-18:00), ' + g.night + ' night (18:00-06:00).');
    L.push('Weather: ' + g.clear + ' clear, ' + g.rain + ' rain, ' + g.fog + ' fog.');
    L.push('By cause (desc): ' + descList(byCause) + '.');
    L.push('By vehicle (desc): ' + descList(byVehicle) + '.');
    L.push('');
    L.push('Per-area breakdown — columns: AREA | total | fatal/serious/slight | day/night | clear/rain/fog | top cause | top vehicle');
    Object.keys(byArea).sort(function (a, b) { return byArea[b].total - byArea[a].total; }).forEach(function (name) {
      var r = byArea[name];
      L.push(name + ' | ' + r.total + ' | ' + r.fatal + '/' + r.serious + '/' + r.slight + ' | ' + r.day + '/' + r.night + ' | ' + r.clear + '/' + r.rain + '/' + r.fog + ' | ' + (topKey(r.cause) || '-') + ' | ' + (topKey(r.vehicle) || '-'));
    });

    // ---- hospitals + per-area nearest-hospital distances -----------------------
    // Reuses the home map's placed hospital list and the SAME Haversine as the zone
    // dossier, so the AI's hospital answers line up with what the map shows.
    var ap = app();
    if (ap && ap.hospitals) {
      var hosps = ap.hospitals() || [];
      if (hosps.length) {
        L.push('');
        L.push('HOSPITALS on the map (' + hosps.length + ' major Chennai hospitals) \u2014 columns: NAME | type | area');
        hosps.forEach(function (h) { L.push(h.name + ' | ' + h.type + ' | ' + h.area); });
      }
    }
    if (ap && ap.nearestHospital) {
      var hRows = [];
      Object.keys(byArea).forEach(function (name) {
        var r = byArea[name];
        if (!r.geoN) return;
        var nh = ap.nearestHospital(r.latSum / r.geoN, r.lngSum / r.geoN);
        if (nh && nh.hospital) hRows.push({ area: name, name: nh.hospital.name, type: nh.hospital.type, km: nh.km });
      });
      if (hRows.length) {
        hRows.sort(function (x, y) { return y.km - x.km; });   // farthest (most underserved) first
        L.push('');
        L.push('Nearest hospital to each area (straight-line km from the mean location of that area\'s accidents; farthest first) \u2014 columns: AREA | nearest hospital | type | km');
        hRows.forEach(function (r) { L.push(r.area + ' | ' + r.name + ' | ' + r.type + ' | ' + r.km.toFixed(1) + ' km'); });
      }
    }
    _digest = L.join('\n'); _digestKey = _key;
    return _digest;
  }

  // ---- map ----------------------------------------------------------------
  function renderBotPoints(recs) {
    botLastRecs = recs;
    if (!botMap) return;
    if (botPointLayer) { botPointLayer.remove(); botPointLayer = null; }
    var canvas = L.canvas({ padding: 0.5 });
    botPointLayer = L.layerGroup();
    var ap = app();
    recs.forEach(function (a) {
      if (!isFinite(a.lat) || !isFinite(a.lng)) return;
      var color = SEV[a.severity] || SEV.slight;
      var m = L.circleMarker([a.lat, a.lng], a.citizen
        ? { renderer: canvas, radius: 5, stroke: true, color: ACCENT, weight: 2, opacity: 0.95, fillColor: color, fillOpacity: 0.85, bubblingMouseEvents: false }
        : { renderer: canvas, radius: 3.2, stroke: false, fillColor: color, fillOpacity: 0.5, bubblingMouseEvents: false });
      if (ap && ap.pointTipHtml) m.bindTooltip(ap.pointTipHtml(a), { className: 'hotspot-tip', direction: 'top', opacity: 1 });
      if (ap && ap.pointPopupHtml) m.bindPopup(ap.pointPopupHtml(a), { closeButton: true, autoPan: true });
      m.addTo(botPointLayer);
    });
    botPointLayer.addTo(botMap);
  }
  function inChennai(lat, lng) {
    var bb = (app() && app().bbox && app().bbox()) || { latMin: 12.80, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 };
    return lat >= bb.latMin - 0.1 && lat <= bb.latMax + 0.1 && lng >= bb.lngMin - 0.12 && lng <= bb.lngMax + 0.12;
  }
  function fitTo(recs) {
    if (!botMap || !recs.length) return;
    var pts = [];
    recs.forEach(function (a) { if (isFinite(a.lat) && isFinite(a.lng) && inChennai(a.lat, a.lng)) pts.push([a.lat, a.lng]); });
    if (!pts.length) { if (botBounds) botMap.fitBounds(botBounds, { padding: [18, 18] }); return; }
    try { var b = L.latLngBounds(pts); if (b.isValid()) botMap.fitBounds(b, { padding: [26, 26] }); } catch (e) { /* ignore */ }
  }
  function botEmergeIcon(i) {
    var d0 = (0.3 * i).toFixed(2), d1 = (0.3 * i + 1.2).toFixed(2);
    return L.divIcon({ className: 'em-icon', iconSize: [34, 34], iconAnchor: [17, 17],
      html: '<div class="em-mark"><span class="em-pulse" style="animation-delay:' + d0 + 's;"></span><span class="em-pulse" style="animation-delay:' + d1 + 's;"></span><span class="em-core"></span></div>' });
  }
  /* the SAME signature risk blooms as the home map — top-10 severity-weighted junctions */
  function renderBotBlooms() {
    if (!botMap) return;
    if (botBloomLayer) { botBloomLayer.remove(); botBloomLayer = null; }
    var a = app(); if (!a || !a.hotspots || !a.bloomIcon) return;
    var hs = a.hotspots(); if (!hs.length) return;
    botBloomLayer = L.layerGroup();
    hs.forEach(function (h) {
      if (!isFinite(h.lat) || !isFinite(h.lng)) return;
      var m = L.marker([h.lat, h.lng], { icon: a.bloomIcon(h), riseOnHover: true, zIndexOffset: 400 - (h.rank || 0) });
      m.bindTooltip(a.hotspotTipHtml(h), { className: 'hotspot-tip', direction: 'top', opacity: 1 });
      m.bindPopup(a.hotspotTipHtml(h), { closeButton: true });
      botBloomLayer.addLayer(m);
    });
    botBloomLayer.addTo(botMap);
  }
  /* the emerging-hotspot pulse markers (surging junctions) */
  function renderBotEmerging() {
    if (!botMap) return;
    if (botEmergeLayer) { botEmergeLayer.remove(); botEmergeLayer = null; }
    var a = app(); if (!a || !a.emerging) return;
    var em = a.emerging(); if (!em.length) return;
    botEmergeLayer = L.layerGroup();
    em.forEach(function (e, i) {
      if (!isFinite(e.lat) || !isFinite(e.lng)) return;
      L.marker([e.lat, e.lng], { icon: botEmergeIcon(i), zIndexOffset: 250, riseOnHover: true,
        title: (e.area || 'Junction') + ' · emerging · +' + e.pctIncrease + '% recent rate' }).addTo(botEmergeLayer);
    });
    botEmergeLayer.addTo(botMap);
  }
  /* hospital layer (built once) + an on-map toggle control, mirroring the home map's Hospitals toggle */
  function buildBotHospitals() {
    var a = app(); if (!a || !a.hospitals || !a.hospitalIcon) return null;
    var layer = L.layerGroup();
    a.hospitals().forEach(function (h) {
      if (!isFinite(h.dlat) || !isFinite(h.dlng)) return;
      var m = L.marker([h.dlat, h.dlng], { icon: a.hospitalIcon(h.type), riseOnHover: true, keyboard: false });
      m.bindPopup(a.hospitalPopupHtml(h), { closeButton: true, autoPan: true });
      layer.addLayer(m);
    });
    return layer;
  }
  function setBotHospitals(on, btn) {
    botHospOn = !!on;
    if (!botHospLayer) botHospLayer = buildBotHospitals();
    if (botHospLayer && botMap) { if (botHospOn) botHospLayer.addTo(botMap); else if (botMap.hasLayer(botHospLayer)) botHospLayer.remove(); }
    if (btn) { btn.style.borderColor = botHospOn ? 'var(--accent)' : 'var(--border)'; btn.style.color = botHospOn ? 'var(--accent)' : 'var(--text-2)'; btn.setAttribute('aria-pressed', botHospOn ? 'true' : 'false'); }
  }
  function addHospToggle() {
    if (!botMap || !L.Control) return;
    var Ctl = L.Control.extend({ options: { position: 'topleft' },
      onAdd: function () {
        var b = L.DomUtil.create('button', '');
        b.type = 'button'; b.title = 'Show / hide hospitals'; b.setAttribute('aria-pressed', 'false');
        b.style.cssText = "display:flex;align-items:center;gap:6px;font:500 11px 'IBM Plex Mono',monospace;letter-spacing:.02em;padding:6px 9px;background:var(--panel);color:var(--text-2);border:1px solid var(--border);border-radius:6px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.18);";
        b.innerHTML = '<span aria-hidden="true" style="color:var(--accent);font-weight:700;">\u271A</span> Hospitals';
        L.DomEvent.disableClickPropagation(b);
        L.DomEvent.on(b, 'click', function () { setBotHospitals(!botHospOn, b); });
        return b;
      } });
    new Ctl().addTo(botMap);
  }
  function initBotMap() {
    if (botMap) { botMap.invalidateSize(); return; }
    var el = document.getElementById('botMap');
    if (!el || typeof L === 'undefined' || !app()) return;
    var bb = (app().bbox && app().bbox()) || { latMin: 12.80, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 };
    botBounds = L.latLngBounds([[bb.latMin, bb.lngMin], [bb.latMax, bb.lngMax]]);
    // hard limit to Chennai: the map can never pan or zoom out to the world
    var maxB = L.latLngBounds([[bb.latMin - 0.10, bb.lngMin - 0.12], [bb.latMax + 0.10, bb.lngMax + 0.12]]);
    botMap = L.map('botMap', { zoomControl: false, attributionControl: false, preferCanvas: true,
      minZoom: 9, maxZoom: 19, zoomSnap: 0.25, zoomDelta: 0.5, maxBounds: maxB, maxBoundsViscosity: 1.0 });
    botMap.fitBounds(botBounds, { padding: [18, 18] });   // frame the fixed Chennai bbox, not raw data bounds
    L.control.zoom({ position: 'bottomright' }).addTo(botMap);
    botTiles = L.tileLayer(app().tileUrl(), { subdomains: 'abcd', maxZoom: 20 });
    botTiles.addTo(botMap);
    renderBotPoints(records());
    renderBotBlooms();
    renderBotEmerging();
    addHospToggle();
    var reframe = function () { if (botMap) { botMap.invalidateSize(); botMap.fitBounds(botBounds, { padding: [18, 18] }); } };
    requestAnimationFrame(reframe);
    setTimeout(reframe, 160);
  }

  function showChip(html) {
    var chip = document.getElementById('botFilterChip'), t = document.getElementById('botFilterText');
    if (t) t.innerHTML = html;
    if (chip) chip.hidden = false;
  }
  function hideChip() { var chip = document.getElementById('botFilterChip'); if (chip) chip.hidden = true; }
  function resetMap() { var all = records(); renderBotPoints(all); fitTo(all); hideChip(); }

  /* highlight the subset the AI's answer is about; a whole-city / comparison answer
     (no active filter) resets the map to all accidents */
  function applyMapFromFilters(rawFilters) {
    if (!botMap) return;
    var f = cleanFilters(rawFilters);
    if (!hasActiveFilter(f)) { resetMap(); return; }
    var matched = botFilter(f);
    renderBotPoints(matched);
    if (matched.length) fitTo(matched);
    else if (f.area && app().areaCentroid) { var c = app().areaCentroid(f.area); if (c) botMap.setView(c, 14); }
    showChip('Showing: <b>' + escapeHtml(filterSummary(f)) + '</b> · <b>' + fmtNum(matched.length) + '</b> found');
  }

  // ---- chat ---------------------------------------------------------------
  function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* render the AI's plain-text answer with light markdown: **bold**, line breaks, and
     simple "- " / "1." bullet lines. HTML is escaped first, so it's injection-safe. */
  function renderAnswer(text) {
    var esc = escapeHtml(String(text || '').trim()).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    var out = '', inList = false;
    esc.split(/\r?\n/).forEach(function (ln) {
      var m = ln.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
      if (m) { if (!inList) { out += '<ul class="bot-ul">'; inList = true; } out += '<li>' + m[1] + '</li>'; }
      else { if (inList) { out += '</ul>'; inList = false; } if (ln.trim()) out += '<div class="bot-p">' + ln + '</div>'; }
    });
    if (inList) out += '</ul>';
    return out || esc;
  }

  function addMsg(role, html, extraClass) {
    var box = document.getElementById('botMessages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'bot-msg ' + (role === 'user' ? 'bot-msg-user' : 'bot-msg-bot') + (extraClass ? ' ' + extraClass : '');
    div.innerHTML = html;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }
  function typingOn() {
    var box = document.getElementById('botMessages');
    if (!box || document.getElementById('botTyping')) return;
    var div = document.createElement('div');
    div.className = 'bot-msg bot-msg-bot bot-typing'; div.id = 'botTyping';
    div.innerHTML = '<span class="bot-dot"></span><span class="bot-dot"></span><span class="bot-dot"></span>';
    box.appendChild(div); box.scrollTop = box.scrollHeight;
  }
  function typingOff() { var t = document.getElementById('botTyping'); if (t) t.remove(); }

  /* {answer, filters} -> render the answer + highlight the subset on the map */
  function respond(data) {
    var answer = (data && typeof data.answer === 'string' && data.answer.trim()) ? data.answer : "Sorry, I couldn't find an answer for that.";
    addMsg('bot', renderAnswer(answer), 'bot-rich');
    applyMapFromFilters(data && data.filters);
  }

  function ask(question) {
    question = (question || '').trim();
    if (!question || busy) return;
    busy = true;
    var send = document.getElementById('botSend');
    if (send) send.disabled = true;
    addMsg('user', escapeHtml(question));
    typingOn();

    var API = window.API_BASE || '';
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : 0;   // fuller answers can take a few seconds

    fetch(API + '/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question, digest: buildDigest() }),
      signal: ctrl ? ctrl.signal : undefined, cache: 'no-store',
    })
      .then(function (r) { if (timer) clearTimeout(timer); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { typingOff(); respond(data); })
      .catch(function () { if (timer) clearTimeout(timer); typingOff(); addMsg('bot', BOT_UNAVAILABLE); })
      .then(function () { busy = false; if (send) send.disabled = false; });
  }

  function initBotChat() {
    if (chatInited) return;
    chatInited = true;
    var input = document.getElementById('botInput');
    var send = document.getElementById('botSend');
    if (send) send.addEventListener('click', function () { var q = input ? input.value : ''; if (input) input.value = ''; ask(q); });
    if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); var q = input.value; input.value = ''; ask(q); } });
    var clr = document.getElementById('botFilterClear');
    if (clr) clr.addEventListener('click', resetMap);
    var ex = document.getElementById('botExamples');
    if (ex) {
      ex.innerHTML = '';
      BOT_EXAMPLES.forEach(function (q) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'bot-ex'; b.textContent = q;
        b.addEventListener('click', function () { ask(q); });
        ex.appendChild(b);
      });
      ex.hidden = false;
    }
    addMsg('bot', "Hi! I'm <b>C.R.A.S.H Bot</b>. Ask me anything about the Chennai road-accident data — counts, comparisons, causes, safest/most-dangerous areas — or tap an example.");
  }

  // keep the bot map's tiles in sync with the app-wide theme toggle
  document.addEventListener('crash:themechange', function () { if (botTiles && app()) botTiles.setUrl(app().tileUrl()); ACCENT = (getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || ACCENT); if (botLastRecs) renderBotPoints(botLastRecs); });
  // re-fit on resize while the section is visible
  var _brt;
  window.addEventListener('resize', function () {
    clearTimeout(_brt);
    _brt = setTimeout(function () { var s = document.getElementById('section-bot'); if (botMap && s && s.classList && s.classList.contains('active')) botMap.invalidateSize(); }, 150);
  });

  // Called by index.html's show('bot') each time the section is opened.
  window.__crashInitBot = function () {
    initBotMap();
    initBotChat();
    if (botMap) setTimeout(function () { botMap.invalidateSize(); }, 60);
  };

  // small surface for headless tests
  window.CRASH_BOT = { buildDigest: buildDigest, filter: botFilter, renderAnswer: renderAnswer, cleanFilters: cleanFilters, filterSummary: filterSummary };
})();
