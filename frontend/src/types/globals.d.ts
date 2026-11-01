/* Minimal typings for the vendored Leaflet, Chart.js and jsPDF globals.
   Only the surface the app calls is typed; vendor internals stay untyped. */
declare global {
  // eslint-disable-next-line no-var
  var L: any;
  // eslint-disable-next-line no-var
  var Chart: any;
  interface Window {
    L: any;
    Chart: any;
    jspdf?: any;
  }
}

export {};
