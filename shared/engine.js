/* =============================================================================
   CRASH — Shared computational engines.
   Pure computational logic: cell gridding, hotspot ranking, emerging detection.
   No DOM, no rendering, no Chart.js. All dependencies passed as parameters.
   Exposed via window.CRASH_ENGINE / window.CE.
   Must be loaded after shared/constants.js and shared/utils.js.
   ========================================================================== */
(function (root) {
  'use strict';

  /* The three real severities. Kept as a list, and every lookup below goes
     through hasSeverity(), because `severity` arrives from POST /report and is
     therefore attacker-controlled: a plain `OBJ[severity]` lookup also resolves
     inherited Object.prototype members ("toString", "constructor", …), which
     used to leak a *function* into the arithmetic and the cell accumulator. */
  var SEVERITIES = ['fatal', 'serious', 'slight'];
  function hasSeverity(s) { return SEVERITIES.indexOf(s) !== -1; }

  var DEFAULT_WEIGHT = { fatal: 3, serious: 2, slight: 1 };
  function defWeight(s) { return hasSeverity(s) ? DEFAULT_WEIGHT[s] : 1; }

  /* ---- Non-max suppression helper (shared by topJunctions & computeEmerging) ---- */
  function nmsFilter(candidates, topN, suppress) {
    var pick = [];
    for (var i = 0; i < candidates.length; i++) {
      if (pick.length >= topN) break;
      var c = candidates[i];
      var clash = pick.some(function (p) { return Math.abs(p.ci - c.ci) <= suppress && Math.abs(p.cj - c.cj) <= suppress; });
      if (!clash) pick.push(c);
    }
    return pick;
  }

  /* ---- Augment records with fast-filter fields ---- */
  /* Mutates records in-place. Returns { minYM, monthCount, lastMonth }.

     The window is anchored to the NEWEST record and clamped to maxMonths. It used
     to run from the OLDEST record, so a single citizen report with an old date
     stretched it without limit: one report dated 2015 took monthCount from 24 to
     138. Everything downstream is divided by that number, so the "avg per month"
     KPI read 74 instead of 424 — a 5.7x understatement — the month axis label
     read "138 mo", and the sparkline tried to draw 138 bars in a 32px strip.
     Anchoring to the newest record keeps a stray date from moving any of it. */
  function precompute(records, maxMonths) {
    var cap = (typeof maxMonths === 'number' && maxMonths > 0) ? maxMonths : Infinity;
    var minYM = Infinity, maxYM = -Infinity;
    for (var i = 0; i < records.length; i++) {
      var a = records[i];
      a._h = parseInt(a.datetime.slice(11, 13), 10);
      a._night = a._h < 6 || a._h >= 18;
      var d = a.datetime.slice(0, 10).split('-');
      a._dow = (new Date(+d[0], +d[1] - 1, +d[2]).getDay() + 6) % 7;
      a._ym = (+d[0]) * 12 + (+d[1] - 1);
      if (a._ym < minYM) minYM = a._ym;
      if (a._ym > maxYM) maxYM = a._ym;
    }
    if (!records.length) return { minYM: 0, monthCount: 1, lastMonth: 0 };
    var span = maxYM - minYM + 1;
    var monthCount = Math.min(span, cap);
    minYM = maxYM - monthCount + 1;   // anchor on the NEWEST record, not the oldest
    var lastMonth = monthCount - 1;
    for (var j = 0; j < records.length; j++) {
      records[j]._month = records[j]._ym - minYM;
    }
    return { minYM: minYM, monthCount: monthCount, lastMonth: lastMonth };
  }

  /* ---- Month range for a set of records ---- */
  function monthMeta(records) {
    var mn = Infinity, mx = -Infinity;
    for (var i = 0; i < records.length; i++) {
      var a = records[i];
      var ym = (+a.datetime.slice(0, 4)) * 12 + (+a.datetime.slice(5, 7) - 1);
      if (ym < mn) mn = ym;
      if (ym > mx) mx = ym;
    }
    return { min: mn, max: mx, count: mx - mn + 1 };
  }

  /* ---- Grid cells: partition records into ~250 m cells ---- */
  /* weightFn(severity) returns the severity weight (default: fatal=3, serious=2, slight=1).
     Pass monthCount to enable months-array tracking. */
  function gridCells(records, BBOX, CELL, RECENT_MONTHS, monthCount, weightFn) {
    if (!weightFn) weightFn = defWeight;
    var map = new Map();
    var hasMonths = typeof monthCount === 'number' && monthCount > 0;
    var recentCut = hasMonths ? monthCount - 1 - RECENT_MONTHS : -1;
    for (var i = 0; i < records.length; i++) {
      var a = records[i];
      var ci = Math.floor((a.lat - BBOX.latMin) / CELL);
      var cj = Math.floor((a.lng - BBOX.lngMin) / CELL);
      var k = ci + '_' + cj;
      var c = map.get(k);
      if (!c) {
        c = { key: k, ci: ci, cj: cj, count: 0, score: 0,
              fatal: 0, serious: 0, slight: 0, night: 0,
              areas: {}, cause: {},
              recent: 0, baseline: 0, recentScore: 0,
              rF: 0, rS: 0, rL: 0,
              sumLat: 0, sumLng: 0, months: null };
        if (hasMonths) c.months = new Array(monthCount).fill(0);
        map.set(k, c);
      }
      c.count++;
      var w = weightFn(a.severity);
      if (typeof w !== 'number' || !isFinite(w)) w = 1;   // a caller's weightFn must not poison the score
      c.score += w;
      // Only ever write one of the three known severity fields. Writing
      // c[a.severity] blindly let a crafted report overwrite count/score/key/lat.
      if (hasSeverity(a.severity)) c[a.severity]++;
      if (a._night) c.night++;
      c.areas[a.area] = (c.areas[a.area] || 0) + 1;
      c.cause[a.cause] = (c.cause[a.cause] || 0) + 1;
      if (hasMonths && a._month >= 0 && a._month < monthCount) c.months[a._month]++;
      if (hasMonths && a._month > recentCut) {
        c.recent++;
        c.recentScore += w;
        if (a.severity === 'fatal') c.rF++; else if (a.severity === 'serious') c.rS++; else c.rL++;
      } else if (hasMonths) {
        c.baseline++;
      }
      c.sumLat += a.lat;
      c.sumLng += a.lng;
    }
    var arr = [];
    map.forEach(function (v) {
      var topArea = '';
      var areaKeys = Object.keys(v.areas);
      if (areaKeys.length) {
        areaKeys.sort(function (a, b) { return v.areas[b] - v.areas[a]; });
        topArea = areaKeys[0];
      }
      v.area = topArea;
      v.lat = v.sumLat / v.count;
      v.lng = v.sumLng / v.count;
      arr.push(v);
    });
    return arr;
  }

  /* ---- Top N junctions: sort by score desc, NMS, normalize 0-100 ---- */
  /* Returns cells sorted by score+count with .norm added. */
  function topJunctions(cells, TOP_N, SUPPRESS) {
    var byScore = cells.slice().sort(function (a, b) {
      return b.score - a.score || b.count - a.count;
    });
    var pick = nmsFilter(byScore, TOP_N, SUPPRESS);
    var topRaw = pick.length ? pick[0].score : 1;
    for (var i = 0; i < pick.length; i++) {
      pick[i].norm = Math.max(1, Math.round(100 * Math.pow(pick[i].score / topRaw, 0.6)));
    }
    return pick;
  }

  /* ---- Emerging-hotspot detection ---- */
  /* Cells must already have .recent, .baseline, .recentScore computed (gridCells does this). */
  function computeEmerging(cells, RECENT_MONTHS, monthCount, EMERGE_MIN_RECENT, EMERGE_LIFT, EMERGE_TOP_N, SUPPRESS) {
    var baseMonths = Math.max(1, monthCount - RECENT_MONTHS);
    var cand = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.recent < EMERGE_MIN_RECENT) continue;
      var rr = c.recent / RECENT_MONTHS;
      var br = c.baseline / baseMonths;
      var lift = br > 0 ? rr / br : 3;
      if (lift < EMERGE_LIFT) continue;
      var area = '';
      if (c.areas) {
        var top = Object.keys(c.areas).sort(function (a, b) { return c.areas[b] - c.areas[a]; });
        area = top[0] || '';
      }
      var n = (c.recent + c.baseline) || c.count || 1;
      cand.push({
        id: c.key, area: area, ci: c.ci, cj: c.cj,
        lat: (c.lat != null ? c.lat : (c.sumLat || 0) / n),
        lng: (c.lng != null ? c.lng : (c.sumLng || 0) / n),
        months: c.months || [],
        recent: c.recent, baseline: c.baseline,
        recentRate: rr, baseRate: br,
        lift: lift,
        pct: Math.round((lift - 1) * 100),
        pctIncrease: Math.round((lift - 1) * 100),
        priority: c.recentScore * (lift - 1),
        rF: c.rF || 0, rS: c.rS || 0, rL: c.rL || 0,
      });
    }
    cand.sort(function (a, b) { return b.priority - a.priority; });
    var picked = nmsFilter(cand, EMERGE_TOP_N, SUPPRESS);
    // How many cells actually QUALIFY, before the display cap. Callers that show
    // a count must use this: `emerging.length` is the length of a list truncated
    // to EMERGE_TOP_N (6), so a KPI built from it was structurally incapable of
    // exceeding 6 while 25 cells genuinely qualified.
    picked.qualifyingCount = nmsFilter(cand, Infinity, SUPPRESS).length;
    return picked;
  }

  var E = {
    precompute: precompute,
    monthMeta: monthMeta,
    gridCells: gridCells,
    topJunctions: topJunctions,
    computeEmerging: computeEmerging,
  };

  root.CRASH_ENGINE = E;
  root.CE = E;

})(typeof window !== 'undefined' ? window : this);
