/* =============================================================================
   CRASH — Shared utility functions.
   Pure helpers with no page-specific or business-logic dependencies.
   Exposes both CRASH_UTILS (full) and CU (shorthand for inline scripts).
   Must be loaded after shared/constants.js but before any app JS file.
   ========================================================================== */
(function (root) {
  'use strict';

  /* ---- Number formatting ---- */
  function fmt(n) { return Number(n).toLocaleString('en-US'); }

  /* ---- Sort object by values descending, return entries ---- */
  function sortedEntries(o) { return Object.entries(o).sort(function (a, b) { return b[1] - a[1]; }); }

  /* ---- Zero-pad a number to 2 digits ---- */
  function pad2(n) { return String(n).padStart(2, '0'); }

  /* ---- percentage: value / total * 100 ---- */
  function pct(v, t) { return Math.round(100 * v / (t || 1)) + '%'; }

  /* ---- Get hour (0–23) from "YYYY-MM-DD HH:MM" string ---- */
  function hourOf(dt) { return parseInt(String(dt).slice(11, 13), 10); }

  /* ---- Night check: hour < 6 or >= 18 ---- */
  function isNight(dt) { var h = hourOf(dt); return h < 6 || h >= 18; }

  /* ---- HTML-escape a string (null-safe, covers & < > ") ---- */
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---- CSS custom-property reader ---- */
  function cssv(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  /* ---- Current theme: 'light' or 'dark' ---- */
  function currentTheme() { return (document.documentElement.getAttribute('data-theme') || 'light') === 'light' ? 'light' : 'dark'; }

  /* ---- Hex colour string → { r, g, b } object ---- */
  function hexToRgb(h) {
    h = (h || '').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  /* ---- Hex colour string → "rgba(r,g,b,a)" string ---- */
  function rgba(hex, a) { var c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }

  /* ---- Read the full theme palette from CSS custom properties ---- */
  function palette() {
    return {
      text: cssv('--text'), text2: cssv('--text-2'), text3: cssv('--text-3'),
      grid: cssv('--track'), border: cssv('--border'),
      accent: cssv('--accent'), accent2: cssv('--accent-2'),
      day: cssv('--chart-day'), night: cssv('--chart-night'),
      panel: cssv('--panel'), bg: cssv('--bg'),
      a: cssv('--cmpA'), b: cssv('--cmpB'),
    };
  }

  var U = {
    fmt: fmt,
    sortedEntries: sortedEntries,
    pad2: pad2,
    pct: pct,
    hourOf: hourOf,
    isNight: isNight,
    escapeHtml: escapeHtml,
    cssv: cssv,
    currentTheme: currentTheme,
    hexToRgb: hexToRgb,
    rgba: rgba,
    palette: palette,
  };

  root.CRASH_UTILS = U;
  root.CU = U;

})(typeof window !== 'undefined' ? window : this);
