/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backProject,
  cameraTangents,
  greyToDistance,
  isHit,
  KINECT_V1_TANGENTS,
  MIRROR_FLOOR_ALPHA,
  mirrorFade,
  perspectiveDepthToDistance,
  SCATTER_REACH_M,
  SENSOR_TANGENTS,
  scatterFade,
  scatterFor,
  scatterTravel,
} from '../src/data/depth/depthMath.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

test('the first Kinect tangents are the three example constants', () => {
  close(KINECT_V1_TANGENTS.x, Math.tan(1.0144686 / 2) * 2, 1e-4);
  close(KINECT_V1_TANGENTS.y, Math.tan(0.789809 / 2) * 2, 1e-4);
  assert.equal(SENSOR_TANGENTS.v1, KINECT_V1_TANGENTS);
  close(SENSOR_TANGENTS.azure.x, cameraTangents(75, 1).x, 1e-4);
  close(SENSOR_TANGENTS.azure.y, cameraTangents(65, 1).y, 1e-4);
});

test('camera tangents are 2 tan(fov / 2), widened by the aspect ratio', () => {
  const t = cameraTangents(90, 1.5);
  close(t.y, 2);
  close(t.x, 3);
});

test('perspective depth and grey map the clipping planes to distance at their ends', () => {
  close(perspectiveDepthToDistance(0, 0.1, 50), 0.1);
  close(perspectiveDepthToDistance(1, 0.1, 50), 50);
  const mid = perspectiveDepthToDistance(0.9, 0.1, 50);
  assert.ok(mid > 0.1 && mid < 50);
  close(greyToDistance(1, 0.85, 4), 0.85);
  close(greyToDistance(0, 0.85, 4), 4);
  close(greyToDistance(0.5, 0.85, 4), 2.425);
});

test('misses: a cleared depth buffer in perspective, black and white in grey', () => {
  assert.equal(isHit(1, false), false);
  assert.equal(isHit(0.99995, false), false);
  assert.equal(isHit(0.5, false), true);
  assert.equal(isHit(0, false), true);
  assert.equal(isHit(0, true), false);
  assert.equal(isHit(1, true), false);
  assert.equal(isHit(0.5, true), true);
});

test('a grid cell back-projects along its ray in camera mode', () => {
  // A 90 degree square camera: at 2 m the view is 4 m wide, so the last column's centre sits at 1.75 m.
  const grid = { cols: 8, rows: 4 };
  const p = backProject({ x: 7, y: 3 }, grid, 2, cameraTangents(90, 1));
  close(p.x, 1.75);
  close(p.y, 1.5);
  close(p.z, -2);
  // The centre of a grid with an odd size lands on the axis.
  const centre = backProject({ x: 1, y: 1 }, { cols: 3, rows: 3 }, 3.5, cameraTangents(32, 2 / 3));
  close(centre.x, 0);
  close(centre.y, 0);
  close(centre.z, -3.5);
  // The z offset moves the whole cloud along the depth axis.
  close(backProject({ x: 1, y: 1 }, { cols: 3, rows: 3 }, 3.5, cameraTangents(32, 2 / 3), 0.25).z, -3.25);
});

test('a grid cell back-projects with the sensor tangents in kinect mode', () => {
  const grid = { cols: 640, rows: 480 };
  // The first Kinect at 2 m: half a view is 2 * 1.11146 / 2 = 1.11 m wide, less half a cell.
  const corner = backProject({ x: 0, y: 0 }, grid, 2, KINECT_V1_TANGENTS);
  close(corner.x, (0.5 / 640 - 0.5) * 2 * KINECT_V1_TANGENTS.x);
  close(corner.y, (0.5 / 480 - 0.5) * 2 * KINECT_V1_TANGENTS.y);
  close(corner.z, -2);
  const nearCentre = backProject({ x: 319, y: 239 }, grid, 2, KINECT_V1_TANGENTS);
  assert.ok(Math.abs(nearCentre.x) < 0.002 && Math.abs(nearCentre.y) < 0.002);
  // The same cell twice as far away lands twice as far from the axis.
  const far = backProject({ x: 0, y: 0 }, grid, 4, KINECT_V1_TANGENTS);
  close(far.x, corner.x * 2);
  close(far.y, corner.y * 2);
});

test('scatter follows the token meter and stays within reach', () => {
  assert.equal(scatterFor(0, 0), 0);
  assert.equal(scatterFor(1, 1), 1);
  assert.equal(scatterFor(0.5, 0), 0.5);
  close(scatterFor(0, 1), 0.3);
  assert.equal(scatterFor(Number.NaN, Number.POSITIVE_INFINITY), 0);
  assert.equal(scatterTravel(0, 0.7), 0);
  close(scatterTravel(1, 1), SCATTER_REACH_M);
  assert.ok(scatterTravel(1, 0) > 0 && scatterTravel(1, 0) < scatterTravel(1, 1));
  assert.equal(scatterFade(0), 1);
  close(scatterFade(SCATTER_REACH_M), 0.2);
  close(scatterFade(SCATTER_REACH_M / 2), 0.6);
});

test('the reflection fades from 0.35 at the floor to nothing 0.9 m up, and never below zero', () => {
  close(mirrorFade(0), MIRROR_FLOOR_ALPHA);
  close(mirrorFade(0.45), MIRROR_FLOOR_ALPHA / 2);
  assert.equal(mirrorFade(0.9), 0);
  assert.equal(mirrorFade(2), 0);
  assert.equal(mirrorFade(-1), MIRROR_FLOOR_ALPHA);
  let previous = 1;
  for (let h = 0; h <= 1; h += 0.05) {
    const fade = mirrorFade(h);
    assert.ok(fade <= previous);
    previous = fade;
  }
});
