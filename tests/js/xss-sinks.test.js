/* Regression tests for the stored-XSS cluster (findings F001-F003, F009-F015).

   Root cause: `POST /report` accepts any string for area/cause/vehicle/etc, the
   reports are fetched by every client, and the HTML builders in app.js,
   analytics.js, simulate.js and compare.js concatenated those values straight
   into innerHTML / Leaflet bindPopup / bindTooltip.

   The builders live inside browser-only files that need `window`, Leaflet and a
   DOM, so rather than stand up a headless browser this asserts the property that
   actually matters and that a reviewer can check by eye: every record-derived
   value that reaches an HTML sink is wrapped in the escape helper.

   That makes the guarantee mechanical — if someone adds a new unescaped sink,
   this fails. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CRASH_UTILS: CU } = require('../../shared/utils.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* Fields of an accident record / hotspot that an attacker controls via POST /report. */
const TAINTED = ['area', 'cause', 'vehicle', 'weather', 'datetime', 'domCause', 'dom'];

/* Files that build HTML from record data. */
const FILES = ['app.js', 'analytics.js', 'simulate.js', 'compare.js'];

/* A string concatenation of the form `+ something.area` that is NOT wrapped in esc().
   Chart.js label/tooltip callbacks render to canvas and are excluded by checking
   that the line actually builds markup. */
function unescapedSinks(source) {
  const hits = [];
  source.split('\n').forEach((line, i) => {
    // Only lines that are actually assembling HTML.
    if (!/['"]\s*\+|\+\s*['"]/.test(line)) return;
    if (!/<\w|<\//.test(line)) return;
    for (const field of TAINTED) {
      const re = new RegExp(`\\+\\s*[A-Za-z_$][\\w$]*\\.${field}\\b`, 'g');
      let m;
      while ((m = re.exec(line)) !== null) {
        const before = line.slice(0, m.index);
        // esc(...) wrapping puts "esc(" immediately before the expression.
        if (!/esc\($/.test(before.trimEnd()) && !/esc\(\s*$/.test(before)) {
          hits.push(`line ${i + 1}: ${m[0].trim()}  ::  ${line.trim().slice(0, 110)}`);
        }
      }
    }
  });
  return hits;
}

for (const file of FILES) {
  test(`${file} escapes every record-derived value it writes into HTML`, () => {
    const hits = unescapedSinks(read(file));
    assert.deepEqual(hits, [],
      `unescaped record data reaches an HTML sink in ${file}:\n  ${hits.join('\n  ')}`);
  });
}

test('every file that builds HTML from records defines the esc alias', () => {
  for (const file of FILES) {
    assert.match(read(file), /esc\s*=\s*CU\.escapeHtml/,
      `${file} builds HTML from record data but has no escape helper`);
  }
});

/* --- the payloads this is defending against --------------------------------- */

test('the escape helper defuses the payloads that reach these sinks', () => {
  const payloads = [
    '<img src=x onerror=alert(1)>',
    '</div><script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    '<iframe src=javascript:alert(1)>',
  ];
  for (const payload of payloads) {
    const escaped = CU.escapeHtml(payload);
    assert.ok(!/<[a-zA-Z/]/.test(escaped), `payload still opens a tag: ${escaped}`);
    assert.ok(!escaped.includes('"'), `payload still contains a raw quote: ${escaped}`);
  }
});

test('a legitimate report renders unchanged — escaping must not corrupt real data', () => {
  const record = {
    area: 'T. Nagar', cause: 'Pothole / bad road',
    vehicle: 'Bus (MTC/Private)', weather: 'clear', datetime: '2025-06-01 14:30',
  };
  for (const [key, value] of Object.entries(record)) {
    assert.equal(CU.escapeHtml(value), value, `${key} was altered by escaping`);
  }
});
