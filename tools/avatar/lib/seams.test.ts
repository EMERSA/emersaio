/**
 * The seam report (lib/seams.mjs) and the _SCULPT encoding (lib/sculpt.mjs) on a tiny figure: an octahedron cut at
 * its equator into a Head (the upper half, plus a loose "tooth" triangle and two morph targets) and a Body (the lower
 * half), which meet on the four equator vertices. Runs with "node --test tools/**\/*.test.ts".
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document } from '@gltf-transform/core';
import { quantizeSculpt, readSculpt } from './sculpt.mjs';
import { boundaryLoops, SEAM_TOLERANCE_M, seamReport } from './seams.mjs';

const R = 0.1;
const EQUATOR = [R, 0, 0, 0, 0, R, -R, 0, 0, 0, 0, -R];
const MESHES = { head: 'Head', body: 'Body' };

/** Head: apex 0, equator 1..4, tooth 5..7 (part 1). Body: apex 0, equator 1..4. */
function figure(morphs: Record<string, number[]>) {
  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (array: Float32Array | Uint16Array, type: 'SCALAR' | 'VEC3' | 'VEC4') =>
    document.createAccessor().setArray(array).setType(type).setBuffer(buffer);
  const scene = document.createScene();

  const headPositions = [0, R, 0, ...EQUATOR, 0, 0.5 * R, 0.2 * R, 0.01, 0.5 * R, 0.2 * R, 0, 0.51 * R, 0.2 * R];
  const headSculpt = [...Array(5).fill([0.9, 1, 0, 1]).flat(), ...Array(3).fill([0.2, 0.92, 1, 0]).flat()];
  const head = document
    .createPrimitive()
    .setAttribute('POSITION', accessor(new Float32Array(headPositions), 'VEC3'))
    .setAttribute('_SCULPT', accessor(new Float32Array(headSculpt), 'VEC4'))
    .setIndices(accessor(new Uint16Array([0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 6, 7]), 'SCALAR'));
  for (const [name, offsets] of Object.entries(morphs)) {
    const target = document.createPrimitiveTarget(name);
    target.setAttribute('POSITION', accessor(new Float32Array(offsets), 'VEC3'));
    head.addTarget(target);
  }
  const headMesh = document
    .createMesh(MESHES.head)
    .addPrimitive(head)
    .setExtras({ targetNames: Object.keys(morphs) });
  scene.addChild(document.createNode(MESHES.head).setMesh(headMesh));

  const body = document
    .createPrimitive()
    .setAttribute('POSITION', accessor(new Float32Array([0, -R, 0, ...EQUATOR]), 'VEC3'))
    .setAttribute('_SCULPT', accessor(new Float32Array(Array(5).fill([0.8, 1, 0, 1]).flat()), 'VEC4'))
    .setIndices(accessor(new Uint16Array([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]), 'SCALAR'));
  scene.addChild(document.createNode(MESHES.body).setMesh(document.createMesh(MESHES.body).addPrimitive(body)));
  return document;
}

/** Offsets for the eight Head vertices with one vertex moved. */
const moving = (vertex: number, dx: number, dy: number) => {
  const offsets = new Array(8 * 3).fill(0);
  offsets[vertex * 3] = dx;
  offsets[vertex * 3 + 1] = dy;
  return offsets;
};

test('boundary loops follow the open edges and skip what the filter leaves out', () => {
  const head = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 6, 7];
  assert.deepEqual(
    boundaryLoops(head, (vertex: number) => vertex < 5).map((loop: number[]) => loop.length),
    [4],
  );
  assert.equal(boundaryLoops(head, () => true).length, 2);
  const closed = [0, 2, 1, 0, 3, 2, 0, 4, 3, 0, 1, 4, 5, 1, 2, 5, 2, 3, 5, 3, 4, 5, 4, 1];
  assert.equal(boundaryLoops(closed, () => true).length, 0);
});

test('a seam the morphs leave alone passes, the teeth do not count as seam', () => {
  const document = figure({ jawOpen: moving(0, 0, -0.02), tongueOut: moving(6, 0.03, 0) });
  const report = seamReport(document, MESHES, ['jawOpen', 'tongueOut']);
  assert.equal(report.ok, true);
  assert.equal(report.pairs, 4);
  assert.deepEqual(report.headLoops, [4]);
  assert.deepEqual(report.bodyLoops, [4]);
  assert.equal(report.rest, 0);
  assert.equal(report.jawOpen, 0);
  assert.equal(report.worst.gap, 0);
});

test('a morph that moves a seam vertex by 1 mm fails the report and is named', () => {
  const document = figure({ jawOpen: moving(0, 0, -0.02), mouthLeft: moving(1, 0.001, 0) });
  const report = seamReport(document, MESHES, ['jawOpen', 'mouthLeft']);
  assert.equal(report.ok, false);
  assert.equal(report.worst.name, 'mouthLeft');
  assert.ok(Math.abs(report.worst.gap - 0.001) < 1e-6);
  assert.ok(report.worst.gap > SEAM_TOLERANCE_M);
});

test('_SCULPT is stored as normalised bytes with the part id in the byte itself', () => {
  const document = figure({ jawOpen: moving(0, 0, -0.02) });
  assert.equal(quantizeSculpt(document), 2);
  assert.equal(quantizeSculpt(document), 0);
  const head = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
  assert.ok(head);
  const attribute = head.getAttribute('_SCULPT');
  assert.ok(attribute?.getNormalized());
  assert.equal(attribute?.getArray()?.constructor, Uint8Array);
  const sculpt = readSculpt(head);
  assert.ok(sculpt);
  assert.deepEqual([...sculpt.part], [0, 0, 0, 0, 0, 1, 1, 1]);
  assert.ok(Math.abs((sculpt.ao[5] ?? 0) - 0.2) < 1 / 255);
  assert.ok(Math.abs((sculpt.tone[5] ?? 0) - 0.92) < 1 / 255);
  assert.equal(sculpt.calm[0], 1);
  assert.equal(sculpt.calm[5], 0);
});
