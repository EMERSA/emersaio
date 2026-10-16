/**
 * The seam report: Head and Body must meet along their shared boundary so the runtime can weld them with a
 * 0.1 mm tolerance, at rest and with any morph applied (the Body never morphs, so the Head's seam must not move).
 *
 * Boundary edges are edges used by one triangle only. The Head's teeth and tongue (part id 1 and 2 in the
 * `_SCULPT` attribute) are separate islands inside the mouth and are left out; everything else on the Head's
 * boundary pairs with its nearest Body boundary vertex. Positions are read through the skin in the rest pose
 * (lib/skinned.mjs), so the dequantisation folded into the inverse bind matrices is honoured.
 */

import { readSculpt } from './sculpt.mjs';
import { restPositions } from './skinned.mjs';

/** The build fails above this distance (metres). */
export const SEAM_TOLERANCE_M = 1e-4;
/** A Head boundary vertex further than this from every Body boundary vertex is not on the seam (metres). */
const SEAM_SEARCH_M = 0.01;

/** Part id per vertex (0 skin, 1 teeth, 2 tongue) from `_SCULPT`, or all skin when the file has none. */
const partIds = (prim) => readSculpt(prim)?.part ?? new Uint8Array(prim.getAttribute('POSITION')?.getCount() ?? 0);

/** Triangle corner indices of a primitive (non-indexed primitives are read as 0, 1, 2, ...). */
const triangleIndices = (prim) => {
  const indices = prim.getIndices();
  if (indices) return Array.from(indices.getArray());
  const count = prim.getAttribute('POSITION')?.getCount() ?? 0;
  return Array.from({ length: count }, (_, i) => i);
};

/**
 * Boundary loops of the triangles whose three corners pass `keep`, as arrays of vertex indices.
 * @param {number[]} indices
 * @param {(vertex: number) => boolean} keep
 */
export const boundaryLoops = (indices, keep) => {
  const uses = new Map();
  const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const corners = [indices[t], indices[t + 1], indices[t + 2]];
    if (!corners.every(keep)) continue;
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(corners[k], corners[(k + 1) % 3]);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const neighbours = new Map();
  for (const [key, count] of uses) {
    if (count !== 1) continue;
    const [a, b] = key.split(',').map(Number);
    if (!neighbours.has(a)) neighbours.set(a, []);
    if (!neighbours.has(b)) neighbours.set(b, []);
    neighbours.get(a).push(b);
    neighbours.get(b).push(a);
  }
  const seen = new Set();
  const loops = [];
  for (const start of neighbours.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    const stack = [start];
    while (stack.length) {
      const vertex = stack.pop();
      if (seen.has(vertex)) continue;
      seen.add(vertex);
      loop.push(vertex);
      for (const next of neighbours.get(vertex)) if (!seen.has(next)) stack.push(next);
    }
    loops.push(loop);
  }
  return loops;
};

const distance = (a, i, b, j) =>
  Math.hypot(a[i * 3] - b[j * 3], a[i * 3 + 1] - b[j * 3 + 1], a[i * 3 + 2] - b[j * 3 + 2]);

/** The Head node and primitive, and the Body's, by mesh name. */
const findParts = (document, names) => {
  const found = {};
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (mesh.getName() === names.head) found.head = { node, prim: mesh.listPrimitives()[0] };
    if (mesh.getName() === names.body) found.body = { node, prim: mesh.listPrimitives()[0] };
  }
  return found;
};

/** Local (accessor-space) positions plus `weight` times one morph target, for restPositions(), in doubles like the
 * rest-pose path, so a zero offset reproduces the rest position exactly. */
const morphedLocal = (prim, target, weight) => {
  const position = prim.getAttribute('POSITION');
  const count = position.getCount();
  const out = new Float64Array(count * 3);
  const element = [0, 0, 0];
  const delta = [0, 0, 0];
  const offset = target?.getAttribute('POSITION') ?? null;
  for (let i = 0; i < count; i++) {
    position.getElement(i, element);
    if (offset) offset.getElement(i, delta);
    for (let axis = 0; axis < 3; axis++) out[i * 3 + axis] = element[axis] + (offset ? weight * delta[axis] : 0);
  }
  return out;
};

/** Joint name to weight for one vertex, so two skins with different joint orders compare fairly. */
const influences = (node, prim, vertex) => {
  const joints = prim.getAttribute('JOINTS_0');
  const weights = prim.getAttribute('WEIGHTS_0');
  const skin = node.getSkin();
  const result = new Map();
  if (!joints || !weights || !skin) return result;
  const list = skin.listJoints();
  const j = [0, 0, 0, 0];
  const w = [0, 0, 0, 0];
  joints.getElement(vertex, j);
  weights.getElement(vertex, w);
  for (let k = 0; k < 4; k++) {
    if (w[k] === 0) continue;
    const name = list[j[k]]?.getName() ?? `#${j[k]}`;
    result.set(name, (result.get(name) ?? 0) + w[k]);
  }
  return result;
};

const influenceDifference = (a, b) => {
  let worst = 0;
  for (const name of new Set([...a.keys(), ...b.keys()]))
    worst = Math.max(worst, Math.abs((a.get(name) ?? 0) - (b.get(name) ?? 0)));
  return worst;
};

/**
 * Measure the Head/Body seam of a gltf-transform Document.
 * @param {import('@gltf-transform/core').Document} document
 * @param {{ head: string, body: string }} names mesh names from the contract
 * @param {string[]} morphNames the Head's target names, in order
 */
export const seamReport = (document, names, morphNames) => {
  const { head, body } = findParts(document, names);
  if (!head || !body) return { ok: false, reason: 'the file has no Head or no Body mesh', pairs: 0 };
  const headParts = partIds(head.prim);
  const headIndices = triangleIndices(head.prim);
  const bodyIndices = triangleIndices(body.prim);
  const headLoops = boundaryLoops(headIndices, (vertex) => headParts[vertex] === 0);
  const bodyLoops = boundaryLoops(bodyIndices, () => true);
  const headRest = restPositions(head.node, head.prim);
  const bodyRest = restPositions(body.node, body.prim);
  const bodyBoundary = bodyLoops.flat();

  // Pair every Head boundary vertex with its nearest Body boundary vertex (the seam is a few dozen vertices).
  const pairs = [];
  let offSeam = 0;
  for (const vertex of headLoops.flat()) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of bodyBoundary) {
      const d = distance(headRest, vertex, bodyRest, candidate);
      if (d < bestDistance) {
        bestDistance = d;
        best = candidate;
      }
    }
    if (bestDistance > SEAM_SEARCH_M) offSeam++;
    else pairs.push([vertex, best]);
  }
  const pairedBody = new Set(pairs.map(([, b]) => b));
  const unpairedBody = bodyBoundary.filter((vertex) => !pairedBody.has(vertex)).length;
  const sharedPartners = pairs.length - pairedBody.size;

  const gap = (positions) => {
    let worst = 0;
    for (const [h, b] of pairs) worst = Math.max(worst, distance(positions, h, bodyRest, b));
    return worst;
  };
  const rest = gap(headRest);
  const targets = head.prim.listTargets();
  const perMorph = morphNames.map((name, index) => {
    const local = morphedLocal(head.prim, targets[index], 1);
    return { name, gap: gap(restPositions(head.node, head.prim, local)) };
  });
  const jawOpen = perMorph.find((entry) => entry.name === 'jawOpen')?.gap ?? Number.NaN;
  const worst = perMorph.reduce((a, b) => (b.gap > a.gap ? b : a), { name: 'none', gap: 0 });
  let weightDifference = 0;
  for (const [h, b] of pairs) {
    weightDifference = Math.max(
      weightDifference,
      influenceDifference(influences(head.node, head.prim, h), influences(body.node, body.prim, b)),
    );
  }
  const ok =
    pairs.length > 0 &&
    unpairedBody === 0 &&
    sharedPartners === 0 &&
    rest <= SEAM_TOLERANCE_M &&
    jawOpen <= SEAM_TOLERANCE_M &&
    worst.gap <= SEAM_TOLERANCE_M;
  return {
    ok,
    pairs: pairs.length,
    headLoops: headLoops.map((loop) => loop.length).sort((a, b) => b - a),
    bodyLoops: bodyLoops.map((loop) => loop.length).sort((a, b) => b - a),
    offSeam,
    unpairedBody,
    sharedPartners,
    rest,
    jawOpen,
    worst,
    weightDifference,
  };
};

/** One line per figure for the build log. */
export const describeSeams = (report) => {
  if (!report.pairs) return `seam: ${report.reason ?? 'no seam found'}`;
  const mm = (metres) => `${(metres * 1000).toFixed(4)} mm`;
  return [
    `seam: ${report.pairs} paired vertices (Head loops ${report.headLoops.join('/')}, Body loops ${report.bodyLoops.join('/')}${report.offSeam ? `, ${report.offSeam} Head boundary vertices off the seam` : ''}${report.unpairedBody ? `, ${report.unpairedBody} Body boundary vertices unpaired` : ''})`,
    `gap at rest ${mm(report.rest)}, jawOpen ${mm(report.jawOpen)}, worst morph ${report.worst.name} ${mm(report.worst.gap)}, skin weight difference ${report.weightDifference.toFixed(4)}`,
  ].join('; ');
};
