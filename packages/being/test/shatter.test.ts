/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoShatter,
  INTRO_S,
  introShatter,
  SHATTER_MANUAL_HOLD_MS,
  SHATTER_PULSE,
  shatterGoal,
} from '../src/avatar/shatter.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

test('the intro starts fully scattered, eases out and is assembled at 1.6 s', () => {
  assert.equal(INTRO_S, 1.6);
  assert.equal(introShatter(0), 1);
  assert.equal(introShatter(-1), 1);
  assert.equal(introShatter(INTRO_S), 0);
  assert.equal(introShatter(5), 0);
  // Cubic ease-out: halfway through the time, seven eighths of the way home.
  close(introShatter(INTRO_S / 2), 0.125);
  let previous = 1;
  for (let t = 0; t <= INTRO_S; t += 0.05) {
    const s = introShatter(t);
    assert.ok(s <= previous, 'the pieces only ever come closer');
    previous = s;
  }
  const early = 1 - introShatter(INTRO_S / 4);
  const late = introShatter((3 * INTRO_S) / 4) - introShatter(INTRO_S);
  assert.ok(early > late, 'most of the move happens early');
});

test('the automatic pulse tops out at about 0.12 and a recent value from outside wins', () => {
  assert.equal(autoShatter(0, 0), 0);
  close(autoShatter(1, 1), SHATTER_PULSE);
  close(autoShatter(0.5, 0), SHATTER_PULSE / 2);
  close(autoShatter(0, 1), SHATTER_PULSE * 0.3);
  assert.equal(shatterGoal(0.7, 500, 1, 1), 0.7);
  assert.equal(shatterGoal(0.7, SHATTER_MANUAL_HOLD_MS - 1, 1, 1), 0.7);
  close(shatterGoal(0.7, SHATTER_MANUAL_HOLD_MS, 1, 1), SHATTER_PULSE);
  assert.equal(shatterGoal(0.7, Number.POSITIVE_INFINITY, 0, 0), 0);
});
