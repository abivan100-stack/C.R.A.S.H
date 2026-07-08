/* =============================================================================
   Shared intervention model (Phase 3)
   Used by BOTH the dashboard (app.js) and the analytics page (analytics.js) so
   recommended fixes, capital-cost tiers and impact estimates never diverge.

   For a zone, the DOMINANT cause selects an engineering / enforcement fix, a
   capital-cost tier, and an ESTIMATED reduction in that zone's severe
   (fatal + serious) incidents. The effectiveness figures are indicative
   planning estimates for prioritisation — not measured post-implementation
   outcomes — and every surface that shows them says so.
   Exposes a global: CRASH_INTERVENTIONS.
   ========================================================================== */
(function (root) {
  'use strict';

  // cause -> { fix, cost tier, eff = fraction of severe incidents avoidable }
  var BY_CAUSE = {
    'Over-speeding':             { fix: 'Speed humps and speed-enforcement cameras on the approaches', cost: 'Medium', eff: 0.35 },
    'Signal jumping':            { fix: 'Automated red-light enforcement camera at the signal',        cost: 'Medium', eff: 0.30 },
    'Pothole / bad road':        { fix: 'Road resurfacing and improved drainage',                      cost: 'High',   eff: 0.25 },
    'Drunken driving':           { fix: 'Night-time enforcement checkpoints',                          cost: 'Low',    eff: 0.28 },
    'Pedestrian crossing error': { fix: 'Signalised pedestrian crossing or foot overbridge',           cost: 'High',   eff: 0.35 },
    'Improper overtaking':       { fix: 'Lane-discipline markings, median barrier and no-overtaking signage', cost: 'Medium', eff: 0.25 },
    'Mobile phone use':          { fix: 'Rumble strips, distraction-warning signage and stepped-up enforcement', cost: 'Low', eff: 0.18 },
    'Wrong-side driving':        { fix: 'Median barriers and one-way channelisation with signage',     cost: 'Medium', eff: 0.30 },
    'Vehicle defect':            { fix: 'Vehicle fitness-check drive and improved junction lighting',  cost: 'Low',    eff: 0.15 },
    'Poor visibility':           { fix: 'Improved lighting, reflective road markings and fog-warning signage', cost: 'Medium', eff: 0.20 },
  };
  var NIGHT    = { fix: 'CCTV surveillance and continuous street lighting', cost: 'Medium', eff: 0.22 };
  var DEFAULT  = { fix: 'Junction redesign and signage review',            cost: 'High',   eff: 0.20 };
  var COST_RANK = { Low: 1, Medium: 2, High: 3 };

  /* Precedence mirrors the original dashboard logic: a handful of causes map to
     a specific fix first; otherwise a night-heavy or hit-and-run zone gets
     lighting + CCTV; then the remaining causes; then a generic redesign. */
  function pick(cause, nightShare) {
    if (cause === 'Over-speeding')      return BY_CAUSE['Over-speeding'];
    if (cause === 'Signal jumping')     return BY_CAUSE['Signal jumping'];
    if (cause === 'Pothole / bad road') return BY_CAUSE['Pothole / bad road'];
    if (cause === 'Hit and run' || (nightShare || 0) > 0.55) return NIGHT;
    if (BY_CAUSE[cause]) return BY_CAUSE[cause];
    return DEFAULT;
  }

  /* Estimated preventable SEVERE incidents for a zone over the record window.
     Weights fatalities above serious injuries (3:1, matching the risk score)
     then scales by the fix's effectiveness. */
  function preventable(fatal, serious, eff) {
    return Math.round((fatal * 3 + serious) * eff);
  }

  root.CRASH_INTERVENTIONS = {
    byCause: BY_CAUSE, night: NIGHT, fallback: DEFAULT, costRank: COST_RANK,
    pick: pick, preventable: preventable,
  };
})(typeof window !== 'undefined' ? window : this);
