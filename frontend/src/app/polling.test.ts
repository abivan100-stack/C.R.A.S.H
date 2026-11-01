/* Polling schedule and land-guard tests (issue #8). */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { attachVisibilityPoll, type PollDeps } from './polling.ts';
import { coastLngAt, isValidLandPoint } from '../domain/pick.ts';

function fakeDeps(initialVisible: boolean): { deps: PollDeps; tick: () => void; setVisible: (v: boolean) => void; listeners: Array<() => void>; intervals: number } {
  let visible = initialVisible;
  let fired: (() => void) | null = null;
  const listeners: Array<() => void> = [];
  const deps: PollDeps = {
    isVisible: () => visible,
    onVisibleChange: (listener) => {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    setInterval: (fn) => {
      fired = fn;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      fired = null;
    },
  };
  return {
    deps,
    listeners,
    tick: () => fired?.(),
    setVisible: (v) => {
      visible = v;
      for (const l of listeners) l();
    },
    get intervals() {
      return fired ? 1 : 0;
    },
  };
}

test('the poll runs on the interval while visible', () => {
  let runs = 0;
  const fake = fakeDeps(true);
  const stop = attachVisibilityPoll(8000, () => { runs += 1; }, fake.deps);
  fake.tick();
  fake.tick();
  assert.equal(runs, 2);
  stop();
});

test('a hidden tab does not poll', () => {
  let runs = 0;
  const fake = fakeDeps(false);
  attachVisibilityPoll(8000, () => { runs += 1; }, fake.deps);
  fake.tick();
  assert.equal(runs, 0);
});

test('returning to the tab polls immediately', () => {
  let runs = 0;
  const fake = fakeDeps(false);
  attachVisibilityPoll(8000, () => { runs += 1; }, fake.deps);
  fake.setVisible(true);
  assert.equal(runs, 1);
  fake.tick();
  assert.equal(runs, 2);
});

test('stopping clears the interval and the visibility listener', () => {
  const fake = fakeDeps(true);
  const stop = attachVisibilityPoll(8000, () => {}, fake.deps);
  stop();
  assert.equal(fake.intervals, 0);
  assert.equal(fake.listeners.length, 0);
});

test('the land guard accepts Chennai land and rejects sea and outside', () => {
  assert.equal(isValidLandPoint(13.05, 80.24), true);
  assert.equal(isValidLandPoint(13.0, 80.29), false); // east of the coast
  assert.equal(isValidLandPoint(12.5, 80.2), false); // south of the city box
  assert.equal(isValidLandPoint(13.05, 80.0), false); // west of the inland limit
  assert.equal(isValidLandPoint(Number.NaN, 80.2), false);
  assert.equal(isValidLandPoint('13.05', 80.2), false);
  assert.ok(coastLngAt(13.05) > 80.28 && coastLngAt(13.05) < 80.29);
  assert.equal(coastLngAt(12.0), 80.25); // clamped to the southern control point
});
