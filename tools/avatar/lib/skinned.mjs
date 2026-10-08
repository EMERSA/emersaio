/**
 * Rest-pose world positions of a skinned primitive.
 *
 * Why not read POSITION directly: gltf-transform's quantize() folds the dequantisation of a skinned mesh into
 * the skin's inverse bind matrices, so the stored positions are only meaningful after skinning. Evaluating the
 * skin in the rest pose (joint world matrix times inverse bind matrix) gives metres whatever was done to the
 * accessor, and is exactly what the GPU does for the first frame.
 */

/** 4x4 column-major multiply: out = a * b. */
const multiply = (out, a, b) => {
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
};

/**
 * @param {import('@gltf-transform/core').Node} node
 * @param {import('@gltf-transform/core').Primitive} prim
 * @returns {Float32Array} xyz triplets in world space, metres
 */
export const restPositions = (node, prim) => {
  const position = prim.getAttribute('POSITION');
  if (!position) throw new Error(`primitive on node "${node.getName()}" has no POSITION`);
  const count = position.getCount();
  const out = new Float32Array(count * 3);
  const skin = node.getSkin();
  const joints = prim.getAttribute('JOINTS_0');
  const weights = prim.getAttribute('WEIGHTS_0');
  const element = [0, 0, 0, 0];
  if (!skin || !joints || !weights) {
    const world = node.getWorldMatrix();
    for (let i = 0; i < count; i++) {
      position.getElement(i, element);
      out.set(transformPoint(world, element), i * 3);
    }
    return out;
  }
  const inverseBind = skin.getInverseBindMatrices();
  if (!inverseBind) throw new Error('skin without inverse bind matrices');
  const jointMatrices = skin.listJoints().map((joint, index) => {
    const ibm = new Array(16).fill(0);
    inverseBind.getElement(index, ibm);
    return multiply(new Array(16).fill(0), joint.getWorldMatrix(), ibm);
  });
  const jointIndex = [0, 0, 0, 0];
  const weight = [0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    position.getElement(i, element);
    joints.getElement(i, jointIndex);
    weights.getElement(i, weight);
    let x = 0;
    let y = 0;
    let z = 0;
    let total = 0;
    for (let k = 0; k < 4; k++) {
      if (weight[k] === 0) continue;
      const matrix = jointMatrices[jointIndex[k]];
      if (!matrix) continue;
      const p = transformPoint(matrix, element);
      x += p[0] * weight[k];
      y += p[1] * weight[k];
      z += p[2] * weight[k];
      total += weight[k];
    }
    if (total > 0 && Math.abs(total - 1) > 1e-3) {
      x /= total;
      y /= total;
      z /= total;
    }
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  }
  return out;
};

const transformPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

/**
 * Axis-aligned bounds of a set of xyz arrays.
 * @param {Float32Array[]} arrays
 */
export const bounds = (arrays) => {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const array of arrays) {
    for (let i = 0; i < array.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        const value = array[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
  }
  return { min, max };
};
