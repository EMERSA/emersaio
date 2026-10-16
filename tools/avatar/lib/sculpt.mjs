/**
 * The _SCULPT vertex attribute of Head and Body (three.js lowercases it: geometry.attributes._sculpt). build.py bakes
 * it as four floats (blender/sculpt.py); build.mjs stores it as four normalised unsigned bytes:
 *
 *   r  ambient occlusion: 0 fully occluded, 1 open (Cycles AO, 64 samples, 5 cm)
 *   g  tone: skin 1, lips 0.8, teeth 0.92, tongue 0.55, mouth interior 0.3
 *   b  part id, stored as the byte itself (0 skin, 1 teeth, 2 tongue): a reader takes Math.round(b * 255)
 *   a  calm, how much the water may move the vertex: 0 teeth and tongue, 0.35 on and around the eyes and mouth, 1
 *      elsewhere
 */

import { Accessor } from '@gltf-transform/core';

export const SCULPT = '_SCULPT';
export const PART = Object.freeze({ skin: 0, teeth: 1, tongue: 2 });

const toByte = (value) => Math.min(255, Math.max(0, Math.round(value * 255)));

/**
 * Store every _SCULPT attribute as normalised bytes, in place. Accessors already stored that way are left alone.
 * @param {import('@gltf-transform/core').Document} document
 * @returns {number} how many accessors were converted
 */
export const quantizeSculpt = (document) => {
  let converted = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const attribute = prim.getAttribute(SCULPT);
      if (!attribute || attribute.getComponentType() === Accessor.ComponentType.UNSIGNED_BYTE) continue;
      if (attribute.getElementSize() !== 4) throw new Error(`${SCULPT} on ${mesh.getName()} is not a VEC4`);
      const count = attribute.getCount();
      const bytes = new Uint8Array(count * 4);
      const element = [0, 0, 0, 0];
      for (let i = 0; i < count; i++) {
        attribute.getElement(i, element);
        bytes[i * 4] = toByte(element[0]);
        bytes[i * 4 + 1] = toByte(element[1]);
        bytes[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(element[2])));
        bytes[i * 4 + 3] = toByte(element[3]);
      }
      attribute.setArray(bytes).setNormalized(true);
      converted++;
    }
  }
  return converted;
};

/**
 * Read _SCULPT whichever way it is stored (floats straight from Blender, or bytes after build.mjs).
 * @param {import('@gltf-transform/core').Primitive} prim
 * @returns {{ ao: Float32Array, tone: Float32Array, part: Uint8Array, calm: Float32Array } | null}
 */
export const readSculpt = (prim) => {
  const attribute = prim.getAttribute(SCULPT);
  if (!attribute) return null;
  const count = attribute.getCount();
  const bytes = attribute.getComponentType() === Accessor.ComponentType.UNSIGNED_BYTE && attribute.getNormalized();
  const out = {
    ao: new Float32Array(count),
    tone: new Float32Array(count),
    part: new Uint8Array(count),
    calm: new Float32Array(count),
  };
  const element = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    attribute.getElement(i, element);
    out.ao[i] = element[0];
    out.tone[i] = element[1];
    out.part[i] = Math.round(bytes ? element[2] * 255 : element[2]);
    out.calm[i] = element[3];
  }
  return out;
};

/**
 * Value ranges per channel, for the build log.
 * @param {import('@gltf-transform/core').Primitive} prim
 */
export const describeSculpt = (prim) => {
  const sculpt = readSculpt(prim);
  if (!sculpt) return 'no _SCULPT';
  const range = (values) => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const value of values) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return `${min.toFixed(2)}..${max.toFixed(2)}`;
  };
  const parts = [0, 0, 0];
  for (const part of sculpt.part) parts[part] = (parts[part] ?? 0) + 1;
  return `_SCULPT ao ${range(sculpt.ao)}, tone ${range(sculpt.tone)}, calm ${range(sculpt.calm)}, parts skin ${parts[0]} / teeth ${parts[1]} / tongue ${parts[2]}`;
};
