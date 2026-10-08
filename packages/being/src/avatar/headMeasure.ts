import { type Mesh, type SkinnedMesh, Vector3 } from 'three';
import { sampleIndices } from '../data/fanMath.ts';
import type { HeadBounds } from '../stage/framing.ts';

export interface HeadMeasure {
  bounds: HeadBounds;
  /** Points on the head's surface in bind-pose world space, three floats each: where the data fan's lines start. */
  points: Float32Array;
}

const isSkinned = (mesh: Mesh): mesh is SkinnedMesh => (mesh as SkinnedMesh).isSkinnedMesh === true;

/**
 * The head's bounds and a spread of its surface points, in bind-pose world space. A skinned head is read through its
 * skeleton, which is also where a quantised asset keeps its scale (in the inverse bind matrices), so the numbers
 * come out in metres. Call it with the root's world matrices up to date and before the rig has posed anything.
 */
export function measureHead(mesh: Mesh, picks: number): HeadMeasure {
  const position = mesh.geometry.getAttribute('position');
  const v = new Vector3();
  const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = min.clone().negate();
  const at = (index: number): Vector3 => {
    v.fromBufferAttribute(position, index);
    if (isSkinned(mesh)) mesh.applyBoneTransform(index, v);
    return v.applyMatrix4(mesh.matrixWorld);
  };
  for (let i = 0; i < position.count; i += 1) {
    at(i);
    min.min(v);
    max.max(v);
  }
  const points = new Float32Array(picks * 3);
  sampleIndices(position.count, picks).forEach((index, i) => {
    at(index).toArray(points, i * 3);
  });
  if (position.count === 0) return { bounds: { minY: 0, maxY: 0, centreZ: 0 }, points };
  return { bounds: { minY: min.y, maxY: max.y, centreZ: (min.z + max.z) / 2 }, points };
}
