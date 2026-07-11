/* =============================================================================
   Shared MapTiler base layer — the ONE place the tile source + key live.
   Every Leaflet map in the app (main map, C.R.A.S.H Bot, Simulate, the report form
   + fullscreen picker, and the landing hero) calls addBaseLayer(map). The base map
   follows the app's light/dark theme (MapTiler streets-v2 / streets-v2-dark); a
   theme-toggle handler calls refreshBaseLayer(layer) to re-point an existing layer.
   Rotate the key here and it changes on every map. Only the base tiles come from
   here — markers, hotspots, hospitals, popups and controls are untouched.
   ========================================================================== */
const MAPTILER_KEY = "UmXaLmDZXmANQ9fODGZU";
function maptilerTileUrl() {
  const style = document.documentElement.getAttribute('data-theme') === 'dark' ? 'streets-v2-dark' : 'streets-v2';
  return `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`;
}
function addBaseLayer(map) {
  return L.tileLayer(maptilerTileUrl(), {
    tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 20, crossOrigin: true,
    attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>'
  }).addTo(map);
}
/* re-point an existing base layer to the current theme's style (call on theme toggle) */
function refreshBaseLayer(layer) {
  if (layer && layer.setUrl) layer.setUrl(maptilerTileUrl());
}
