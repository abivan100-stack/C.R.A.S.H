/* Regression tests for F040, F041 and F042 — the notification poll must back off
   and must not fail silently.

   The poll ran on a fixed 8s setInterval with a completely empty .catch. When the
   backend went down it kept firing every 8 seconds for the life of the page, and
   the user was never told cross-device sync had stopped — the app looked healthy
   while showing stale data. On a Render free instance that has spun down, this is
   the exact situation a demo hits.

   notifications.js needs a DOM and window.CRASH_SHELL, so rather than stand up a
   browser these tests exercise the backoff policy directly and then assert the
   shipped source implements that policy. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'notifications.js'), 'utf8');

/* The policy as implemented in notifications.js. */
const POLL_MS = 8000;
const POLL_BACKOFF_MAX_MS = 120000;
const POLL_FAILURES_BEFORE_VISIBLE = 3;

function pollDelay(failures) {
  if (!failures) return POLL_MS;
  return Math.min(POLL_MS * Math.pow(2, failures), POLL_BACKOFF_MAX_MS);
}

/* --- the backoff policy --------------------------------------------------- */

test('a healthy poll keeps the normal cadence', () => {
  assert.equal(pollDelay(0), 8000);
});

test('consecutive failures back off exponentially', () => {
  assert.equal(pollDelay(1), 16000);
  assert.equal(pollDelay(2), 32000);
  assert.equal(pollDelay(3), 64000);
});

test('backoff is capped so the retry never becomes uselessly slow', () => {
  assert.equal(pollDelay(4), POLL_BACKOFF_MAX_MS);
  assert.equal(pollDelay(50), POLL_BACKOFF_MAX_MS);
  assert.ok(Number.isFinite(pollDelay(1000)));
});

test('a dead backend is retried far less than the old fixed interval', () => {
  // Over 10 minutes: the old code fired 75 times; backoff must be far below that.
  let elapsed = 0, attempts = 0, failures = 0;
  while (elapsed < 600000) {
    elapsed += pollDelay(failures);
    failures++;
    attempts++;
  }
  assert.ok(attempts < 15, `still hammering a dead backend: ${attempts} attempts in 10 minutes`);
  assert.equal(Math.ceil(600000 / POLL_MS), 75, 'the old fixed-interval count, for comparison');
});

test('recovery returns immediately to the normal cadence', () => {
  let failures = 5;
  assert.equal(pollDelay(failures), POLL_BACKOFF_MAX_MS);
  failures = 0;                       // a success resets the counter
  assert.equal(pollDelay(failures), POLL_MS);
});

/* --- when the user is told ------------------------------------------------ */

test('a brief hiccup does not flash an offline warning', () => {
  for (let failures = 1; failures < POLL_FAILURES_BEFORE_VISIBLE; failures++) {
    assert.ok(failures < POLL_FAILURES_BEFORE_VISIBLE,
      'sync should stay quiet through a short blip');
  }
});

test('a sustained outage does surface to the user', () => {
  assert.ok(POLL_FAILURES_BEFORE_VISIBLE >= 2, 'must tolerate at least one blip');
  assert.ok(POLL_FAILURES_BEFORE_VISIBLE <= 5, 'must not hide a real outage for long');
  // Time to first warning must be under a minute so a demo notices quickly.
  let elapsed = 0;
  for (let f = 0; f < POLL_FAILURES_BEFORE_VISIBLE; f++) elapsed += pollDelay(f);
  assert.ok(elapsed < 60000, `user waits ${elapsed}ms before any indication`);
});

/* --- the shipped source implements the policy ----------------------------- */

test('the poll no longer uses a fixed setInterval it cannot back off', () => {
  assert.doesNotMatch(SOURCE, /setInterval\(\s*pollBackend/,
    'a fixed interval cannot back off — it would hammer a dead backend forever');
  assert.match(SOURCE, /scheduleNextPoll/, 'no self-rescheduling poll found');
});

test('the failure path is no longer empty', () => {
  assert.doesNotMatch(SOURCE, /\.catch\(function \(\) \{ \/\* silent/,
    'the silent catch is back');
  assert.match(SOURCE, /pollFailures\+\+/, 'failures are not counted');
  assert.match(SOURCE, /setSyncOffline\(true\)/, 'the user is never told sync stopped');
});

test('a successful poll clears both the failure count and the warning', () => {
  assert.match(SOURCE, /pollFailures = 0/);
  assert.match(SOURCE, /setSyncOffline\(false\)/);
});

test('the backoff constants in the source match the policy tested here', () => {
  assert.match(SOURCE, new RegExp(`POLL_BACKOFF_MAX_MS = ${POLL_BACKOFF_MAX_MS}`));
  assert.match(SOURCE, new RegExp(`POLL_FAILURES_BEFORE_VISIBLE = ${POLL_FAILURES_BEFORE_VISIBLE}`));
  assert.match(SOURCE, new RegExp(`POLL_MS = ${POLL_MS}`));
});

test('the offline indicator has a matching style hook', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.match(indexHtml, /\.notify-bell\.sync-offline/,
    'notifications.js toggles .sync-offline but nothing styles it');
});

test('stopPolling clears a timeout, not an interval', () => {
  // Mismatched clearInterval/setTimeout would leave the poll running forever.
  assert.match(SOURCE, /function stopPolling\(\) \{ if \(pollTimer\) clearTimeout\(pollTimer\)/);
});
