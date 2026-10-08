/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUST_LIFT,
  BUST_SHARE,
  bustBounds,
  bustFramingFor,
  FACE_CHIN_AIR,
  FACE_CROWN_AIR,
  FACE_FOV,
  FACE_PORTRAIT_SHARE,
  faceFramingFor,
  faceLayoutT,
  framingFor,
  visibleHeight,
} from '../src/stage/framing.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

/** A head a quarter of a metre tall, its centre 5 cm in front of the figure's axis. */
const head = { minY: 1.5, maxY: 1.75, centreZ: 0.05 };

test('landscape: the crown 6 percent below the top edge, the chin 47 percent above the bottom', () => {
  const f = faceFramingFor(16 / 9, head);
  assert.equal(f.t, 1);
  assert.equal(f.fov, FACE_FOV);
  assert.equal(f.targetZ, head.centreZ);
  const visible = visibleHeight(f);
  const top = f.targetY + visible / 2;
  const bottom = f.targetY - visible / 2;
  close((top - head.maxY) / visible, FACE_CROWN_AIR);
  close((head.minY - bottom) / visible, FACE_CHIN_AIR);
  close(visible, 0.25 / (1 - FACE_CROWN_AIR - FACE_CHIN_AIR));
  // The camera stands the lens's distance in front of the head's own depth.
  close(f.distance, visible / (2 * Math.tan((FACE_FOV * Math.PI) / 360)));
});

test('portrait: the head is 70 percent of the height and centred', () => {
  const f = faceFramingFor(2 / 3, head);
  assert.equal(f.t, 0);
  const visible = visibleHeight(f);
  close((head.maxY - head.minY) / visible, FACE_PORTRAIT_SHARE);
  close(f.targetY, (head.minY + head.maxY) / 2, 1e-9);
  assert.ok(f.targetY + visible / 2 > head.maxY, 'the crown keeps air above it');
  assert.ok(f.targetY - visible / 2 < head.minY, 'and the chin keeps air below it');
});

test('the brief: at 1440 x 900 the head is 360 to 420 px tall with the crown at least 40 px down', () => {
  const f = faceFramingFor(1440 / 828, head);
  const pxPerMetre = 828 / visibleHeight(f);
  const headPx = (head.maxY - head.minY) * pxPerMetre;
  assert.ok(headPx >= 360 && headPx <= 420, `head ${headPx.toFixed(0)} px`);
  const crownPx = (f.targetY + visibleHeight(f) / 2 - head.maxY) * pxPerMetre;
  assert.ok(crownPx >= 40, `crown ${crownPx.toFixed(0)} px below the top`);
  // A phone stage of 46svh at 390 x 844 (about 388 px tall) shows the head at least 240 px tall.
  const phone = faceFramingFor(390 / 388, head);
  assert.ok((head.maxY - head.minY) * (388 / visibleHeight(phone)) >= 240);
});

test('in between, the framing interpolates with the layout and comes closer as the canvas narrows', () => {
  const between = (x: number, a: number, b: number): boolean => x > Math.min(a, b) && x < Math.max(a, b);
  const square = faceFramingFor(1.3, head);
  const portrait = faceFramingFor(2 / 3, head);
  const landscape = faceFramingFor(16 / 9, head);
  close(square.t, faceLayoutT(1.3));
  assert.equal(faceLayoutT(1), 0, 'a phone stage of 390 x 388 frames the head the portrait way');
  assert.equal(faceLayoutT(1.74), 1);
  // The head fills 70 percent of a portrait stage and 47 percent of a landscape one, so the portrait camera is nearer.
  assert.ok(portrait.distance < landscape.distance);
  assert.ok(between(square.distance, landscape.distance, portrait.distance));
  assert.ok(between(square.targetY, landscape.targetY, portrait.targetY));
  // A taller head wants a longer distance; the share of the canvas it takes stays the same.
  const tall = faceFramingFor(16 / 9, { ...head, maxY: 1.8 });
  close(0.3 / visibleHeight(tall), 1 - FACE_CROWN_AIR - FACE_CHIN_AIR);
  assert.ok(tall.distance > landscape.distance);
});

test('the figure framings are unchanged and look at the axis', () => {
  const portrait = framingFor(2 / 3);
  assert.deepEqual(portrait, { t: 0, fov: 32, distance: 3.5, targetY: 0.84, targetZ: 0 });
  close(visibleHeight(portrait), 2.0, 0.02);
  const landscape = framingFor(2);
  assert.equal(landscape.t, 1);
  close(landscape.fov, 30);
  close(landscape.distance, 3.95);
  close(landscape.targetY, 0.8);
  assert.equal(landscape.targetZ, 0);
  const small = framingFor(1.6, true);
  assert.equal(small.fov, 28);
  assert.equal(small.targetY, 1.56);
  assert.equal(small.targetZ, 0);
});

test('the kinect-demo look frames the head and shoulders at 75 percent of the height, lifted on landscape', () => {
  const head = { minY: 1.4, maxY: 1.75, centreZ: 0.02 };
  const bust = bustBounds(head);
  assert.ok(Math.abs(bust.minY - 1.25) < 1e-9);
  assert.equal(bust.maxY, 1.75);
  for (const aspect of [0.6, 1, 1.6, 2.2]) {
    const f = bustFramingFor(aspect, bust);
    const visible = 2 * f.distance * Math.tan((f.fov * Math.PI) / 360);
    assert.ok(Math.abs((bust.maxY - bust.minY) / visible - BUST_SHARE) < 1e-9);
    assert.ok(Math.abs(f.targetY - (1.5 - BUST_LIFT * f.t * visible)) < 1e-9);
    assert.equal(f.targetZ, 0.02);
  }
  assert.equal(bustFramingFor(0.6, bust).targetY, 1.5);
});
