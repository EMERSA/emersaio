/**
 * Reads the asset contract (tables/contract.json) and checks a gltf-transform Document against it.
 * Shared by build.mjs (fails the build) and sample-points.mjs (finds the meshes to sample).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONTRACT_PATH = fileURLToPath(new URL('../tables/contract.json', import.meta.url));

/** @returns {{ height: number, meshes: { head: string, body: string }, morphs: { required: string[], optional: string[] }, bones: { required: string[], optional: string[] }, clips: { required: string[], optional: string[] }, budgets: Record<string, number> }} */
export const loadContract = () => JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));

/**
 * Morph target names of a mesh. The Blender exporter stores them in mesh extras; gltf-transform mirrors them
 * onto the primitive targets, which is what the loader in the browser also reads.
 * @param {import('@gltf-transform/core').Mesh} mesh
 * @returns {string[]}
 */
export const morphNames = (mesh) => {
  const extras = mesh.getExtras();
  const fromExtras = Array.isArray(extras?.targetNames) ? extras.targetNames.map(String) : null;
  const prim = mesh.listPrimitives()[0];
  if (!prim) return fromExtras ?? [];
  const fromTargets = prim.listTargets().map((target) => target.getName());
  return fromExtras && fromExtras.length === fromTargets.length ? fromExtras : fromTargets;
};

/**
 * @param {import('@gltf-transform/core').Document} document
 * @returns {{ head: import('@gltf-transform/core').Mesh | null, body: import('@gltf-transform/core').Mesh | null, morphs: string[], bones: string[], clips: string[] }}
 */
export const inventory = (document) => {
  const contract = loadContract();
  const root = document.getRoot();
  const meshes = root.listMeshes();
  const head = meshes.find((mesh) => mesh.getName() === contract.meshes.head) ?? null;
  const body = meshes.find((mesh) => mesh.getName() === contract.meshes.body) ?? null;
  const bones = new Set();
  for (const skin of root.listSkins()) for (const joint of skin.listJoints()) bones.add(joint.getName());
  return {
    head,
    body,
    morphs: head ? morphNames(head) : [],
    bones: [...bones],
    clips: root.listAnimations().map((animation) => animation.getName()),
  };
};

/**
 * Compares the inventory with the contract.
 * @param {ReturnType<typeof inventory>} found
 * @param {{ requireBody?: boolean }} [options]
 * @returns {{ errors: string[], warnings: string[] }}
 */
export const check = (found, options = {}) => {
  const contract = loadContract();
  const errors = [];
  const warnings = [];
  if (!found.head) errors.push(`mesh "${contract.meshes.head}" is missing`);
  if (!found.body && options.requireBody !== false) errors.push(`mesh "${contract.meshes.body}" is missing`);
  const missing = (required, present, kind) => {
    const have = new Set(present);
    return required.filter((name) => !have.has(name)).map((name) => `${kind} "${name}" is missing`);
  };
  errors.push(...missing(contract.morphs.required, found.morphs, 'morph'));
  errors.push(...missing(contract.bones.required, found.bones, 'bone'));
  errors.push(...missing(contract.clips.required, found.clips, 'clip'));
  warnings.push(...missing(contract.morphs.optional, found.morphs, 'optional morph'));
  warnings.push(...missing(contract.bones.optional, found.bones, 'optional bone'));
  warnings.push(...missing(contract.clips.optional, found.clips, 'optional clip'));
  if (found.body?.listPrimitives().some((prim) => prim.listTargets().length > 0)) {
    errors.push('the Body mesh carries morph targets; only Head may morph');
  }
  return { errors, warnings };
};
