/* =============================================================================
   Shared MapTiler base layer — the ONE place the tile source + key live.
   Every Leaflet map in the app (main map, C.R.A.S.H Bot, Simulate, the report form
   + fullscreen picker, and the landing hero) calls addBaseLayer(map). The base map
   follows the app's light/dark theme (MapTiler streets-v2 / streets-v2-dark); a
   theme-toggle handler calls refreshBaseLayer(layer) to re-point an existing layer.
   Rotate the key here and it changes on every map. Only the base tiles come from
   here — markers, hotspots, hospitals, popups and controls are untouched.
   ========================================================================== */
/* SECURITY NOTE (audit finding F028) — this key is PUBLIC by design.
   The browser fetches tiles directly from api.maptiler.com, so the key is
   delivered to every visitor and is visible in DevTools no matter where it is
   stored. Moving it to a config file, an env var or the server would NOT hide it;
   the only real control is a restriction on MapTiler's side.

   REQUIRED: in your MapTiler account, restrict this key to the deployed Render
   domain plus http://localhost:8000, and rotate it if it has ever been used
   without that restriction. This repository is public, so the key has been
   readable in git history since it was committed.
   Rotate it here and it changes on every map in the app. */
const MAPTILER_KEY = "aUQhU1ucLnL8szHxVGoB";
function maptilerTileUrl() {
  const style = document.documentElement.getAttribute('data-theme') === 'dark' ? 'streets-v2-dark' : 'streets-v2';
  // {r} becomes "@2x" on high-density screens: MapTiler then sends 1024px tiles for each
  // 512px slot instead of upscaling 512px ones, which is what made the map look soft.
  return `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`;
}
function addBaseLayer(map) {
  return L.tileLayer(maptilerTileUrl(), {
    tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 20, crossOrigin: true, keepBuffer: 4,
    // rel="noopener noreferrer" on both: target="_blank" without it hands the
    // opened page a window.opener handle back into this tab.
    attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>'
  }).addTo(map);
}
/* re-point an existing base layer to the current theme's style (call on theme toggle) */
function refreshBaseLayer(layer) {
  if (layer && layer.setUrl) layer.setUrl(maptilerTileUrl());
}

/* ---- Chennai-only view ---------------------------------------------------------
   The data covers 12.82-13.13N, 80.04-80.28E. The limit is that box plus a ~3 km margin.
   limitToChennai(map): the map cannot be panned out of the city, and cannot be zoomed out
   further than the level at which the city fills the view, so nothing outside is visible.
   The main, bot and simulate maps do their own framing; this is for the others. */
function chennaiLimit() { return L.latLngBounds([12.77, 80.00], [13.25, 80.35]); }
function inChennai(lat, lng) { return chennaiLimit().contains([lat, lng]); }
function limitToChennai(map) {
  const b = chennaiLimit();
  map.setMaxBounds(b);
  map.options.maxBoundsViscosity = 1.0;      // hard stop at the edge, no rubber-banding out
  const fill = function () {
    const s = map.getSize();
    if (s.x > 0 && s.y > 0) map.setMinZoom(map.getBoundsZoom(b, true));   // true = the level where b fills the view
  };
  fill();
  map.on('resize', fill);                    // fullscreen / rotate / window resize change that level
  return map;
}
