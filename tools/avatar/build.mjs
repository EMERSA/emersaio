#!/usr/bin/env node
/**
 * Raw Blender GLBs -> the shipped guide.glb and guide-lite.glb.
 *
 *   node tools/avatar/build.mjs [--in tools/avatar/src/guide-raw.glb] [--lite-in tools/avatar/src/guide-lite-raw.glb]
 *                               [--report tools/avatar/src/build-report.json] [--out apps/web/src/assets/being]
 *                               [--allow-oversize]
 *
 * Pipeline: strip everything but positions, skin weights, _SCULPT and morph positions; drop materials; store
 * _SCULPT as normalised bytes; put the measured eye radius on the eye bones; dedup; prune; resample clips; meshopt
 * (reorder + int16 quantisation on one grid for the whole figure + EXT_meshopt_compression); then keep whichever of
 * dense or sparse morph storage is smaller. Fails when a contract name is missing, a size budget is blown or the
 * Head/Body seam opens by more than 0.1 mm at rest or under any morph (lib/seams.mjs).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PropertyType } from '@gltf-transform/core';
import { cloneDocument, dedup, meshopt, prune, resample, sparse } from '@gltf-transform/functions';
import { check, inventory, loadContract } from './lib/contract.mjs';
import { createIO, kb, MeshoptEncoder, parseArgs } from './lib/io.mjs';
import { describeSculpt, quantizeSculpt, SCULPT } from './lib/sculpt.mjs';
import { describeSeams, SEAM_TOLERANCE_M, seamReport } from './lib/seams.mjs';
import { bounds, restPositions } from './lib/skinned.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const KEEP_ATTRIBUTES = new Set(['POSITION', 'JOINTS_0', 'WEIGHTS_0', SCULPT]);

const args = parseArgs(process.argv.slice(2));
const rawPath = resolve(ROOT, args.in ?? 'tools/avatar/src/guide-raw.glb');
const liteRawPath = resolve(ROOT, args['lite-in'] ?? 'tools/avatar/src/guide-lite-raw.glb');
const reportPath = resolve(ROOT, args.report ?? join(dirname(rawPath), 'build-report.json'));
const outDir = resolve(ROOT, args.out ?? 'apps/web/src/assets/being');
const allowOversize = args['allow-oversize'] === true;
const contract = loadContract();

/** The eye measurements build.py took from MakeHuman's helper eyeballs, or null without a report. */
const readEyes = () => {
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8')).eyes ?? null;
  } catch {
    return null;
  }
};

/** Keep the runtime's inputs only; everything else is weight a phone would download for nothing. */
const strip = (document) => {
  const root = document.getRoot();
  for (const mesh of root.listMeshes()) {
    const isHead = mesh.getName() === contract.meshes.head;
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(null);
      for (const semantic of prim.listSemantics()) {
        if (!KEEP_ATTRIBUTES.has(semantic)) prim.setAttribute(semantic, null);
      }
      for (const target of prim.listTargets()) {
        if (!isHead) {
          prim.removeTarget(target);
          continue;
        }
        for (const semantic of target.listSemantics()) {
          if (semantic !== 'POSITION') target.setAttribute(semantic, null);
        }
      }
    }
    if (!isHead) mesh.setWeights([]);
  }
  for (const node of root.listNodes()) {
    if (node.getMesh()?.getName() !== contract.meshes.head) node.setWeights([]);
  }
  for (const material of root.listMaterials()) material.dispose();
  for (const texture of root.listTextures()) texture.dispose();
};

/**
 * Blender writes translation, rotation and scale channels for every bone of every clip. Keep only the
 * (node, path) pairs that actually move in at least one clip: every clip still resets what another clip
 * animates, and the rest-pose channels of the other fifty bones stop costing a few kilobytes of JSON each.
 */
const pruneClips = (document) => {
  const animations = document.getRoot().listAnimations();
  const varying = new Set();
  const key = (channel) => `${channel.getTargetNode()?.getName() ?? ''}:${channel.getTargetPath()}`;
  const isVarying = (channel) => {
    const output = channel.getSampler()?.getOutput();
    if (!output) return false;
    const size = output.getElementSize();
    const first = new Array(size).fill(0);
    const element = new Array(size).fill(0);
    output.getElement(0, first);
    for (let i = 1; i < output.getCount(); i++) {
      output.getElement(i, element);
      for (let k = 0; k < size; k++) if (Math.abs(element[k] - first[k]) > 1e-5) return true;
    }
    return false;
  };
  for (const animation of animations) {
    for (const channel of animation.listChannels()) if (isVarying(channel)) varying.add(key(channel));
  }
  let removed = 0;
  for (const animation of animations) {
    for (const channel of animation.listChannels()) {
      if (varying.has(key(channel))) continue;
      const sampler = channel.getSampler();
      channel.dispose();
      if (sampler && !sampler.listParents().some((parent) => parent.propertyType === 'AnimationChannel'))
        sampler.dispose();
      removed++;
    }
  }
  return { kept: varying.size, removed };
};

const triangles = (mesh) =>
  mesh.listPrimitives().reduce((sum, prim) => {
    const indices = prim.getIndices();
    const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
    return sum + Math.floor(count / 3);
  }, 0);

const clipSeconds = (animation) => {
  let max = 0;
  for (const sampler of animation.listSamplers()) {
    const input = sampler.getInput();
    if (input) max = Math.max(max, input.getMax([0])[0]);
  }
  return max;
};

/** Height, floor and facing from the rest pose, so a wrong axis convention is caught here, not in the browser. */
const geometryReport = (document) => {
  const root = document.getRoot();
  const arrays = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) arrays.push(restPositions(node, prim));
  }
  const box = bounds(arrays);
  const joints = new Map();
  for (const skin of root.listSkins()) {
    for (const joint of skin.listJoints()) joints.set(joint.getName(), joint.getWorldMatrix().slice(12, 15));
  }
  const warnings = [];
  const height = box.max[1] - box.min[1];
  if (Math.abs(height - contract.height) > 0.02)
    warnings.push(`height is ${height.toFixed(3)} m, contract says ${contract.height}`);
  if (Math.abs(box.min[1]) > 0.01) warnings.push(`feet are at y=${box.min[1].toFixed(3)}, expected 0`);
  const head = joints.get('Head');
  const leftEye = joints.get('LeftEye');
  if (head && leftEye) {
    if (leftEye[2] <= head[2]) warnings.push('eyes are not in front of the head joint: the figure may not face +Z');
    if (leftEye[0] <= 0) warnings.push('LeftEye is not on +X: the figure may be mirrored');
  }
  return { height, box, warnings };
};

/**
 * The runtime draws its own eyeballs on the eye bones, so the eyeball radius build.py measured from MakeHuman's helper
 * eyes travels with them as extras.eyeRadius (metres); three.js's GLTFLoader puts it in bone.userData.eyeRadius.
 */
const tagEyes = (document, eyes) => {
  if (!eyes) {
    console.warn(`  warning: no eye measurements in ${reportPath}; the eye bones carry no eyeRadius`);
    return;
  }
  for (const node of document.getRoot().listNodes()) {
    const eye = eyes[node.getName()];
    if (eye) node.setExtras({ ...node.getExtras(), eyeRadius: eye.radius });
  }
};

const optimise = async (document) => {
  await document.transform(
    dedup(),
    prune({ keepAttributes: false, keepIndices: false, keepLeaves: false, keepSolidTextures: false }),
    resample(),
    // One 16-bit quantisation grid for the whole figure (about 0.03 mm over its 1.75 m). Head and Body hold the same
    // float position for each seam vertex, so on a shared grid they quantise to the same integers and the seam stays
    // exact; per-mesh grids would put them up to half a 14-bit step (0.05 mm) apart. The quantiser's own cleanup would
    // fold the two skins, now identical, into one, so it is off and the prune and dedup below keep both.
    meshopt({
      encoder: MeshoptEncoder,
      level: 'high',
      quantizationVolume: 'scene',
      quantizePosition: 16,
      cleanup: false,
    }),
    prune({ keepAttributes: true, keepIndices: true, keepLeaves: true, keepSolidTextures: true }),
    dedup({ propertyTypes: [PropertyType.ACCESSOR] }),
  );
};

/** Dense morphs compress through meshopt; sparse ones bypass it. Measure both and ship the smaller. */
const encodeSmallest = async (io, document) => {
  const dense = cloneDocument(document);
  await optimise(dense);
  const denseBytes = await io.writeBinary(dense);
  const sparseDoc = cloneDocument(document);
  await optimise(sparseDoc);
  await sparseDoc.transform(sparse({ ratio: 1 / 3 }));
  const sparseBytes = await io.writeBinary(sparseDoc);
  const useSparse = sparseBytes.byteLength < denseBytes.byteLength;
  return { bytes: useSparse ? sparseBytes : denseBytes, mode: useSparse ? 'sparse' : 'dense', denseBytes, sparseBytes };
};

const buildOne = async (io, document, fileName, budget, eyes) => {
  strip(document);
  const found = inventory(document);
  const result = check(found);
  for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`  error: ${error}`);
    throw new Error(`${fileName} does not honour the avatar contract`);
  }
  const geometry = geometryReport(document);
  for (const warning of geometry.warnings) console.warn(`  warning: ${warning}`);
  quantizeSculpt(document);
  tagEyes(document, eyes);
  const pruned = pruneClips(document);
  const encoded = await encodeSmallest(io, document);

  // Re-read the encoded bytes before anything is written: proves the file decodes with the meshopt decoder the
  // browser will use, and the seam is measured on exactly what ships.
  const reread = await io.readBinary(encoded.bytes);
  const shipped = inventory(reread);
  const seams = shipped.body ? seamReport(reread, contract.meshes, shipped.morphs) : null;
  if (seams && !seams.ok) {
    console.error(`  ${describeSeams(seams)}`);
    throw new Error(`${fileName}: Head and Body do not meet within ${SEAM_TOLERANCE_M * 1000} mm`);
  }
  if (encoded.bytes.byteLength > budget) {
    const message = `${fileName} is ${kb(encoded.bytes.byteLength)}, over its ${kb(budget)} budget`;
    if (!allowOversize) throw new Error(message);
    console.warn(`  warning: ${message}`);
  }
  const outPath = join(outDir, fileName);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, encoded.bytes);
  const clips = reread
    .getRoot()
    .listAnimations()
    .map((animation) => `${animation.getName()} ${clipSeconds(animation).toFixed(2)}s`);
  const primitive = (mesh) => mesh?.listPrimitives()[0];
  console.log(
    `${fileName}: ${kb(encoded.bytes.byteLength)} (${encoded.mode} morphs; dense ${kb(encoded.denseBytes.byteLength)}, sparse ${kb(encoded.sparseBytes.byteLength)}), budget ${kb(budget)}`,
  );
  console.log(
    `  head ${shipped.head ? `${triangles(shipped.head)} tris, ${primitive(shipped.head)?.getAttribute('POSITION')?.getCount()} verts, ${shipped.morphs.length} morphs; ${describeSculpt(primitive(shipped.head))}` : 'missing'}`,
  );
  console.log(
    `  body ${shipped.body ? `${triangles(shipped.body)} tris, ${primitive(shipped.body)?.getAttribute('POSITION')?.getCount()} verts; ${describeSculpt(primitive(shipped.body))}` : 'absent'}`,
  );
  console.log(
    `  bones ${shipped.bones.length} (${reread.getRoot().listSkins().length} skins), clips ${clips.join(', ')} (${pruned.kept} animated channels per clip, ${pruned.removed} rest-pose channels dropped), height ${geometry.height.toFixed(3)} m`,
  );
  if (seams) console.log(`  ${describeSeams(seams)}`);
  return shipped;
};

/** The repository lints generated JSON too, so hand it to Biome's formatter rather than imitating it. Biome refuses
 * files outside the repository (a --report or --in elsewhere), and then formats none, so those are left out. */
const formatJson = (paths) => {
  const biome = resolve(ROOT, 'node_modules/@biomejs/biome/bin/biome');
  const inside = (path) => !relative(ROOT, path).startsWith('..') && !isAbsolute(relative(ROOT, path));
  const present = paths.filter((path) => existsSync(path) && inside(path));
  if (!present.length) return;
  try {
    execFileSync(process.execPath, [biome, 'format', '--write', ...present], { stdio: 'ignore' });
  } catch {
    console.warn('  warning: biome format did not run; `npm run lint` may complain about generated JSON');
  }
};

const main = async () => {
  const io = await createIO();
  const eyes = readEyes();
  if (eyes)
    console.log(
      `eyes: radius ${Object.values(eyes)
        .map((eye) => `${(eye.radius * 1000).toFixed(1)} mm`)
        .join(' / ')}`,
    );
  const full = await buildOne(io, await io.read(rawPath), 'guide.glb', contract.budgets['guide.glb'], eyes);

  let liteDocument;
  try {
    liteDocument = await io.read(liteRawPath);
  } catch {
    // Without a Blender lite export, the lite file is the full head alone; the hero point cloud stands in for the body.
    console.warn(`  no ${liteRawPath}; deriving guide-lite.glb from the full figure without the Body mesh`);
    liteDocument = await io.read(rawPath);
    for (const node of liteDocument.getRoot().listNodes()) {
      if (node.getMesh()?.getName() === contract.meshes.body) node.dispose();
    }
    for (const mesh of liteDocument.getRoot().listMeshes()) {
      if (mesh.getName() === contract.meshes.body) mesh.dispose();
    }
  }
  await buildOne(io, liteDocument, 'guide-lite.glb', contract.budgets['guide-lite.glb'], eyes);

  const tables = join(HERE, 'tables');
  writeFileSync(
    join(tables, 'morphs.json'),
    `${JSON.stringify({ mesh: contract.meshes.head, names: full.morphs }, null, 2)}\n`,
  );
  writeFileSync(join(tables, 'rig.json'), `${JSON.stringify({ bones: full.bones, clips: full.clips }, null, 2)}\n`);
  formatJson([join(tables, 'morphs.json'), join(tables, 'rig.json'), reportPath]);
  console.log(
    `tables: ${full.morphs.length} morph names -> tables/morphs.json, ${full.bones.length} bones and ${full.clips.length} clips -> tables/rig.json`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
