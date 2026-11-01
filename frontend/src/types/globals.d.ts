/* Minimal typings for the vendored Leaflet global. Only what the app calls. */
declare global {
  // eslint-disable-next-line no-var
  var L: any;
  interface Window {
    L: any;
    jspdf?: any;
  }
}

export {};
