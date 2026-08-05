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
const MAPTILER_KEY = "UmXaLmDZXmANQ9fODGZU";
function maptilerTileUrl() {
  const style = document.documentElement.getAttribute('data-theme') === 'dark' ? 'streets-v2-dark' : 'streets-v2';
  return `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`;
}
function addBaseLayer(map) {
  return L.tileLayer(maptilerTileUrl(), {
    tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 20, crossOrigin: true,
    // rel="noopener noreferrer" on both: target="_blank" without it hands the
    // opened page a window.opener handle back into this tab.
    attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>'
  }).addTo(map);
}
/* re-point an existing base layer to the current theme's style (call on theme toggle) */
function refreshBaseLayer(layer) {
  if (layer && layer.setUrl) layer.setUrl(maptilerTileUrl());
}
