/* =============================================================================
   CRASH — Shared constants
   Single source of truth for all domain constants used across the app.
   Loaded first, exposes via window.CRASH_CONSTANTS.
   ========================================================================== */
(function (root) {
  'use strict';

  // Canonical severity object with full property names
  const SEV_CANONICAL = {
    fatal:   { color: '#BE2F2A', label: 'Fatal',   weight: 3 },
    serious: { color: '#CE8A2E', label: 'Serious', weight: 2 },
    slight:  { color: '#E7C64B', label: 'Slight',  weight: 1 },
  };

  // Backward-compat aliases for analytics.js, compare.js, etc. (use .c, .l, .w)
  const SEV = Object.freeze({
    fatal:   Object.assign({}, SEV_CANONICAL.fatal,   { c: SEV_CANONICAL.fatal.color,   l: SEV_CANONICAL.fatal.label,   w: SEV_CANONICAL.fatal.weight }),
    serious: Object.assign({}, SEV_CANONICAL.serious, { c: SEV_CANONICAL.serious.color, l: SEV_CANONICAL.serious.label, w: SEV_CANONICAL.serious.weight }),
    slight:  Object.assign({}, SEV_CANONICAL.slight,  { c: SEV_CANONICAL.slight.color,  l: SEV_CANONICAL.slight.label,  w: SEV_CANONICAL.slight.weight }),
  });

  // Also expose canonical names for new code
  SEV.fatal.color = SEV_CANONICAL.fatal.color;
  SEV.fatal.label = SEV_CANONICAL.fatal.label;
  SEV.fatal.weight = SEV_CANONICAL.fatal.weight;
  SEV.serious.color = SEV_CANONICAL.serious.color;
  SEV.serious.label = SEV_CANONICAL.serious.label;
  SEV.serious.weight = SEV_CANONICAL.serious.weight;
  SEV.slight.color = SEV_CANONICAL.slight.color;
  SEV.slight.label = SEV_CANONICAL.slight.label;
  SEV.slight.weight = SEV_CANONICAL.slight.weight;

  /* The three real severities, and the ONLY safe way to test one.
     `severity` reaches the frontend from POST /report and is attacker-controlled,
     so a bare `SEV[severity]` truthiness check is unsafe: it also resolves
     inherited Object.prototype members, so severity:"toString" passes the guard
     and then leaks a *function* into the arithmetic. Always use isSeverity(),
     and use sevOf() when you need the descriptor with a safe fallback. */
  const SEVERITIES = ['fatal', 'serious', 'slight'];
  function isSeverity(s) { return SEVERITIES.indexOf(s) !== -1; }
  function sevOf(s) { return isSeverity(s) ? SEV[s] : SEV.slight; }

  /* The four controlled vocabularies, mirroring backend/main.py's AREAS, CAUSES,
     VEHICLES and WEATHERS exactly. tests/js/report-validation.test.js asserts they
     stay equal to the values actually present in data/accidents.json, which
     tests/backend/test_baseline_contract.py already pins to the backend — so the
     two ends cannot drift apart without a test going red.

     These exist so the FRONTEND can be as strict as the backend. POST /report
     validates every one of these fields, but a report can also reach the engines
     from localStorage or from a document written before those validators landed,
     and the frontend validators only checked `typeof x === 'string'`. A value
     outside the vocabulary is not a cosmetic problem here: it becomes an object
     KEY in the grid/aggregate accumulators, and `area:"__proto__"` or an unknown
     `weather` then crashes the ranking engine and the analytics page outright. */
  const AREAS = [
    'Adyar', 'Ambattur', 'Anna Nagar', 'Avadi',
    'Chromepet', 'Egmore', 'Guindy', 'Kattankulathur',
    'Koyambedu', 'Maduravoyal', 'Medavakkam', 'Mylapore',
    'Nandanam', 'Nungambakkam', 'Padi', 'Pallavaram',
    'Perambur', 'Perungudi', 'Poonamallee', 'Porur',
    'Saidapet', 'Sholinganallur', 'T. Nagar', 'Tambaram',
    'Teynampet', 'Thiruvanmiyur', 'Thoraipakkam', 'Vadapalani',
    'Vandalur', 'Velachery',
  ];
  const CAUSES = [
    'Over-speeding', 'Wrong-side driving', 'Signal jumping', 'Drunken driving',
    'Mobile phone use', 'Hit and run', 'Pothole / bad road', 'Pedestrian crossing error',
    'Improper overtaking', 'Vehicle defect', 'Poor visibility'
  ];
  const VEHICLES = [
    'Two-wheeler', 'Car', 'Auto-rickshaw', 'Bus (MTC/Private)',
    'Lorry / Truck', 'LCV / Van', 'Bicycle', 'Unknown (fled)'
  ];
  const WEATHERS = ['clear', 'rain', 'fog'];

  /* indexOf, never `OBJ[value]` — same reason as isSeverity above: a bare lookup
     also resolves inherited Object.prototype members, so "toString" and
     "constructor" would pass a truthiness guard. */
  function isArea(v) { return AREAS.indexOf(v) !== -1; }
  function isCause(v) { return CAUSES.indexOf(v) !== -1; }
  function isVehicle(v) { return VEHICLES.indexOf(v) !== -1; }
  function isWeather(v) { return WEATHERS.indexOf(v) !== -1; }

  const CONSTANTS = {
    // Severity weights, colors, labels — used by map, charts, PDF, bot, simulate
    SEV,
    SEVERITIES,
    isSeverity,
    sevOf,

    // Flat arrays for dropdowns / filters / legends
    AREAS,
    CAUSES,
    VEHICLES,
    WEATHERS,

    // Vocabulary membership tests — the trust boundary for a citizen report
    isArea,
    isCause,
    isVehicle,
    isWeather,

    // Chennai bounding box (~250 m grid)
    BBOX: { latMin: 12.80, latMax: 13.22, lngMin: 80.03, lngMax: 80.32 },
    CELL: 0.0022,

    // Hotspot engine tuning
    TOP_N: 10,
    SUPPRESS: 2,
    HIGH_RISK_MIN: 40,
    SELECT_ZOOM: 15,

    // Emerging-hotspot engine
    RECENT_MONTHS: 6,

    // Longest analysis window, in months. The shipped dataset spans exactly 24
    // (Jul 2024 - Jun 2026). Clamping here stops one citizen report with a stray
    // date from stretching the window and corrupting every per-month figure.
    MAX_WINDOW_MONTHS: 24,
    EMERGE_LIFT: 1.5,
    EMERGE_MIN_RECENT: 8,
    EMERGE_TOP_N: 6,

    // Time/date labels
    MON: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    DOW: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],

    // Segmented filter definitions (map page)
    SEGMENTS: {
      source:  { id: 'segSource',  options: [['All', 'all'], ['Official only', 'official'], ['Citizen only', 'citizen']] },
      sev:     { id: 'segSev',     options: [['All', 'all'], ['Fatal + serious', 'fs'], ['Fatal', 'f']] },
      time:    { id: 'segTime',    options: [['All', 'all'], ['Day', 'day'], ['Night', 'night']] },
      weather: { id: 'segWeather', options: [['All', 'all'], ['Clear', 'clear'], ['Rain', 'rain'], ['Fog', 'fog']] },
      dow:     { id: 'segDow', chips: true, options: [['All', 'all'], ['Mon', 0], ['Tue', 1], ['Wed', 2], ['Thu', 3], ['Fri', 4], ['Sat', 5], ['Sun', 6]] },
    },

    // Chart color palette (CSS variable fallbacks)
    CHART_COLORS: {
      accent:  '#2F5C87',
      day:     '#5F7488',
      night:   '#33475C',
      fatal:   '#BE2F2A',
      serious: '#CE8A2E',
      slight:  '#E7C64B',
    },
  };

  root.CRASH_CONSTANTS = CONSTANTS;
})(typeof window !== 'undefined' ? window : this);