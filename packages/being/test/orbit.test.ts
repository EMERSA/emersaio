/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INERTIA_TAU_S,
  MAX_SPIN,
  Orbit,
  PITCH_LIMIT_DEG,
  RETURN_AFTER_S,
  RETURN_TALKING_S,
  springStep,
} from '../src/stage/orbit.ts';

const TURN = 2 * Math.PI;
const DT = 1 / 60;

/** Step the orbit for a number of seconds at 60 fps. */
const run = (orbit: Orbit, seconds: number, returnAfterS = RETURN_AFTER_S): void => {
  for (let t = 0; t < seconds - 1e-9; t += DT) orbit.update(DT, returnAfterS);
};

const near = (actual: number, expected: number, tolerance: number, message: string): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

test('a drag across the full width is one full turn, and the tilt stops at 20 degrees', () => {
  const orbit = new Orbit();
  orbit.grab();
  for (let i = 0; i < 10; i += 1) orbit.drag(64, 0, 640);
  near(orbit.yaw, TURN, 1e-9, 'yaw');
  orbit.drag(0, 32, 640);
  near(orbit.pitchDeg(), 18, 1e-9, 'a twentieth of the width tilts 18 degrees');
  orbit.drag(0, 500, 640);
  near(orbit.pitchDeg(), PITCH_LIMIT_DEG, 1e-9, 'limited above');
  orbit.drag(0, -5000, 640);
  near(orbit.pitchDeg(), -PITCH_LIMIT_DEG, 1e-9, 'limited below');
  assert.equal(orbit.moving(), true, 'a drag in progress is movement');
});

test('a fling coasts on with a 0.5 s time constant and at most 8 rad/s', () => {
  const orbit = new Orbit();
  orbit.grab();
  orbit.release(160, 0, 640); // a quarter width a second: pi/2 rad/s
  run(orbit, 3, 100);
  near(orbit.yaw, (Math.PI / 2) * INERTIA_TAU_S * (1 - Math.exp(-3 / INERTIA_TAU_S)), 1e-6, 'coast distance');

  const fast = new Orbit();
  fast.grab();
  fast.release(1e6, 0, 640);
  fast.update(1e-3, 100);
  near(fast.yaw, MAX_SPIN * INERTIA_TAU_S * (1 - Math.exp(-1e-3 / INERTIA_TAU_S)), 1e-9, 'capped spin');
  run(fast, 10, 100);
  assert.ok(fast.yaw <= MAX_SPIN * INERTIA_TAU_S + 1e-9, 'the whole coast is at most 4 rad');
  assert.equal(fast.moving(), false, 'the coast comes to rest');
});

test('left alone for 3.5 s she returns to the nearest whole turn and the view to level, without overshoot', () => {
  const orbit = new Orbit();
  orbit.grab();
  orbit.drag(640 + 80, 16, 640); // one turn and an eighth, and 9 degrees of tilt
  orbit.release(0, 0, 640);
  run(orbit, RETURN_AFTER_S - 0.1);
  near(orbit.yaw, TURN + TURN / 8, 1e-9, 'she waits');
  let previous = orbit.yaw;
  let monotonic = true;
  for (let t = 0; t < 4; t += DT) {
    orbit.update(DT);
    if (orbit.yaw > previous + 1e-12 && orbit.yaw !== 0) monotonic = false;
    previous = orbit.yaw;
  }
  assert.ok(monotonic, 'the critically damped spring never swings past home');
  assert.equal(orbit.yaw, 0, 'a whole turn is no turn');
  assert.equal(orbit.pitch, 0);
  assert.equal(orbit.moving(), false);
});

test('in a conversation she returns after 1.5 s, and at once when she speaks', () => {
  const talking = new Orbit();
  talking.grab();
  talking.drag(-100, 0, 640);
  talking.release(0, 0, 640);
  run(talking, RETURN_TALKING_S - 0.05, RETURN_TALKING_S);
  assert.ok(talking.yaw < -0.9, 'still turned just before 1.5 s');
  run(talking, 2, RETURN_TALKING_S);
  near(talking.yaw, 0, 1e-3, 'home soon after');

  const speaking = new Orbit();
  speaking.grab();
  speaking.drag(200, 0, 640);
  speaking.release(0, 0, 640);
  speaking.update(DT, 0);
  assert.ok(speaking.moving(), 'the return starts on the first frame she speaks');
  run(speaking, 3, 0);
  assert.equal(speaking.yaw, 0);
});

test('a grab stops the coast and the return where she is', () => {
  const orbit = new Orbit();
  orbit.grab();
  orbit.drag(300, 0, 640);
  orbit.release(0, 0, 640);
  run(orbit, RETURN_AFTER_S + 0.2);
  const mid = orbit.yaw;
  assert.ok(mid > 0 && mid < (300 / 640) * TURN, 'part of the way back');
  orbit.grab();
  run(orbit, 5);
  assert.equal(orbit.yaw, mid, 'held still while grabbed');
});

test('under reduced motion a drag turns her directly, with no coast and no return', () => {
  const orbit = new Orbit({ reducedMotion: true });
  orbit.grab();
  orbit.drag(160, 0, 640);
  orbit.release(5000, 0, 640);
  run(orbit, 10);
  near(orbit.yaw, Math.PI / 2, 1e-9, 'stays where the drag left her');
  assert.equal(orbit.moving(), false);
});

test('the spring step is the exact critically damped solution', () => {
  // x(t) = (x0 + (v0 + w x0) t) e^(-w t), whatever the step size.
  const [x1, v1] = springStep(1, 0, 6, 0.5);
  near(x1, (1 + 6 * 0.5) * Math.exp(-3), 1e-12, 'one big step');
  let x = 1;
  let v = 0;
  for (let i = 0; i < 50; i += 1) [x, v] = springStep(x, v, 6, 0.01);
  near(x, x1, 1e-9, 'fifty small steps land in the same place');
  near(v, v1, 1e-9, 'with the same velocity');
});

test('a cancelled drag puts her back where the drag found her, with nothing to coast', () => {
  const orbit = new Orbit();
  orbit.grab();
  orbit.drag(320, 0, 640);
  orbit.release(0, 0, 640);
  const turned = orbit.yaw;
  // A finger starts a page scroll: a few pixels reach the orbit before the browser takes the pointer.
  orbit.grab();
  orbit.drag(3, 14, 640);
  orbit.cancel();
  assert.equal(orbit.yaw, turned);
  assert.equal(orbit.pitch, 0);
  assert.equal(orbit.moving(), false);
  orbit.cancel();
  assert.equal(orbit.yaw, turned, 'a cancel with no drag on changes nothing');
});
