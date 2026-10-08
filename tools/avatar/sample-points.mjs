#!/usr/bin/env node
/**
 * Surface point clouds for the hero: cloud-12k.bin and cloud-6k.bin in the EMCL format.
 *
 *   node tools/avatar/sample-points.mjs [--in apps/web/src/assets/being/guide.glb] [--out apps/web/src/assets/being] [--seed 1973]
 *
 * EMCL: 16-byte header (magic "EMCL", uint16 version 1, uint32 count, 6 zero bytes), then Int16 x,y,z triplets
 * in metres * 10000, then one Uint8 seed per point. Little-endian. Points are sampled uniformly by triangle
 * area from the rest pose and shuffled, so any prefix of the file is itself a uniform sample: the 6k cloud is
 * the first half of the 12k one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIO, kb, parseArgs } from './lib/io.mjs';
import { bounds, restPositions } from './lib/skinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MAGIC = 'EMCL';
const VERSION = 1;
const SCALE = 10000;
const COUNTS = [
  { file: 'cloud-12k.bin', count: 12000 },
  { file: 'cloud-6k.bin', count: 6000 },
];

const args = parseArgs(process.argv.slice(2));
const inPath = resolve(ROOT, args.in ?? 'apps/web/src/assets/being/guide.glb');
const outDir = resolve(ROOT, args.out ?? 'apps/web/src/assets/being');
const seed = Number(args.seed ?? 1973) >>> 0;

/** mulberry32: tiny, seedable, good enough for sampling positions. */
const createRandom = (state) => () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Every triangle of every mesh in rest-pose world space, with its area. */
const collectTriangles = (document) => {
  const triangles = [];
  let total = 0;
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue;
      const positions = restPositions(node, prim);
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : positions.length / 3;
      const index = (i) => (indices ? indices.getScalar(i) : i);
      for (let i = 0; i + 2 < count; i += 3) {
        const a = index(i) * 3;
        const b = index(i + 1) * 3;
        const c = index(i + 2) * 3;
        const abx = positions[b] - positions[a];
        const aby = positions[b + 1] - positions[a + 1];
        const abz = positions[b + 2] - positions[a + 2];
        const acx = positions[c] - positions[a];
        const acy = positions[c + 1] - positions[a + 1];
        const acz = positions[c + 2] - positions[a + 2];
        const cx = aby * acz - abz * acy;
        const cy = abz * acx - abx * acz;
        const cz = abx * acy - aby * acx;
        const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
        if (area <= 0) continue;
        total += area;
        triangles.push({ positions, a, b, c, cumulative: total });
      }
    }
  }
  return { triangles, total };
};

const samplePoints = (triangles, total, count, random) => {
  const points = new Float32Array(count * 3);
  for (let n = 0; n < count; n++) {
    const target = random() * total;
    let low = 0;
    let high = triangles.length - 1;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (triangles[mid].cumulative < target) low = mid + 1;
      else high = mid;
    }
    const { positions, a, b, c } = triangles[low];
    // Square-root trick: uniform over the triangle's area, not biased towards one corner.
    const r1 = Math.sqrt(random());
    const r2 = random();
    const wa = 1 - r1;
    const wb = r1 * (1 - r2);
    const wc = r1 * r2;
    for (let axis = 0; axis < 3; axis++) {
      points[n * 3 + axis] = wa * positions[a + axis] + wb * positions[b + axis] + wc * positions[c + axis];
    }
  }
  return points;
};

const shuffle = (points, random) => {
  const count = points.length / 3;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    for (let axis = 0; axis < 3; axis++) {
      const tmp = points[i * 3 + axis];
      points[i * 3 + axis] = points[j * 3 + axis];
      points[j * 3 + axis] = tmp;
    }
  }
};

const encode = (points, count, random) => {
  const buffer = Buffer.alloc(16 + count * 6 + count);
  buffer.write(MAGIC, 0, 'ascii');
  buffer.writeUInt16LE(VERSION, 4);
  buffer.writeUInt32LE(count, 6);
  let offset = 16;
  for (let i = 0; i < count * 3; i++) {
    const value = Math.round(points[i] * SCALE);
    if (value < -32768 || value > 32767)
      throw new Error(`point coordinate ${points[i]} m does not fit Int16 at 1/${SCALE} m`);
    buffer.writeInt16LE(value, offset);
    offset += 2;
  }
  for (let i = 0; i < count; i++) {
    buffer.writeUInt8(Math.floor(random() * 256), offset);
    offset += 1;
  }
  return buffer;
};

const main = async () => {
  const io = await createIO();
  const document = await io.readBinary(readFileSync(inPath));
  const { triangles, total } = collectTriangles(document);
  if (!triangles.length) throw new Error(`${inPath} has no triangles to sample`);
  const random = createRandom(seed);
  const largest = Math.max(...COUNTS.map((entry) => entry.count));
  const points = samplePoints(triangles, total, largest, random);
  shuffle(points, random);
  const box = bounds([points]);
  mkdirSync(outDir, { recursive: true });
  for (const { file, count } of COUNTS) {
    const encoded = encode(points, count, random);
    writeFileSync(join(outDir, file), encoded);
    console.log(`${file}: ${count} points, ${kb(encoded.byteLength)}`);
  }
  console.log(
    `sampled ${triangles.length} triangles, ${total.toFixed(3)} m2 of surface; bounds x ${box.min[0].toFixed(3)}..${box.max[0].toFixed(3)} y ${box.min[1].toFixed(3)}..${box.max[1].toFixed(3)} z ${box.min[2].toFixed(3)}..${box.max[2].toFixed(3)} m`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
