/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  azureGreyToMm,
  DISPARITY_MAX_STEP_M,
  DROPOUT_HZ,
  disparityStep,
  hash01,
  isJump,
  KINECTRON_CLIPPING,
  kinectV2GreyToMm,
  POINT_CSS_PX,
  pcg,
  pointAlpha,
  pointSizePx,
  quantiseDistance,
  SENSOR_HZ,
  sensorFrame,
} from '../src/data/depth/depthMath.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

test('the sensor clock ticks 30 times a second and freezes under reduced motion', () => {
  assert.equal(SENSOR_HZ, 30);
  assert.equal(DROPOUT_HZ, 10);
  assert.equal(sensorFrame(0), 0);
  assert.equal(sensorFrame(0.0333), 0);
  assert.equal(sensorFrame(0.034), 1);
  assert.equal(sensorFrame(2), 60);
  assert.equal(sensorFrame(2, true), 0);
});

test('disparity quantisation: 2.9 mm steps at 1 m, 4.5 mm at 1.25 m, capped at 10 mm further out', () => {
  close(disparityStep(1), 0.0029, 0.0001);
  close(disparityStep(1.25), 0.0045, 0.0001);
  // Quantised distances lie on the lattice fb * subPx / q.
  const z = quantiseDistance(1.0004);
  close(z, (43.19 * 8) / Math.round((43.19 * 8) / 1.0004), 1e-9);
  assert.ok(Math.abs(z - 1.0004) <= disparityStep(1) / 2 + 1e-6);
  // Two distances a step apart quantise to neighbouring steps, and a half-step dither reaches a neighbour.
  const a = quantiseDistance(1);
  const b = quantiseDistance(1 + disparityStep(1) * 1.01);
  assert.notEqual(a, b);
  assert.ok(Math.abs(b - a) < disparityStep(1) * 1.5);
  const up = quantiseDistance(1, 0.5);
  const down = quantiseDistance(1, -0.5);
  assert.ok(up !== a || down !== a);
  assert.ok(Math.abs(up - a) <= disparityStep(1) * 1.01 && Math.abs(down - a) <= disparityStep(1) * 1.01);
  // Past about 1.86 m the raw step would exceed 10 mm, so the cap takes over.
  assert.ok(disparityStep(1.9) > DISPARITY_MAX_STEP_M);
  close(quantiseDistance(2.004), 2.0, 1e-9);
  close(quantiseDistance(2.006), 2.01, 1e-9);
  assert.equal(quantiseDistance(0), 0);
  assert.equal(quantiseDistance(-1), -1);
});

test('the relative discontinuity cut is 4 percent of the distance', () => {
  assert.equal(isJump(1, 1.03), false);
  assert.equal(isJump(1, 1.05), true);
  assert.equal(isJump(2, 2.07), false);
  assert.equal(isJump(2, 2.09), true);
  assert.equal(isJump(1.05, 1), true, 'either way round');
});

test('points: size max(1, px dpr refDist / dist) with px within the brief range, alpha 0.16 fading to 0.4 of it', () => {
  assert.ok(POINT_CSS_PX >= 1.5 && POINT_CSS_PX <= 2);
  close(pointSizePx(1.1, 1.1, 1), POINT_CSS_PX);
  close(pointSizePx(1.1, 1.1, 2), 2 * POINT_CSS_PX);
  close(pointSizePx(2.2, 1.1, 1), Math.max(1, POINT_CSS_PX / 2), 1e-9);
  close(pointSizePx(0.55, 1.1, 1), 2 * POINT_CSS_PX);
  assert.equal(pointSizePx(10, 1.1, 1), 1, 'never under one device pixel');
  close(pointAlpha(0), 0.16);
  close(pointAlpha(1), 0.064);
  close(pointAlpha(0.5), 0.112);
  close(pointAlpha(2), 0.064, 1e-9);
});

test('the PCG hash is deterministic, keyed on cell, frame and salt, and spreads over 0..1', () => {
  assert.equal(pcg(0), pcg(0));
  assert.notEqual(pcg(0), pcg(1));
  assert.ok(Number.isInteger(pcg(123456789)) && pcg(123456789) >= 0 && pcg(123456789) <= 0xffffffff);
  const same = hash01(42, 7, 1);
  assert.equal(hash01(42, 7, 1), same);
  assert.notEqual(hash01(42, 8, 1), same, 'the next sensor frame redraws the dice');
  assert.notEqual(hash01(42, 7, 2), same, 'and so does another salt');
  assert.notEqual(hash01(43, 7, 1), same);
  let sum = 0;
  let low = 0;
  const n = 4000;
  for (let i = 0; i < n; i += 1) {
    const h = hash01(i, 3, 5);
    assert.ok(h >= 0 && h <= 1);
    sum += h;
    if (h < 0.3) low += 1;
  }
  close(sum / n, 0.5, 0.03);
  close(low / n, 0.3, 0.03);
});

test('Kinectron depth greys decode to millimetres: Azure 0.5 to 4 m, Kinect v2 inverted at 17 mm per level', () => {
  close(azureGreyToMm(0), 4000 - 0.5 * (3500 / 255));
  close(azureGreyToMm(254), 4000 - 254.5 * (3500 / 255));
  assert.ok(azureGreyToMm(254) > 500 && azureGreyToMm(254) < 520);
  assert.equal(azureGreyToMm(255), 0, 'white is a miss');
  assert.equal(azureGreyToMm(-1), 0);
  assert.equal(kinectV2GreyToMm(0), 0, 'black is a miss on the Kinect v2');
  assert.equal(kinectV2GreyToMm(100), 1700);
  assert.equal(kinectV2GreyToMm(255), 4335);
  assert.deepEqual(KINECTRON_CLIPPING.azure, { near: 0.5, far: 4 });
});
