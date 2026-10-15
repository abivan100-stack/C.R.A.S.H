/* Regression tests for the intervention model's cause lookups.

   `cause` is attacker-controllable (POST /report) and reaches pick()/authorityFor()
   as a plain string. Both used a bare object lookup, so an Object.prototype member
   resolved through the prototype chain:
     pick('constructor')            -> Object (a function) instead of a fix descriptor
     authorityFor('__proto__')      -> undefined, past the `|| 'traffic'` fallback
   Consumers read .fix/.cost/.eff and .url off these, so an unvalidated cause
   produced undefined fixes and a dead authority link. The lookups are own-property
   only now.
*/

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const I = require('../../intervention-model.js');
const M = I.CRASH_INTERVENTIONS;
const A = I.CRASH_AUTHORITIES;

/* --- known causes still map correctly ---------------------------------------- */

test('a known cause selects its own fix descriptor', () => {
  const iv = M.pick('Over-speeding', 0);
  assert.equal(iv.fix, M.byCause['Over-speeding'].fix);
  assert.equal(typeof iv.eff, 'number');
  assert.equal(typeof iv.cost, 'string');
});

test('every cause in the table yields a usable descriptor', () => {
  for (const cause of Object.keys(M.byCause)) {
    const iv = M.pick(cause, 0);
    assert.equal(typeof iv.fix, 'string', `${cause} produced no fix`);
    assert.equal(typeof iv.eff, 'number', `${cause} produced no effectiveness`);
  }
});

test('a night-heavy or hit-and-run zone falls back to the lighting/CCTV fix', () => {
  assert.equal(M.pick('Vehicle defect', 0.9), M.night);
  assert.equal(M.pick('Hit and run', 0), M.night);
});

/* --- Object.prototype members are not causes --------------------------------- */

for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
  test(`pick("${poison}") returns the generic default, not an Object.prototype member`, () => {
    const iv = M.pick(poison, 0);
    assert.equal(iv, M.fallback, `pick("${poison}") did not fall back`);
    assert.equal(typeof iv.fix, 'string');
  });
}

for (const poison of ['__proto__', 'constructor', 'toString', '__defineGetter__']) {
  test(`authorityFor("${poison}") returns the traffic authority, not undefined`, () => {
    const auth = A.for(poison);
    assert.ok(auth, `authorityFor("${poison}") returned ${auth}`);
    assert.equal(auth.name, A.byKey.traffic.name);
    assert.match(auth.url, /^https:\/\//);
  });
}

test('a known cause still resolves to its own authority', () => {
  assert.equal(A.for('Pothole / bad road').name, A.byKey.civic.name);
  assert.equal(A.for('Hit and run').name, A.byKey.police.name);
  assert.equal(A.for('Vehicle defect').name, A.byKey.transport.name);
});

/* --- preventable never overstates harm --------------------------------------- */

test('preventable is clamped to the incidents that actually happened and floors', () => {
  assert.equal(M.preventable(0, 0, 0.35), 0);
  assert.equal(M.preventable(10, 0, 0.35), 3, 'must round DOWN, never above the rate');
  assert.equal(M.preventable(10, 0, 5), 10, 'an over-unity rate cannot exceed the count');
  assert.equal(M.preventable(undefined, undefined, 0.3), 0);
});
