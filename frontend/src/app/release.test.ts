/* Single-origin release gate (issue #16): the published entry must be the React
   build, load as a classic script, and reference assets the backend serves. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const root = process.cwd();
const html = readFileSync(path.join(root, 'app.html'), 'utf8');

test('the published entry is the React app, not the legacy page', () => {
  assert.match(html, /<div id="root"><\/div>/);
  assert.doesNotMatch(html, /app\.js\?v=phase/);
  assert.doesNotMatch(html, /shared\/engine\.js/);
});

test('the bundle loads as a classic script (backend serves .js as text/plain)', () => {
  const match = html.match(/<script defer src="([^"]+)"><\/script>/);
  assert.ok(match, 'no classic deferred bundle script found');
  assert.doesNotMatch(html, /<script type="module"/);
});

test('every locally referenced asset exists at the served root', () => {
  const refs = [...html.matchAll(/(?:src|href)="(\.?\/[^"]+)"/g)].map((m) => m[1]).filter((u): u is string => Boolean(u));
  for (const ref of refs) {
    if (ref.startsWith('http') || ref.startsWith('//')) continue;
    const file = path.join(root, ref.replace(/^\.?\//, '').split('?')[0] as string);
    assert.equal(existsSync(file), true, `missing asset: ${ref}`);
  }
});

test('the vendor libraries the app calls are loaded by the entry page', () => {
  for (const lib of ['vendor/leaflet/leaflet.js', 'vendor/chart.umd.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js']) {
    assert.match(html, new RegExp(`<script src="\\./${lib.replace(/\./g, '\\.')}`), `${lib} is not wired`);
  }
  /* The bundle is deferred, so classic vendor scripts anywhere in the document
     execute before it: deferred scripts run after parsing. */
  assert.match(html, /<script defer src="\/index-[^"]+\.js"><\/script>/);
});
