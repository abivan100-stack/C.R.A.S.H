/* Characterisation tests for shared/utils.js.

   escapeHtml is the load-bearing one: it is the fix for the stored-XSS cluster,
   so its guarantees are pinned here before anything starts depending on them.
   DOM-bound helpers (cssv, currentTheme, palette) are not covered — they read
   getComputedStyle and belong to a browser-level test. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CRASH_UTILS: CU } = require('../../shared/utils.js');

/* --- escapeHtml ---------------------------------------------------------- */

test('escapeHtml neutralises the characters that open an HTML tag', () => {
  assert.equal(CU.escapeHtml('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(CU.escapeHtml('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml escapes the double quote, making it safe in a "…" attribute', () => {
  assert.equal(CU.escapeHtml('" onmouseover="alert(1)'),
    '&quot; onmouseover=&quot;alert(1)');
});

test('escapeHtml escapes ampersands so entities cannot be smuggled through', () => {
  assert.equal(CU.escapeHtml('&lt;script&gt;'), '&amp;lt;script&amp;gt;');
});

test('escapeHtml does NOT escape single quotes — callers must use double-quoted attributes', () => {
  // Documented limitation, asserted so a future single-quoted sink is a visible failure.
  assert.equal(CU.escapeHtml("' onload='x"), "' onload='x");
});

test('escapeHtml is null-safe and always returns a string', () => {
  assert.equal(CU.escapeHtml(null), '');
  assert.equal(CU.escapeHtml(undefined), '');
  assert.equal(CU.escapeHtml(0), '0');
  assert.equal(CU.escapeHtml(false), 'false');
  assert.equal(CU.escapeHtml({}), '[object Object]');
});

test('escapeHtml leaves ordinary dataset values untouched', () => {
  for (const value of ['Guindy', 'Over-speeding', 'Bus (MTC/Private)', 'Lorry / Truck', 'T. Nagar']) {
    assert.equal(CU.escapeHtml(value), value);
  }
});

/* --- time helpers -------------------------------------------------------- */

test('hourOf reads the hour out of a "YYYY-MM-DD HH:MM" string', () => {
  assert.equal(CU.hourOf('2025-06-01 14:30'), 14);
  assert.equal(CU.hourOf('2025-06-01 00:05'), 0);
  assert.equal(CU.hourOf('2025-06-01 23:59'), 23);
});

test('isNight treats 18:00-05:59 as night, matching the bot prompt', () => {
  assert.equal(CU.isNight('2025-06-01 18:00'), true);
  assert.equal(CU.isNight('2025-06-01 23:30'), true);
  assert.equal(CU.isNight('2025-06-01 05:59'), true);
  assert.equal(CU.isNight('2025-06-01 06:00'), false);
  assert.equal(CU.isNight('2025-06-01 12:00'), false);
  assert.equal(CU.isNight('2025-06-01 17:59'), false);
});

/* --- number helpers ------------------------------------------------------ */

test('pct guards against a zero total instead of returning NaN', () => {
  assert.equal(CU.pct(0, 0), '0%');
  assert.equal(CU.pct(5, 0), '500%', 'a zero total falls back to a divisor of 1');
  assert.equal(CU.pct(1, 4), '25%');
  assert.equal(CU.pct(1, 3), '33%');
});

test('fmt groups thousands the way the KPI tiles expect', () => {
  assert.equal(CU.fmt(10169), '10,169');
  assert.equal(CU.fmt(0), '0');
});

test('pad2 zero-pads to two digits', () => {
  assert.equal(CU.pad2(7), '07');
  assert.equal(CU.pad2(12), '12');
});

test('sortedEntries orders an object by value, descending', () => {
  assert.deepEqual(CU.sortedEntries({ a: 1, b: 9, c: 5 }), [['b', 9], ['c', 5], ['a', 1]]);
  assert.deepEqual(CU.sortedEntries({}), []);
});

/* --- colour helpers ------------------------------------------------------ */

test('hexToRgb handles both the 6-digit and 3-digit forms', () => {
  assert.deepEqual(CU.hexToRgb('#BE2F2A'), { r: 190, g: 47, b: 42 });
  assert.deepEqual(CU.hexToRgb('#fff'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(CU.hexToRgb('2F5C87'), { r: 47, g: 92, b: 135 });
});

test('rgba composes a CSS colour string', () => {
  assert.equal(CU.rgba('#BE2F2A', 0.5), 'rgba(190,47,42,0.5)');
});
