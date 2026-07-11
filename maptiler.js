/* =============================================================================
   Shared MapTiler base layer — the ONE place the tile source + key live.
   Every Leaflet map in the app (main map, C.R.A.S.H Bot, Simulate, the report form
   + fullscreen picker, and the landing hero) calls addBaseLayer(map). Rotate the
   key here and it changes on every map. Only the base tiles come from here —
   markers, hotspots, hospitals, popups and controls are untouched.
   ========================================================================== */
const MAPTILER_KEY = "UmXaLmDZXmANQ9fODGZU";
function addBaseLayer(map) {
  return L.tileLayer(`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
    tileSize: 512, zoomOffset: -1, minZoom: 1, maxZoom: 20, crossOrigin: true,
    attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>'
  }).addTo(map);
}
