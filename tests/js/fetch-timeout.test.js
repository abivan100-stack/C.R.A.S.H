/* Regression tests for F004 — aborting a fetch that stalls mid-body.

   All five timeout-protected fetches in this app cleared the abort timer inside
   the first .then()/after the await, i.e. as soon as the response HEADERS
   arrived. fetch() settles at that point but the body is still streaming, so a
   server that sends headers and then stalls was never aborted: the promise never
   settled, and every downstream `finally`/latch-release never ran.

   Observed consequences: boot hung with a blank map, Submit stuck on "Saving…",
   the bot stuck on "typing…", the xlsx export stuck disabled, and — worst —
   notifications.js latched `pollInFlight = true`, silently killing cross-device
   sync for the rest of the session.

   These tests stand up a real HTTP server that stalls its body and assert the
   two patterns actually used in the code. */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

/* Server that sends 200 + headers immediately, then never finishes the body. */
function stallingServer() {
  const sockets = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('[');                 // headers and a first byte land; the body never ends
  });
  server.on('connection', (s) => sockets.push(s));
  return {
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    url: () => `http://127.0.0.1:${server.address().port}/reports`,
    close: () => { sockets.forEach((s) => s.destroy()); return new Promise((r) => server.close(r)); },
  };
}

/* Server that responds normally, to prove the fix does not break the happy path. */
function healthyServer(payload) {
  const sockets = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  server.on('connection', (s) => sockets.push(s));
  return {
    server,
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    url: () => `http://127.0.0.1:${server.address().port}/reports`,
    close: () => { sockets.forEach((s) => s.destroy()); return new Promise((r) => server.close(r)); },
  };
}

const TIMEOUT_MS = 300;
const PATIENCE_MS = 2000;

/* Resolves to 'HUNG' if the operation outlives the patience window. */
function withPatience(promise) {
  let t;
  return Promise.race([
    promise,
    new Promise((r) => { t = setTimeout(() => r('HUNG'), PATIENCE_MS); }),
  ]).finally(() => clearTimeout(t));
}

/* --- pattern A: async/await + finally (app.js fetchSharedReports) ---------- */

async function awaitPattern(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return 'NOT_OK';
    const data = await res.json();
    return Array.isArray(data) ? 'OK:' + data.length : 'BAD_SHAPE';
  } catch {
    return 'ABORTED';
  } finally {
    clearTimeout(timer);
  }
}

/* --- pattern B: promise chain + trailing .then (notifications/bot/index) --- */

function chainPattern(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let latched = true;                      // stands in for pollInFlight
  return fetch(url, { signal: ctrl.signal })
    .then((resp) => {
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      return resp.json();
    })
    .then((data) => (Array.isArray(data) ? 'OK:' + data.length : 'BAD_SHAPE'))
    .catch(() => 'ABORTED')
    .then((outcome) => { clearTimeout(timer); latched = false; return { outcome, latched }; });
}

/* --- the tests ------------------------------------------------------------ */

test('await pattern aborts a body that stalls after the headers', async () => {
  const srv = stallingServer();
  await srv.listen();
  try {
    const result = await withPatience(awaitPattern(srv.url()));
    assert.notEqual(result, 'HUNG', 'the fetch never aborted — F004 has regressed');
    assert.equal(result, 'ABORTED');
  } finally {
    await srv.close();
  }
});

test('chain pattern aborts a stalled body AND releases its in-flight latch', async () => {
  const srv = stallingServer();
  await srv.listen();
  try {
    const result = await withPatience(chainPattern(srv.url()));
    assert.notEqual(result, 'HUNG', 'the poll never aborted — F004 has regressed');
    assert.equal(result.outcome, 'ABORTED');
    assert.equal(result.latched, false,
      'pollInFlight stayed true — cross-device sync would be dead for the session');
  } finally {
    await srv.close();
  }
});

test('the old pattern — clearing the timer on headers — really does hang', async () => {
  /* Proves the tests above are not vacuous by reproducing the ORIGINAL bug. */
  const srv = stallingServer();
  await srv.listen();
  try {
    const buggy = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(srv.url(), { signal: ctrl.signal });
        clearTimeout(timer);            // <-- the defect: disarmed before reading the body
        await res.json();
        return 'SETTLED';
      } catch {
        return 'ABORTED';
      }
    })();
    assert.equal(await withPatience(buggy), 'HUNG',
      'the original pattern no longer hangs — this test can no longer prove the fix');
  } finally {
    await srv.close();
  }
});

test('both patterns still succeed against a healthy server', async () => {
  const srv = healthyServer([{ id: 1 }, { id: 2 }]);
  await srv.listen();
  try {
    assert.equal(await withPatience(awaitPattern(srv.url())), 'OK:2');
    const chained = await withPatience(chainPattern(srv.url()));
    assert.equal(chained.outcome, 'OK:2');
    assert.equal(chained.latched, false);
  } finally {
    await srv.close();
  }
});

/* --- the shipped source must not reintroduce the pattern ------------------ */

test('no shipped fetch clears its abort timer on the headers callback', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');

  const offenders = [];
  for (const file of ['app.js', 'notifications.js', 'bot.js', 'index.html']) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/clearTimeout\(timer\)/.test(line)) return;
      // The defect looks like:
      //     .then(function (resp) {
      //       if (timer) clearTimeout(timer);      <-- disarmed on HEADERS
      //       if (!resp.ok) throw ...              <-- still in the headers callback
      // so look FORWARD: a `.ok` status check just after the clear means we are
      // still in the headers stage with the body unread. Clearing it in a
      // trailing .then() or a finally (the correct homes) has no such check
      // after it. Looking backward would false-positive on the trailing .then,
      // which legitimately sits below the headers callback.
      const ahead = lines.slice(i + 1, i + 4).join('\n');
      if (/\breso?p?\.ok\b|\br\.ok\b/.test(ahead)) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    `abort timer cleared at the headers stage (F004) in: ${offenders.join(', ')}`);
});
