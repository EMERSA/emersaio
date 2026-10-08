/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeDepthProbe, PROBE_RANGE_M } from '../src/data/depth/depthMath.ts';

const close = (actual: number, expected: number, eps = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${actual} is not within ${eps} of ${expected}`);
};

/** Two bytes the way three's packDepthToRG writes a share 0..1: the high byte and the fraction of the next. */
const pack = (share: number): [number, number] => {
  const scaled = share * 256;
  const high = Math.floor(scaled);
  return [high, Math.round((scaled - high) * 255)];
};

test('the probe decodes the nearest and farthest block and skips blocks that saw nothing', () => {
  const pixels = new Uint8Array([
    // A block that saw 2.0 to 2.5 m.
    ...pack(2 / PROBE_RANGE_M),
    ...pack(2.5 / PROBE_RANGE_M),
    // A block that saw nothing: nearest packed as 1, farthest as 0.
    255,
    255,
    0,
    0,
    // A block that saw 3.1 to 3.2 m.
    ...pack(3.1 / PROBE_RANGE_M),
    ...pack(3.2 / PROBE_RANGE_M),
  ]);
  const range = decodeDepthProbe(pixels);
  assert.ok(range);
  close(range.near, 2, 0.002);
  close(range.far, 3.2, 0.002);
  // Centimetre precision over the whole span.
  const fine = decodeDepthProbe(new Uint8Array([...pack(1.234 / 8), ...pack(1.235 / 8)]));
  assert.ok(fine);
  close(fine.near, 1.234, 0.001);
  close(fine.far, 1.235, 0.001);
});

test('nothing seen, or an impossible reading, decodes to null', () => {
  assert.equal(decodeDepthProbe(new Uint8Array([255, 255, 0, 0])), null);
  assert.equal(decodeDepthProbe(new Uint8Array(0)), null);
  // Near at or past far is no range at all.
  assert.equal(decodeDepthProbe(new Uint8Array([...pack(0.5), ...pack(0.5)])), null);
});
