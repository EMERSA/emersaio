/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { albedoOf, buildShards, type MeshPart, shardCount, weld } from '../src/sculpture/build.ts';

/** Two triangles sharing an edge, as two parts whose shared vertices coincide; per vertex ao, tone, part, calm. */
const parts = () => [
  {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    index: [0, 1, 2],
    sculpt: [1, 0.8, 0, 1, 1, 0.3, 0, 1, 1, 0.92, 1 / 255, 1],
  },
  { positions: new Float32Array([1, 0, 0, 0, 1, 0, 1, 1, 0]), index: [0, 1, 2], sculpt: null },
];

test('weld: coincident vertices become one, the first part owns them, the lips are found by tone', () => {
  const welded = weld(parts(), () => true);
  assert.equal(welded.count, 4);
  assert.equal(welded.tris.length, 6);
  assert.deepEqual(Array.from(welded.lips), [0]);
  assert.deepEqual(
    Array.from(welded.tone, (t) => Math.round(t * 100) / 100),
    [0.8, 0.3, 0.92, 1],
  );
});

test('the mouth reads: lips a touch bright, teeth and tongue in shadow, the inside near black, eyes untouched', () => {
  assert.ok(albedoOf(0.8, 0) > 1);
  assert.equal(albedoOf(1, 0), 1);
  assert.ok(albedoOf(0.92, 1) < 0.5, 'teeth');
  assert.ok(albedoOf(0.55, 2) < 0.3, 'tongue');
  assert.ok(albedoOf(0.3, 0) < 0.06, 'mouth interior');
  const welded = weld(parts(), () => true);
  assert.ok((welded.albedo[2] ?? 1) < 0.5, 'the teeth vertex is dark');
  const eye = weld([{ ...(parts()[0] as MeshPart), plain: true }], () => true);
  assert.deepEqual(Array.from(eye.albedo), Array.from(eye.tone), 'a plain part keeps its tone');
});

test('shards: n x n per triangle from its longest edge, and their centres inside it', () => {
  const welded = weld(parts(), () => true);
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  const count = shardCount(welded.tris, positions, () => 1, 0.25);
  // Longest edge sqrt(2) over 0.25 -> n = 6, so 36 shards per triangle.
  assert.equal(count, 72);
  const shards = buildShards(welded.tris, positions, () => 1, 0.25);
  assert.equal(shards.count, 72);
  for (let s = 0; s < shards.count; s += 1) {
    const u = shards.shard[s * 4] ?? -1;
    const v = shards.shard[s * 4 + 1] ?? -1;
    assert.ok(u > 0 && v > 0 && u + v < 1);
  }
});
