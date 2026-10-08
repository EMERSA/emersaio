/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FAN_TARGETS,
  FAN_LINES,
  FAN_MAX_TARGETS,
  FAN_PLANE_M,
  lineTarget,
  projectToPlane,
  sampleIndices,
} from '../src/data/fanMath.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

test('a canvas-normalised target lands on the plane in front of the head', () => {
  // A 90 degree square camera 0.8 m from the plane sees 1.6 m of it: the canvas edges are 0.8 m out.
  const camera = { fovDeg: 90, aspect: 1, y: 1.6, z: 1.2 };
  const centre = projectToPlane({ x: 0, y: 0 }, camera, 0.4);
  close(centre.x, 0);
  close(centre.y, 1.6);
  close(centre.z, 0.4);
  const corner = projectToPlane({ x: 1, y: -1 }, camera, 0.4);
  close(corner.x, 0.8);
  close(corner.y, 0.8);
  close(corner.z, 0.4);
  // Half a canvas to the right on a 2:1 canvas is twice as far out as on a square one.
  close(projectToPlane({ x: 0.5, y: 0 }, { ...camera, aspect: 2 }, 0.4).x, 0.8);
  // The face framing: a 24 degree lens 1.1 m from the head centre, the plane 0.3 m before it.
  const headZ = 0.058;
  const face = { fovDeg: 24, aspect: 0.88, y: 1.554, z: headZ + 1.1 };
  const node = projectToPlane({ x: 0.9, y: 0.7 }, face, headZ + FAN_PLANE_M);
  const half = 0.8 * Math.tan((12 * Math.PI) / 180);
  close(node.x, 0.9 * half * 0.88);
  close(node.y, 1.554 + 0.7 * half);
  close(node.z, headZ + FAN_PLANE_M);
  // A plane behind the camera never divides by zero.
  assert.ok(Number.isFinite(projectToPlane({ x: 1, y: 1 }, camera, 5).x));
});

test('lines are dealt round the nodes, and the default nodes fan down the right edge', () => {
  assert.equal(lineTarget(0, 5), 0);
  assert.equal(lineTarget(7, 5), 2);
  assert.equal(lineTarget(3, 0), 0);
  assert.equal(FAN_LINES, 60);
  assert.ok(DEFAULT_FAN_TARGETS.length > 0 && DEFAULT_FAN_TARGETS.length <= FAN_MAX_TARGETS);
  for (const target of DEFAULT_FAN_TARGETS) {
    assert.ok(target.x > 0.5 && target.x <= 1, 'on the right');
    assert.ok(Math.abs(target.y) <= 1);
  }
});

test('the line starts are spread over the head, in range, distinct and the same every time', () => {
  const count = 1825;
  const picks = sampleIndices(count, FAN_LINES);
  assert.equal(picks.length, FAN_LINES);
  for (const index of picks) assert.ok(Number.isInteger(index) && index >= 0 && index < count);
  assert.equal(new Set(picks).size, FAN_LINES);
  assert.ok(Math.min(...picks) < count * 0.1 && Math.max(...picks) > count * 0.9);
  assert.deepEqual(picks, sampleIndices(count, FAN_LINES));
  assert.deepEqual(sampleIndices(0, 10), []);
  // A tiny mesh still yields the asked number of starts, all valid.
  assert.ok(sampleIndices(3, FAN_LINES).every((index) => index >= 0 && index < 3));
});
