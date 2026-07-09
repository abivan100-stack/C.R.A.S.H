/* =============================================================================
   Notifications — citizen-report activity system (frontend only)

   Listens for the 'crash:report' event (dispatched by the report form on a
   successful file, online or offline) and surfaces each new report as:
     STEP 1 — a themed toast (top-right, auto-dismiss, stacks, reduced-motion aware)
     STEP 2 — an entry in the header bell dropdown, with an unread-count badge

   Click-to-navigate (STEP 3) and localStorage persistence (STEP 4) come next.
   ========================================================================== */
(function () {
  'use strict';

  var SEV_COLOR = { fatal: '#E4404E', serious: '#F2933E', slight: '#E7C64B' };
  var TOAST_LIFE = 4000;    // toast auto-dismiss (ms)
  var TOAST_MAX = 4;        // cap the visible toast stack
  var MAX_ITEMS = 20;       // keep only the most recent N in the panel
  var LS_LIST = 'report_notifications';         // persisted notification list (survives reload)
  var LS_STATE = 'report_notifications_state';  // read/unread state, keyed by content signature
  var LS_CLEARED = 'report_notifications_cleared';  // signatures the user cleared — stay cleared across reloads

  var items = [];           // notifications, newest first
  var unread = 0;
  var panelOpen = false;
  var readSet = {};         // { signature: true } — reports the user has already seen
  var knownSigs = {};       // { signature: true } — every report already surfaced; backend polling checks this so it never re-notifies a known report (uncapped, unlike `items`)
  var clearedSet = {};      // { signature: true } — reports the user explicitly cleared; never rebuilt into the panel on refresh, so "Clear" sticks across reloads

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function summarize(r) {   // "Two-wheeler · Hit and run · Adyar"
    return [r.vehicle, r.cause, r.area].filter(Boolean).map(escapeHtml).join(' · ');
  }

  // relative "time since filed": just now / N min ago / N hr ago / N d ago / date
  function relativeTime(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60); if (h < 24) return h + ' hr ago';
    var d = Math.floor(h / 24); if (d < 7) return d + ' d ago';
    var w = Math.floor(d / 7); if (w < 5) return w + ' wk ago';
    try { return new Date(ts).toISOString().slice(0, 10); } catch (e) { return ''; }
  }

  // content signature — a STABLE identity across reloads and across id schemes. A
  // freshly-filed report has a local id; the same report from the backend has a
  // Mongo id — but the 8 fields are identical, so this keys read-state reliably.
  function signature(r) {
    return [Number(r.lat).toFixed(5), Number(r.lng).toFixed(5), r.severity,
      r.datetime, r.weather, r.cause, r.vehicle, r.area].join('|');
  }
  function countUnread() { return items.reduce(function (c, n) { return c + (n.read ? 0 : 1); }, 0); }

  /* ---- localStorage persistence (STEP 4) ---- */
  function persistItems() {
    try {
      localStorage.setItem(LS_LIST, JSON.stringify(items.map(function (n) {
        return { id: n.id, sig: n.sig, severity: n.severity, vehicle: n.vehicle, cause: n.cause,
          area: n.area, lat: n.lat, lng: n.lng, datetime: n.datetime, weather: n.weather, ts: n.ts, read: n.read };
      })));
    } catch (e) {}
  }
  function loadPersistedMap() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS_LIST) || '[]');
      if (!Array.isArray(arr)) return {};
      var map = {}; arr.forEach(function (n) { if (n && n.sig) map[n.sig] = n; }); return map;
    } catch (e) { return {}; }
  }
  function loadReadState() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS_STATE) || '[]');
      if (!Array.isArray(arr)) return {};
      var m = {}; arr.forEach(function (s) { m[s] = true; }); return m;
    } catch (e) { return {}; }
  }
  function saveReadState() {
    try { localStorage.setItem(LS_STATE, JSON.stringify(Object.keys(readSet))); } catch (e) {}
  }
  function loadClearedSet() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS_CLEARED) || '[]');
      if (!Array.isArray(arr)) return {};
      var m = {}; arr.forEach(function (s) { m[s] = true; }); return m;
    } catch (e) { return {}; }
  }
  function saveClearedSet() {
    try { localStorage.setItem(LS_CLEARED, JSON.stringify(Object.keys(clearedSet))); } catch (e) {}
  }

  function makeNotification(r) {
    return {
      id: r.id || ('n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
      severity: r.severity, vehicle: r.vehicle, cause: r.cause, area: r.area,
      lat: r.lat, lng: r.lng, datetime: r.datetime, weather: r.weather, citizen: true,
      sig: signature(r),
      ts: (typeof r.ts === 'number' ? r.ts : Date.now()), read: false,
    };
  }

  /* ------------------------------ toast (STEP 1) --------------------------- */
  function toastHost() {
    var host = document.getElementById('toastHost');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toastHost'; host.className = 'toast-host';
      host.setAttribute('aria-live', 'polite');
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }
  function dismissToast(el) {
    if (!el || el.__dismissed) return;
    el.__dismissed = true;
    if (el.__life) { clearTimeout(el.__life); el.__life = 0; }
    el.classList.remove('toast-in'); el.classList.add('toast-out');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 340);
  }
  function showToast(n) {
    if (!n || !document.body) return;
    var host = toastHost();
    var color = SEV_COLOR[n.severity] || SEV_COLOR.slight;
    var el = document.createElement('div');
    el.className = 'toast'; el.setAttribute('role', 'status');
    el.innerHTML =
      '<span class="toast-dot" style="background:' + color + '"></span>' +
      '<div class="toast-body"><div class="toast-lead">New report</div>' +
      '<div class="toast-text">' + summarize(n) + '</div></div>' +
      '<button class="toast-x" type="button" aria-label="Dismiss">×</button>';
    host.appendChild(el);
    // hard-remove the oldest beyond the cap — MUST be synchronous (the animated
    // dismiss is async, so a naive while-loop over children would never terminate)
    while (host.children.length > TOAST_MAX) {
      var oldest = host.firstChild; if (!oldest) break;
      if (oldest.__life) { clearTimeout(oldest.__life); oldest.__life = 0; }
      oldest.__dismissed = true;
      if (oldest.parentNode) oldest.parentNode.removeChild(oldest);
    }
    requestAnimationFrame(function () { el.classList.add('toast-in'); });
    el.__life = setTimeout(function () { dismissToast(el); }, TOAST_LIFE);
    var x = el.querySelector('.toast-x');
    if (x) x.addEventListener('click', function (ev) { ev.stopPropagation(); dismissToast(el); });
    el.addEventListener('click', function () { navigateToReport(n); dismissToast(el); });   // STEP 3: click the toast → navigate
  }

  /* --------------------------- panel + badge (STEP 2) --------------------- */
  function updateBadge() {
    var badge = document.getElementById('notifyBadge');
    if (!badge) return;
    if (unread > 0) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = false; }
    else { badge.hidden = true; }
  }
  // a subtle one-shot pop on the badge when a new report arrives; the CSS animation
  // is auto-disabled under prefers-reduced-motion by the app's global rule
  function bumpBadge() {
    var badge = document.getElementById('notifyBadge');
    if (!badge || badge.hidden || !badge.classList) return;
    badge.classList.remove('bump');
    if (typeof badge.offsetWidth === 'number') { void badge.offsetWidth; }   // reflow so the animation restarts on rapid arrivals
    badge.classList.add('bump');
  }

  function rowHtml(n) {
    var color = SEV_COLOR[n.severity] || SEV_COLOR.slight;
    return '<button class="notify-row' + (n.read ? '' : ' unread') + '" type="button" data-id="' + escapeHtml(n.id) + '">' +
      '<span class="notify-dot" style="background:' + color + '"></span>' +
      '<span class="notify-row-main"><span class="notify-row-text">' + summarize(n) + '</span></span>' +
      '<span class="notify-time">' + escapeHtml(relativeTime(n.ts)) + '</span>' +
    '</button>';
  }
  function renderList() {
    var list = document.getElementById('notifyList');
    if (!list) return;
    if (!items.length) { list.innerHTML = '<div class="notify-empty">No reports yet</div>'; return; }
    list.innerHTML = items.map(rowHtml).join('');
  }
  // STEP 3 (smoothness) — add ONE new row at the top without rebuilding the whole
  // list, so existing rows never flicker and the panel's scroll position is kept.
  function prependRow(n) {
    var list = document.getElementById('notifyList');
    if (!list) return;
    var html = list.innerHTML || '';
    if (!html || /notify-empty/.test(html)) { list.innerHTML = rowHtml(n); return; }   // replacing the empty state
    if (list.insertAdjacentHTML) list.insertAdjacentHTML('afterbegin', rowHtml(n));     // insert in place — old rows untouched
    else list.innerHTML = rowHtml(n) + html;
    // safety net: if many arrived while the panel stayed open, resync once to the cap
    if (list.querySelectorAll && list.querySelectorAll('.notify-row').length > MAX_ITEMS) renderList();
  }

  function markAllRead() {
    unread = 0;
    for (var i = 0; i < items.length; i++) { items[i].read = true; readSet[items[i].sig] = true; }
    saveReadState();   // remember these are seen, so refresh keeps them read
    persistItems();
    updateBadge();
  }
  function setPanel(open) {
    var panel = document.getElementById('notifyPanel');
    var bell = document.getElementById('notifyBell');
    if (!panel) return;
    panelOpen = open;
    panel.hidden = !open;
    if (bell) bell.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { markAllRead(); renderList(); }   // opening clears unread
  }

  /* STEP 3 — jump the map to a report: close the panel, switch to Map if needed,
     then fly + highlight + open the popup (via app.js CRASH_APP.focusReport). */
  function navigateToReport(n) {
    if (!n) return;
    setPanel(false);                              // close the panel after navigating
    var mapSection = document.getElementById('section-map');
    var onMap = !!(mapSection && mapSection.classList && mapSection.classList.contains('active'));
    if (!onMap) { var pill = document.querySelector('.pill[data-section="map"]'); if (pill) pill.click(); }
    var go = function () { if (window.CRASH_APP && window.CRASH_APP.focusReport) window.CRASH_APP.focusReport(n); };
    // let the Map section reveal + the map re-size before flying
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { requestAnimationFrame(go); });
    else setTimeout(go, 60);
  }

  /* ------------------------------ entry point ----------------------------- */
  function notify(report) {
    if (!report) return;
    var n = makeNotification(report);
    knownSigs[n.sig] = true;   // a surfaced report is never re-notified by the backend poll
    var beforeLen = items.length;
    items = items.filter(function (x) { return x.sig !== n.sig; });   // de-dupe by content
    var wasDup = items.length !== beforeLen;
    items.unshift(n);
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
    if (panelOpen) { n.read = true; readSet[n.sig] = true; saveReadState(); }   // already on screen
    showToast(n);
    unread = countUnread();
    updateBadge();
    // STEP 3 — smooth: add the one new row in place (no full rebuild → no flicker,
    // scroll preserved); only a rare content de-dupe needs a full re-render.
    if (panelOpen) { if (wasDup) renderList(); else prependRow(n); }
    else bumpBadge();          // subtle badge pop for a new arrival (reduced-motion-safe)
    persistItems();
  }

  /* STEP 4 — (re)build the panel from the authoritative reports app.js loaded on
     startup (localStorage AND/OR the backend GET /reports). Read/unread is restored
     from LS_STATE by signature; each report's "filed" time comes from the persisted
     list when known — so a refresh keeps seen reports read and only new ones unread. */
  function rebuildFromReports(reports) {
    if (!Array.isArray(reports)) reports = [];
    var persisted = loadPersistedMap();
    var seen = {}, built = [];
    for (var i = 0; i < reports.length; i++) {
      var r = reports[i]; if (!r) continue;
      var n = makeNotification(r);
      if (seen[n.sig]) continue; seen[n.sig] = true;
      knownSigs[n.sig] = true;          // every loaded report is "known" to the poll (even cleared ones), so it only surfaces reports added later
      if (clearedSet[n.sig]) continue;  // the user cleared this — keep it out of the panel across the refresh
      var prev = persisted[n.sig];
      n.ts = (prev && typeof prev.ts === 'number') ? prev.ts : (typeof r.ts === 'number' ? r.ts : Date.now());
      n.read = !!readSet[n.sig] || !!(prev && prev.read);
      built.push(n);
    }
    built.sort(function (a, b) { return b.ts - a.ts; });   // newest first
    items = built.slice(0, MAX_ITEMS);
    unread = countUnread();
    persistItems();
    updateBadge();
    renderList();
  }

  // restore last session's list immediately (before app.js announces reports)
  function restoreFromPersisted() {
    try {
      var arr = JSON.parse(localStorage.getItem(LS_LIST) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (n) { return n && n.sig && !clearedSet[n.sig]; }).map(function (n) {
        n.read = !!readSet[n.sig] || !!n.read; return n;
      }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, MAX_ITEMS);
    } catch (e) { return []; }
  }

  function clearAll() {
    // remember every currently-shown report as "cleared" so a refresh doesn't rebuild
    // it back into the panel (these reports still live in the backend / localStorage).
    for (var i = 0; i < items.length; i++) { clearedSet[items[i].sig] = true; knownSigs[items[i].sig] = true; }
    saveClearedSet();
    items = []; readSet = {}; unread = 0;
    // knownSigs is intentionally NOT reset — cleared reports stay cleared (the poll
    // won't re-surface them, and clearedSet keeps them out of the refresh rebuild).
    try { localStorage.removeItem(LS_LIST); localStorage.removeItem(LS_STATE); } catch (e) {}
    updateBadge(); renderList();
  }

  /* Reset the bell to an empty feed on every page load. Unlike clearAll this is not a
     user action, so it does NOT record cleared signatures — it just drops the panel and
     any stale persisted list. The poll's baseline pass then decides what counts as new. */
  function startFresh() {
    items = [];
    unread = 0;
    try { localStorage.removeItem(LS_LIST); } catch (e) {}   // stale session list — it is never replayed
    updateBadge();
    renderList();
  }

  /* ========================= STEP 2 — backend polling =====================
     Quietly poll GET /reports every ~8 s. Any report whose content signature we
     haven't surfaced yet is pushed through notify() (toast + badge + list), so a
     report filed on ANOTHER device shows up here live — updating ONLY this
     component, never the page. Fails silently when the backend is unreachable,
     never stacks requests or intervals, and never re-notifies a known report. */
  var POLL_MS = 8000;        // background poll cadence
  var POLL_TIMEOUT = 6000;   // abort a slow request so a poll never stacks on the next
  var pollTimer = 0, pollStarted = false, pollInFlight = false;
  // false until the FIRST successful poll has recorded everything already in the DB.
  // That baseline pass seeds knownSigs WITHOUT toasting, so pre-existing reports never
  // appear as "just now" on load — only reports first seen in LATER polls count as new.
  var baselineSeeded = false;
  // only poll when the app is served by the backend (the single-origin shell)
  var POLL_ENABLED = (typeof window !== 'undefined' && window.CRASH_SHELL === true);

  // a backend /reports row (the 8 report fields + a Mongo _id) -> a notify()-able report
  function fromBackend(r) {
    return {
      id: r._id ? ('m' + r._id) : (r.id || undefined),
      lat: r.lat, lng: r.lng, severity: r.severity, datetime: r.datetime,
      weather: r.weather, cause: r.cause, vehicle: r.vehicle, area: r.area,
    };
  }

  function pollBackend() {
    if (pollInFlight || typeof fetch !== 'function') return Promise.resolve();
    pollInFlight = true;
    var API = (typeof window !== 'undefined' && window.API_BASE) || '';
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, POLL_TIMEOUT) : 0;
    return fetch(API + '/reports', { signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (resp) {
        if (timer) clearTimeout(timer);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        pollInFlight = false;
        if (!Array.isArray(data)) return;
        // genuinely-new reports (by content signature), kept in backend order (oldest
        // first) so the newest lands on top of the list after each unshift
        var fresh = [];
        for (var i = 0; i < data.length; i++) {
          var r = data[i];
          if (!r || !isFinite(Number(r.lat)) || !isFinite(Number(r.lng))) continue;
          var sig = signature(r);
          if (knownSigs[sig] || clearedSet[sig]) continue;   // already surfaced, or explicitly cleared
          knownSigs[sig] = true;
          if (baselineSeeded) fresh.push(r);   // before the baseline exists, just record what's already there (no toast)
        }
        baselineSeeded = true;                 // first successful poll defines "already existed" — nothing above toasts
        for (var j = 0; j < fresh.length; j++) notify(fromBackend(fresh[j]));
      })
      .catch(function () { if (timer) clearTimeout(timer); pollInFlight = false; /* silent — keep using local data */ });
  }

  function startPolling() {
    if (pollStarted || !POLL_ENABLED) return;
    pollStarted = true;
    if (pollTimer) clearInterval(pollTimer);   // never stack intervals
    pollBackend();                             // immediate pass baselines what already exists (no toasts), fast
    pollTimer = setInterval(pollBackend, POLL_MS);
  }
  function stopPolling() { if (pollTimer) clearInterval(pollTimer); pollTimer = 0; pollStarted = false; }

  function initPanel() {
    var bell = document.getElementById('notifyBell');
    if (bell) bell.addEventListener('click', function (e) { e.stopPropagation(); setPanel(!panelOpen); });
    var panel = document.getElementById('notifyPanel');
    if (panel) panel.addEventListener('click', function (e) { e.stopPropagation(); });
    var list = document.getElementById('notifyList');
    if (list) list.addEventListener('click', function (e) {       // STEP 3: click a row → navigate
      var row = e.target && e.target.closest ? e.target.closest('.notify-row') : null;
      if (!row) return;
      var id = row.getAttribute('data-id'), n = null;
      for (var i = 0; i < items.length; i++) if (items[i].id === id) { n = items[i]; break; }
      if (n) navigateToReport(n);
    });
    var clearBtn = document.getElementById('notifyClear');
    if (clearBtn) clearBtn.addEventListener('click', function (e) { e.stopPropagation(); clearAll(); });
    document.addEventListener('click', function () { if (panelOpen) setPanel(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panelOpen) setPanel(false); });
    updateBadge();
    renderList();
  }

  // LIVE-FEED model: the bell always starts EMPTY on a page load/refresh. Old reports
  // already in the DB are NOT replayed into the panel — doing that dumped the whole
  // history back in stamped "just now", burying the report that actually just arrived.
  // The first successful poll silently baselines what already exists (see baselineSeeded);
  // only reports seen in later polls are surfaced as new.
  readSet = loadReadState();
  clearedSet = loadClearedSet();   // still used to keep an explicitly-cleared report out of the live poll
  items = [];
  unread = 0;

  document.addEventListener('crash:report', function (e) { if (e && e.detail) notify(e.detail); });
  // app.js fires this once on startup. We deliberately do NOT rebuild the panel from the
  // loaded reports (that caused old notifications to reappear as "just now"). Instead we
  // clear to an empty feed and start the live poll, whose first pass baselines the DB.
  document.addEventListener('crash:reports-loaded', function () { startFresh(); startPolling(); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel);
  else initPanel();

  window.CRASH_NOTIFY = {
    notify: notify,
    toast: showToast,
    rebuild: rebuildFromReports,
    clear: clearAll,
    open: function () { setPanel(true); },
    close: function () { setPanel(false); },
    toggle: function () { setPanel(!panelOpen); },
    list: function () { return items.slice(); },
    unread: function () { return unread; },
    isOpen: function () { return panelOpen; },
    readState: function () { return Object.keys(readSet); },
    relativeTime: relativeTime,
    navigate: navigateToReport,
    poll: pollBackend,            // STEP 2 — run one backend poll now (returns a promise)
    startPolling: startPolling,   // begin the ~8s background poll (auto-started on boot)
    stopPolling: stopPolling,
  };
})();
