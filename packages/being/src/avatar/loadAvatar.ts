import type { AnimationClip, Bone, Group, Mesh, Object3D } from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildMorphMap, type FaceBones, type MorphMap } from '../face/FaceDriver.ts';

export interface LoadedAvatar {
  root: Group;
  /** The mesh that carries the morph targets (or the only mesh of a placeholder figure). */
  head: Mesh;
  body: Mesh | null;
  bones: FaceBones;
  /** Channel index to morph indices; empty entries where the asset lacks a target. */
  morphs: MorphMap;
  clips: AnimationClip[];
}

/** Mixamo bone names without the "mixamorig:" prefix (avatar asset contract). */
const BONE_NAMES = { head: 'Head', neck: 'Neck', eyeL: 'LeftEye', eyeR: 'RightEye' } as const;

/** The wire reads none of these, and dropping them keeps the GPU buffers to positions, skin and morphs. */
const UNUSED_ATTRIBUTES = ['normal', 'tangent', 'uv', 'uv1', 'uv2', 'uv3', 'color'] as const;

const isMesh = (object: Object3D): object is Mesh => (object as Mesh).isMesh === true;
const isBone = (object: Object3D): object is Bone => (object as Bone).isBone === true;
const hasMorphs = (mesh: Mesh): boolean => mesh.geometry.morphAttributes.position !== undefined;
const vertexCount = (mesh: Mesh): number => mesh.geometry.attributes.position?.count ?? 0;
const named = (mesh: Mesh, word: string): boolean => mesh.name.toLowerCase().includes(word);

/**
 * Load guide.glb (or guide-lite.glb), find the head and body meshes and rebuild their geometry for the wire
 * shader on the same mesh objects, so skeleton, bind matrices and morph bookkeeping stay exactly as the loader
 * made them.
 */
export async function loadAvatar(url: string): Promise<LoadedAvatar> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);

  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (isMesh(object)) meshes.push(object);
  });
  const head = pickHead(meshes);
  if (!head) throw new Error(`The avatar at ${url} contains no mesh.`);
  const body = pickBody(meshes, head);

  prepareWireGeometry(head);
  if (body) prepareWireGeometry(body);
  // Anything else (eyes, teeth, hair shells) would need its own look; it stays out of the wire.
  for (const mesh of meshes) if (mesh !== head && mesh !== body) mesh.visible = false;

  return {
    root: gltf.scene,
    head,
    body,
    bones: findBones(gltf.scene),
    morphs: buildMorphMap(head.morphTargetDictionary ?? {}),
    clips: gltf.animations,
  };
}

function pickHead(meshes: Mesh[]): Mesh | null {
  return meshes.find(hasMorphs) ?? meshes.find((mesh) => named(mesh, 'head')) ?? meshes[0] ?? null;
}

function pickBody(meshes: Mesh[], head: Mesh): Mesh | null {
  const rest = meshes.filter((mesh) => mesh !== head);
  const byName = rest.find((mesh) => named(mesh, 'body'));
  if (byName) return byName;
  let best: Mesh | null = null;
  for (const mesh of rest) if (!best || vertexCount(mesh) > vertexCount(best)) best = mesh;
  return best;
}

/**
 * Swap in a non-indexed copy so every vertex belongs to exactly one triangle (the shader derives barycentrics
 * from gl_VertexID), strip what the wire never reads, and turn culling off: a skinned mesh's bounds are stale as
 * soon as it moves.
 */
function prepareWireGeometry(mesh: Mesh): void {
  const old = mesh.geometry;
  const geometry = old.index ? old.toNonIndexed() : old.clone();
  old.dispose();
  for (const name of UNUSED_ATTRIBUTES) if (geometry.hasAttribute(name)) geometry.deleteAttribute(name);
  delete geometry.morphAttributes.normal;
  delete geometry.morphAttributes.color;
  mesh.geometry = geometry;
  mesh.frustumCulled = false;
}

const nameIsLeft = (name: string): boolean => name.includes('left') || /(^|[^a-z])l([^a-z]|$)/.test(name);
const nameIsRight = (name: string): boolean => name.includes('right') || /(^|[^a-z])r([^a-z]|$)/.test(name);

/** Exact Mixamo names first, then the shortest bone whose name contains the part (so "Head" beats "HeadTop_End"). */
function findBones(root: Object3D): FaceBones {
  const bones: Bone[] = [];
  root.traverse((object) => {
    if (isBone(object)) bones.push(object);
  });
  const exact = (name: string): Bone | undefined => bones.find((bone) => bone.name === name);
  const fuzzy = (test: (lower: string) => boolean): Bone | undefined =>
    bones.filter((bone) => test(bone.name.toLowerCase())).sort((a, b) => a.name.length - b.name.length)[0];

  const result: FaceBones = {};
  const head = exact(BONE_NAMES.head) ?? fuzzy((name) => name.includes('head'));
  const neck = exact(BONE_NAMES.neck) ?? fuzzy((name) => name.includes('neck'));
  const eyeL = exact(BONE_NAMES.eyeL) ?? fuzzy((name) => name.includes('eye') && nameIsLeft(name));
  const eyeR = exact(BONE_NAMES.eyeR) ?? fuzzy((name) => name.includes('eye') && nameIsRight(name));
  if (head) result.head = head;
  if (neck) result.neck = neck;
  if (eyeL) result.eyeL = eyeL;
  if (eyeR) result.eyeR = eyeR;
  return result;
}
