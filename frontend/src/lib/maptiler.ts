/* Leaflet + vendored basemap helpers. One place the tile URL and key live, as in
   the legacy maptiler.js: every map in the app calls addBaseLayer(map, theme). */

const MAPTILER_KEY = 'aUQhU1ucLnL8szHxVGoB';

export type Theme = 'light' | 'dark';

/* eslint-disable @typescript-eslint/no-explicit-any */
type LeafletMap = any;
type LeafletLayer = any;

export function maptilerTileUrl(theme: Theme): string {
  const style = theme === 'dark' ? 'streets-v2-dark' : 'streets-v2';
  /* {r} becomes @2x on high-density screens: MapTiler then sends 1024px tiles. */
  return `https://api.maptiler.com/maps/${style}/{z}/{x}/{y}{r}.png?key=${MAPTILER_KEY}`;
}

export function chennaiLimit(): unknown {
  return L.latLngBounds([12.77, 80.0], [13.25, 80.35]);
}

export function addBaseLayer(map: LeafletMap, theme: Theme): LeafletLayer {
  const layer = L.tileLayer(maptilerTileUrl(theme), {
    tileSize: 512,
    zoomOffset: -1,
    minZoom: 1,
    maxZoom: 20,
    crossOrigin: true,
    keepBuffer: 4,
    attribution:
      '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">MapTiler</a> ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>',
  }).addTo(map);

  /* Leaflet 1.9.4's redraw() asks for tiles at the RAW zoom. Fractional-zoom maps
     then request z=9.8, which MapTiler answers with 404 after a theme switch.
     Same steps as Leaflet's redraw() with the zoom rounded the way _setView does. */
  layer.redraw = function redraw(this: LeafletLayer): LeafletLayer {
    if (this._map) {
      this._removeAllTiles();
      const z = this._clampZoom(Math.round(this._map.getZoom()));
      if (z !== this._tileZoom) {
        this._tileZoom = z;
        this._updateLevels();
      }
      this._update();
    }
    return this;
  };
  return layer;
}

export function refreshBaseLayer(layer: LeafletLayer | null, theme: Theme): void {
  if (layer && typeof layer.setUrl === 'function') layer.setUrl(maptilerTileUrl(theme));
}

export function limitToChennai(map: LeafletMap): LeafletMap {
  const bounds = chennaiLimit();
  map.setMaxBounds(bounds);
  map.options.maxBoundsViscosity = 1.0;
  const fill = (): void => {
    const size = map.getSize();
    if (size.x > 0 && size.y > 0) map.setMinZoom(map.getBoundsZoom(bounds, true));
  };
  fill();
  map.on('resize', fill);
  return map;
}
