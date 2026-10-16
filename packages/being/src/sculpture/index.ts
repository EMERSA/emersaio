/**
 * The sculpture look (chunk 'sculpture'): Emily's complete head and bust as hundreds of thousands of tiny triangles
 * fixed to her surface. Each frame the welded head and bust vertices are deformed on the CPU exactly as three
 * deforms the meshes (the morphs the face writes, then linear blend skinning through the same bone matrices), so lip
 * sync, blinks, head turns and the turntable carry every shard with them; a wave equation over the vertex graph is
 * the water (rings from her lips while she speaks, drops now and then, a stir where the pointer crosses her).
 * Positions with the water height and smooth normals with the albedo go to two float textures the shards read. The
 * real meshes draw first, depth only, so the far side of the head never shows through. Procedural eyeballs ride the
 * eye bones. Nothing moves under reduced motion but the face itself.
 */
import {
  type Blending,
  type Bone,
  BufferAttribute,
  DataTexture,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  type PerspectiveCamera,
  RGBAFormat,
  type Scene,
  ShaderMaterial,
  type SkinnedMesh,
  Sphere,
  Vector3,
} from 'three';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';
import { buildShards, type MeshPart, shardCount, type Welded, waveStep, weld } from './build.ts';
import { shardFrag, shardVert } from './shaders.ts';

/** The bust crop: nothing below this world height in the bind pose. */
const CROP_Y = 1.24;
/** Texture width; rows follow the vertex count. */
const TEX_W = 64;
/** Water: metres of displacement per unit height, steps a second and at most per frame. */
const WATER_M = 0.0012;
const STEP_S = 1 / 120;
const MAX_STEPS = 4;
/** The fine flow running down her: its amplitude in metres (none under reduced motion). */
const FLOW_M = 0.00032;
/** Below this loudness there is no ring from the lips; above it, rings of this height per unit of loudness. */
const VOICE_GATE = 0.06;
const VOICE_RING = 0.07;
/** Body shards are this much larger than the head's: the face carries the detail. */
const BODY_SCALE = 1.9;
const EYE_SCALE = 0.7;
/** How far each shard shrinks toward its centre: the hairline gaps between tiles. */
const SHRINK = 0.8;
/** Eyeballs: a radius cap (the helper eyes the asset measured), the iris and pupil angles. */
const EYE_RADIUS_M = 0.0125;
const IRIS_COS = Math.cos((32 * Math.PI) / 180);
const PUPIL_COS = Math.cos((13 * Math.PI) / 180);

export interface SculptureOptions {
  scene: Scene;
  shared: SharedUniforms;
  blending: Blending;
  reducedMotion: boolean;
  register: (material: ShaderMaterial) => void;
}

export interface SculptureAvatar {
  head: SkinnedMesh | Mesh;
  body: SkinnedMesh | Mesh | null;
  eyeL?: Bone | undefined;
  eyeR?: Bone | undefined;
}

export interface SculptureFrame {
  dt: number;
  elapsed: number;
  camera: PerspectiveCamera;
  /** Loudness of her voice 0..1: the sound itself, not the mouth's movement. */
  voice: number;
  /** The intro's progress 0..1 (1 settled). */
  intro: number;
}

interface Owner {
  /** 0 head mesh, 1 body mesh, 2 left eye, 3 right eye. */
  part: Uint8Array;
  index: Uint32Array;
}

const isSkinned = (mesh: Mesh): mesh is SkinnedMesh => (mesh as SkinnedMesh).isSkinnedMesh === true;

export class SculptureLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly options: SculptureOptions;
  private readonly material: ShaderMaterial;
  private readonly depthMaterial = new MeshBasicMaterial({
    colorWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 2,
  });
  private avatar: SculptureAvatar | null = null;
  private saved: Array<[Mesh, Material | Material[]]> = [];
  private welded: Welded | null = null;
  private owner: Owner | null = null;
  /** Rest positions in each owner's space, skin joints and weights, and the eye vertices' bone-local positions. */
  private rest = new Float32Array(0);
  private joints = new Uint16Array(0);
  private weights = new Float32Array(0);
  private morphs: Array<{ v: Uint32Array; d: Float32Array }> = [];
  private scratch = new Float32Array(0);
  private world = new Float32Array(0);
  private normals = new Float32Array(0);
  private height = new Float32Array(0);
  private heightPrev = new Float32Array(0);
  private posTex: DataTexture | null = null;
  private nrmTex: DataTexture | null = null;
  private carry = 0;
  private clock = 0;
  private nextDrop = 1;
  private stirVertex = -1;
  private stirAmount = 0;
  private targetM = 0;
  private cap = 600_000;
  private active = false;
  private readonly matrices: Matrix4[] = [];
  private readonly tmp = new Matrix4();
  private readonly v = new Vector3();

  constructor(options: SculptureOptions) {
    this.options = options;
    const shared = options.shared;
    this.material = new ShaderMaterial({
      uniforms: {
        uPos: { value: null },
        uNrm: { value: null },
        uTexW: { value: TEX_W },
        uTime: shared.uTime,
        uIntro: { value: options.reducedMotion ? 1 : 0 },
        uFlow: { value: options.reducedMotion ? 0 : FLOW_M },
        uShrink: { value: SHRINK },
        uSubject: { value: new Vector3(0, 1.62, 0.06) },
        uMinY: { value: 1.25 },
        uWire: shared.uWire,
        uGlow: shared.uGlow,
        uBg: shared.uBg,
        uIsLight: shared.uIsLight,
        uOpacity: shared.uOpacity,
      },
      vertexShader: shardVert,
      fragmentShader: shardFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: options.blending,
    });
    this.material.name = 'SculptureShards';
    options.register(this.material);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    geometry.boundingSphere = new Sphere(new Vector3(0, 1.5, 0), 1);
    geometry.instanceCount = 0;
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    options.scene.add(this.mesh);
  }

  /** Build the welded surface from the avatar's original (indexed) geometry. */
  build(avatar: SculptureAvatar): void {
    this.avatar = avatar;
    const meshes = [avatar.head, avatar.body].filter((m): m is Mesh => m !== null);
    for (const m of meshes) m.updateWorldMatrix(true, false);
    const parts: MeshPart[] = [];
    const sources = meshes.map((m) => (m.userData.sourceGeometry ?? m.geometry) as Mesh['geometry']);
    sources.forEach((geometry, i) => {
      const position = geometry.getAttribute('position');
      const positions = new Float32Array(position.count * 3);
      for (let k = 0; k < position.count; k += 1) {
        positions[k * 3] = position.getX(k);
        positions[k * 3 + 1] = position.getY(k);
        positions[k * 3 + 2] = position.getZ(k);
      }
      const sculptAttr = geometry.getAttribute('_sculpt');
      let sculpt: Float32Array | null = null;
      if (sculptAttr) {
        sculpt = new Float32Array(sculptAttr.count * 4);
        for (let k = 0; k < sculptAttr.count; k += 1) {
          sculpt[k * 4] = sculptAttr.getX(k);
          sculpt[k * 4 + 1] = sculptAttr.getY(k);
          sculpt[k * 4 + 2] = sculptAttr.getZ(k);
          sculpt[k * 4 + 3] = sculptAttr.getW(k);
        }
      }
      const index = geometry.index ? geometry.index.array : Uint32Array.from({ length: position.count }, (_, k) => k);
      parts.push({ positions, index, sculpt });
      void i;
    });
    // The crop works on the bind pose in world space: the skin's rest placement of each vertex.
    const restWorld = sources.map((geometry, i) => this.bindWorld(meshes[i] as Mesh, geometry));
    // Eyeballs: icospheres in each eye bone's space, toned by angle (sclera, iris, pupil).
    const eyes: Array<{ bone: Bone; local: Float32Array; tone: Float32Array; tris: number[] }> = [];
    for (const bone of [avatar.eyeL, avatar.eyeR]) {
      if (!bone) continue;
      bone.updateWorldMatrix(true, false);
      const radius = Math.min(EYE_RADIUS_M, Number(bone.userData.eyeRadius) || EYE_RADIUS_M);
      eyes.push({ bone, ...eyeball(radius, bone) });
    }
    for (const eye of eyes) {
      const world = new Float32Array(eye.local.length);
      for (let k = 0; k < eye.local.length; k += 3) {
        this.v.set(eye.local[k] ?? 0, eye.local[k + 1] ?? 0, eye.local[k + 2] ?? 0).applyMatrix4(eye.bone.matrixWorld);
        world[k] = this.v.x;
        world[k + 1] = this.v.y;
        world[k + 2] = this.v.z;
      }
      const sculpt = new Float32Array((eye.local.length / 3) * 4);
      for (let k = 0; k < eye.local.length / 3; k += 1) {
        sculpt[k * 4] = 1;
        sculpt[k * 4 + 1] = eye.tone[k] ?? 1;
        sculpt[k * 4 + 3] = 0;
      }
      parts.push({ positions: world, index: eye.tris, sculpt, plain: true });
      restWorld.push(world);
    }
    const welded = weld(
      parts.map((part, i) => ({ ...part, positions: restWorld[i] as Float32Array })),
      (p, v) => p >= 2 || ((restWorld[p] as Float32Array)[v * 3 + 1] ?? 0) >= CROP_Y,
    );
    this.welded = welded;
    const n = welded.count;
    const owner: Owner = { part: new Uint8Array(n), index: new Uint32Array(n) };
    // The first part to claim a vertex owns it: walk the parts in reverse so the earlier claim is written last.
    for (let p = welded.remap.length - 1; p >= 0; p -= 1) {
      const map = welded.remap[p] as Int32Array;
      for (let v = 0; v < map.length; v += 1) {
        const w = map[v] ?? -1;
        if (w >= 0) {
          owner.part[w] = p;
          owner.index[w] = v;
        }
      }
    }
    this.owner = owner;
    this.rest = new Float32Array(n * 3);
    this.joints = new Uint16Array(n * 4);
    this.weights = new Float32Array(n * 4);
    for (let w = 0; w < n; w += 1) {
      const p = owner.part[w] ?? 0;
      const v = owner.index[w] ?? 0;
      if (p >= 2) {
        const eye = eyes[p - 2];
        this.rest[w * 3] = eye?.local[v * 3] ?? 0;
        this.rest[w * 3 + 1] = eye?.local[v * 3 + 1] ?? 0;
        this.rest[w * 3 + 2] = eye?.local[v * 3 + 2] ?? 0;
        continue;
      }
      const src = parts[p] as MeshPart;
      this.rest[w * 3] = src.positions[v * 3] ?? 0;
      this.rest[w * 3 + 1] = src.positions[v * 3 + 1] ?? 0;
      this.rest[w * 3 + 2] = src.positions[v * 3 + 2] ?? 0;
      const geometry = sources[p] as Mesh['geometry'];
      const si = geometry.getAttribute('skinIndex');
      const sw = geometry.getAttribute('skinWeight');
      if (si && sw) {
        for (let j = 0; j < 4; j += 1) {
          this.joints[w * 4 + j] = si.getComponent(v, j);
          this.weights[w * 4 + j] = sw.getComponent(v, j);
        }
      }
    }
    // Sparse morph deltas of the head, in welded indices (only vertices the head owns move with its morphs).
    const headGeometry = sources[0] as Mesh['geometry'];
    const deltas = headGeometry.morphAttributes.position ?? [];
    this.morphs = deltas.map((attr) => {
      const vs: number[] = [];
      const ds: number[] = [];
      const map = welded.remap[0] as Int32Array;
      for (let v = 0; v < attr.count; v += 1) {
        const w = map[v] ?? -1;
        if (w < 0 || owner.part[w] !== 0) continue;
        const x = attr.getX(v);
        const y = attr.getY(v);
        const z = attr.getZ(v);
        if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-7) continue;
        vs.push(w);
        ds.push(x, y, z);
      }
      return { v: Uint32Array.from(vs), d: Float32Array.from(ds) };
    });
    this.eyes = eyes.map((eye) => eye.bone);
    this.scratch = new Float32Array(n * 3);
    this.world = new Float32Array(n * 3);
    this.normals = new Float32Array(n * 3);
    this.height = new Float32Array(n);
    this.heightPrev = new Float32Array(n);
    const rows = Math.ceil(n / TEX_W);
    this.posTex = makeTexture(rows);
    this.nrmTex = makeTexture(rows);
    const u = this.material.uniforms;
    if (u.uPos) u.uPos.value = this.posTex;
    if (u.uNrm) u.uNrm.value = this.nrmTex;
    this.deform();
    if (this.targetM > 0) this.rebuildShards();
  }

  private eyes: Bone[] = [];

  /** The shards' target edge in metres, and the most shards the tier allows; rebuilt when it changes by 12 percent. */
  setDensity(targetM: number, cap: number): void {
    if (!(targetM > 0)) return;
    const changed = this.targetM === 0 || Math.abs(targetM / this.targetM - 1) > 0.12 || cap !== this.cap;
    this.targetM = targetM;
    this.cap = cap;
    if (!changed || !this.welded) return;
    // The first build is at once; later ones wait for the layout to settle, so a resize never blocks the page.
    if (this.shards() === 0) {
      this.rebuildShards();
      return;
    }
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuildShards(), 400);
  }

  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;

  /** Draw the sculpture (and the depth-only meshes under it), or hand the meshes back to the wire. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.mesh.visible = on && this.welded !== null;
    const avatar = this.avatar;
    if (!avatar) return;
    if (on) {
      for (const mesh of [avatar.head, avatar.body]) {
        if (!mesh) continue;
        this.saved.push([mesh, mesh.material]);
        mesh.material = this.depthMaterial;
        mesh.renderOrder = -2;
        mesh.layers.enable(0);
      }
    } else {
      for (const [mesh, material] of this.saved) {
        mesh.material = material;
        mesh.renderOrder = 0;
      }
      this.saved = [];
    }
  }

  /** A pointer crossing her: the nearest vertex on screen gets a push in proportion to its speed. */
  stir(ndcX: number, ndcY: number, speed: number, camera: PerspectiveCamera): void {
    if (!this.welded || this.options.reducedMotion) return;
    let best = -1;
    let bestD = 0.0025;
    const w = this.world;
    for (let i = 0; i < this.welded.count; i += 3) {
      this.v.set(w[i * 3] ?? 0, w[i * 3 + 1] ?? 0, w[i * 3 + 2] ?? 0).project(camera);
      const d = (this.v.x - ndcX) ** 2 + (this.v.y - ndcY) ** 2;
      if (d < bestD && this.v.z < 1) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return;
    this.stirVertex = best;
    this.stirAmount = Math.min(1, speed) * 0.5;
  }

  /** Where the colour ramp is centred: the head's centre in the world. */
  setSubject(x: number, y: number, z: number, minY: number): void {
    (this.material.uniforms.uSubject?.value as Vector3 | undefined)?.set(x, y, z);
    if (this.material.uniforms.uMinY) this.material.uniforms.uMinY.value = minY;
  }

  built(): boolean {
    return this.welded !== null;
  }

  shards(): number {
    return this.welded ? this.mesh.geometry.instanceCount : 0;
  }

  update(frame: SculptureFrame): void {
    if (!this.welded || !this.active) return;
    const u = this.material.uniforms;
    if (u.uIntro) u.uIntro.value = this.options.reducedMotion ? 1 : frame.intro;
    if (!this.options.reducedMotion) this.water(frame);
    this.deform();
  }

  private water(frame: SculptureFrame): void {
    const welded = this.welded as Welded;
    this.carry += Math.min(0.1, Math.max(0, frame.dt));
    let steps = 0;
    while (this.carry >= STEP_S && steps < MAX_STEPS) {
      this.carry -= STEP_S;
      steps += 1;
      this.clock += STEP_S;
      // Her voice rings out softly from the lips (only while there is sound, so the chin stays still otherwise); a
      // drop lands every second or so; the pointer stirs where it crosses.
      const voice = frame.voice > VOICE_GATE ? Math.min(1, frame.voice) : 0;
      const push = voice * VOICE_RING * Math.sin(2 * Math.PI * 4.5 * this.clock);
      if (push !== 0) for (const v of welded.lips) this.height[v] = (this.height[v] ?? 0) + push;
      if (this.clock >= this.nextDrop) {
        this.nextDrop = this.clock + 0.7 + Math.random() * 1.3;
        const v = Math.floor(Math.random() * welded.count);
        this.height[v] = (this.height[v] ?? 0) + 0.9;
      }
      if (this.stirVertex >= 0 && this.stirAmount > 0.01) {
        this.height[this.stirVertex] = (this.height[this.stirVertex] ?? 0) - this.stirAmount;
        this.stirAmount *= 0.8;
      }
      waveStep(this.height, this.heightPrev, welded);
      const swap = this.height;
      this.height = this.heightPrev;
      this.heightPrev = swap;
    }
    if (steps === MAX_STEPS) this.carry = 0;
  }

  /** Morphs, skinning, normals, textures: every welded vertex where three would draw it this frame. */
  private deform(): void {
    const avatar = this.avatar;
    const welded = this.welded;
    const owner = this.owner;
    if (!avatar || !welded || !owner || !this.posTex || !this.nrmTex) return;
    const n = welded.count;
    const local = this.scratch;
    local.set(this.rest);
    const influences = avatar.head.morphTargetInfluences ?? [];
    for (let k = 0; k < this.morphs.length; k += 1) {
      const f = influences[k] ?? 0;
      if (Math.abs(f) < 1e-4) continue;
      const m = this.morphs[k] as { v: Uint32Array; d: Float32Array };
      for (let i = 0; i < m.v.length; i += 1) {
        const w = (m.v[i] ?? 0) * 3;
        local[w] = (local[w] ?? 0) + f * (m.d[i * 3] ?? 0);
        local[w + 1] = (local[w + 1] ?? 0) + f * (m.d[i * 3 + 1] ?? 0);
        local[w + 2] = (local[w + 2] ?? 0) + f * (m.d[i * 3 + 2] ?? 0);
      }
    }
    const meshes = [avatar.head, avatar.body];
    const skinMats: Matrix4[][] = meshes.map((mesh) => this.skinMatrices(mesh));
    const out = this.world;
    const e = new Float32Array(16);
    for (let w = 0; w < n; w += 1) {
      const p = owner.part[w] ?? 0;
      const x = local[w * 3] ?? 0;
      const y = local[w * 3 + 1] ?? 0;
      const z = local[w * 3 + 2] ?? 0;
      if (p >= 2) {
        const bone = this.eyes[p - 2];
        if (!bone) continue;
        this.v.set(x, y, z).applyMatrix4(bone.matrixWorld);
        out[w * 3] = this.v.x;
        out[w * 3 + 1] = this.v.y;
        out[w * 3 + 2] = this.v.z;
        continue;
      }
      const mats = skinMats[p] as Matrix4[];
      let ox = 0;
      let oy = 0;
      let oz = 0;
      for (let j = 0; j < 4; j += 1) {
        const weight = this.weights[w * 4 + j] ?? 0;
        if (weight === 0) continue;
        const m = mats[this.joints[w * 4 + j] ?? 0];
        if (!m) continue;
        e.set(m.elements);
        ox += weight * ((e[0] ?? 0) * x + (e[4] ?? 0) * y + (e[8] ?? 0) * z + (e[12] ?? 0));
        oy += weight * ((e[1] ?? 0) * x + (e[5] ?? 0) * y + (e[9] ?? 0) * z + (e[13] ?? 0));
        oz += weight * ((e[2] ?? 0) * x + (e[6] ?? 0) * y + (e[10] ?? 0) * z + (e[14] ?? 0));
      }
      out[w * 3] = ox;
      out[w * 3 + 1] = oy;
      out[w * 3 + 2] = oz;
    }
    // Smooth normals from the deformed triangles.
    const nr = this.normals;
    nr.fill(0);
    const t = welded.tris;
    for (let i = 0; i + 2 < t.length; i += 3) {
      const a = (t[i] ?? 0) * 3;
      const b = (t[i + 1] ?? 0) * 3;
      const c = (t[i + 2] ?? 0) * 3;
      const abx = (out[b] ?? 0) - (out[a] ?? 0);
      const aby = (out[b + 1] ?? 0) - (out[a + 1] ?? 0);
      const abz = (out[b + 2] ?? 0) - (out[a + 2] ?? 0);
      const acx = (out[c] ?? 0) - (out[a] ?? 0);
      const acy = (out[c + 1] ?? 0) - (out[a + 1] ?? 0);
      const acz = (out[c + 2] ?? 0) - (out[a + 2] ?? 0);
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      for (const k of [a, b, c]) {
        nr[k] = (nr[k] ?? 0) + nx;
        nr[k + 1] = (nr[k + 1] ?? 0) + ny;
        nr[k + 2] = (nr[k + 2] ?? 0) + nz;
      }
    }
    const pos = this.posTex.image.data as Float32Array;
    const nrm = this.nrmTex.image.data as Float32Array;
    for (let w = 0; w < n; w += 1) {
      const lx = nr[w * 3] ?? 0;
      const ly = nr[w * 3 + 1] ?? 0;
      const lz = nr[w * 3 + 2] ?? 0;
      const len = Math.hypot(lx, ly, lz) || 1;
      pos[w * 4] = out[w * 3] ?? 0;
      pos[w * 4 + 1] = out[w * 3 + 1] ?? 0;
      pos[w * 4 + 2] = out[w * 3 + 2] ?? 0;
      pos[w * 4 + 3] = (this.height[w] ?? 0) * WATER_M * (welded.calm[w] ?? 1);
      nrm[w * 4] = lx / len;
      nrm[w * 4 + 1] = ly / len;
      nrm[w * 4 + 2] = lz / len;
      nrm[w * 4 + 3] = (welded.ao[w] ?? 1) * (welded.albedo[w] ?? 1);
    }
    this.posTex.needsUpdate = true;
    this.nrmTex.needsUpdate = true;
  }

  /** Per bone: mesh.matrixWorld x bindMatrixInverse x (bone.matrixWorld x boneInverse) x bindMatrix, as three skins. */
  private skinMatrices(mesh: Mesh | null): Matrix4[] {
    if (!mesh || !isSkinned(mesh)) return [];
    const skeleton = mesh.skeleton;
    const list: Matrix4[] = [];
    for (let j = 0; j < skeleton.bones.length; j += 1) {
      const m = this.matrices[list.length] ?? new Matrix4();
      this.matrices[list.length] = m;
      const bone = skeleton.bones[j] as Bone;
      this.tmp.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[j] as Matrix4);
      m.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse).multiply(this.tmp).multiply(mesh.bindMatrix);
      list.push(m.clone());
    }
    return list;
  }

  /** A part's rest vertices in world space (no morphs), for the crop and the weld. */
  private bindWorld(mesh: Mesh, geometry: Mesh['geometry']): Float32Array {
    const position = geometry.getAttribute('position');
    const out = new Float32Array(position.count * 3);
    const mats = this.skinMatrices(mesh);
    const si = geometry.getAttribute('skinIndex');
    const sw = geometry.getAttribute('skinWeight');
    for (let v = 0; v < position.count; v += 1) {
      const p = new Vector3(position.getX(v), position.getY(v), position.getZ(v));
      if (mats.length && si && sw) {
        const acc = new Vector3();
        for (let j = 0; j < 4; j += 1) {
          const weight = sw.getComponent(v, j);
          const m = mats[si.getComponent(v, j)];
          if (weight > 0 && m) acc.addScaledVector(p.clone().applyMatrix4(m), weight);
        }
        p.copy(acc);
      } else {
        p.applyMatrix4(mesh.matrixWorld);
      }
      out[v * 3] = p.x;
      out[v * 3 + 1] = p.y;
      out[v * 3 + 2] = p.z;
    }
    return out;
  }

  private rebuildShards(): void {
    const welded = this.welded;
    if (!welded) return;
    const scale = (t: number): number => {
      const part = welded.triPart[t] ?? 0;
      return part === 1 ? BODY_SCALE : part >= 2 ? EYE_SCALE : 1;
    };
    let target = this.targetM;
    // Grow the shards until the tier's cap holds.
    for (let i = 0; i < 12 && shardCount(welded.tris, this.world, scale, target) > this.cap; i += 1) target *= 1.12;
    const shards = buildShards(welded.tris, this.world, scale, target);
    const geometry = this.mesh.geometry;
    geometry.setAttribute('aTri', new InstancedBufferAttribute(shards.tri, 3));
    geometry.setAttribute('aShard', new InstancedBufferAttribute(shards.shard, 4));
    geometry.instanceCount = shards.count;
    // three caches the largest instance count per geometry: a fresh geometry object would also do.
    (geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount = undefined;
    this.mesh.visible = this.active;
  }

  dispose(): void {
    clearTimeout(this.rebuildTimer);
    this.setActive(false);
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    this.posTex?.dispose();
    this.nrmTex?.dispose();
  }
}

function makeTexture(rows: number): DataTexture {
  const texture = new DataTexture(
    new Float32Array(TEX_W * Math.max(1, rows) * 4),
    TEX_W,
    Math.max(1, rows),
    RGBAFormat,
    FloatType,
  );
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** An icosphere (2 subdivisions) of the given radius in the bone's space, toned sclera / iris / pupil by angle. */
function eyeball(radius: number, bone: Bone): { local: Float32Array; tone: Float32Array; tris: number[] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: number[][] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ].map((v) => {
    const l = Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    return v.map((c) => c / l);
  });
  let faces: number[][] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  for (let s = 0; s < 2; s += 1) {
    const mid = new Map<string, number>();
    const at = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const found = mid.get(key);
      if (found !== undefined) return found;
      const va = verts[a] as number[];
      const vb = verts[b] as number[];
      const m = [0, 1, 2].map((i) => ((va[i] ?? 0) + (vb[i] ?? 0)) / 2);
      const l = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
      verts.push(m.map((c) => c / l));
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    faces = faces.flatMap(([a = 0, b = 0, c = 0]) => {
      const ab = at(a, b);
      const bc = at(b, c);
      const ca = at(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  // The eye looks along the figure's forward (+Z in the world) in the bind pose; in the bone's space that is:
  const inverse = new Matrix4().copy(bone.matrixWorld).invert();
  const forward = new Vector3(0, 0, 1).transformDirection(inverse);
  verts = verts.map((v) => v);
  const local = new Float32Array(verts.length * 3);
  const tone = new Float32Array(verts.length);
  verts.forEach((v, i) => {
    const dir = new Vector3(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0);
    const c = dir.dot(forward);
    tone[i] = c > PUPIL_COS ? 0.06 : c > IRIS_COS ? 0.42 : 0.92;
    // Bone space may be scaled: place the sphere so it has the given radius in the world.
    const scale = radius / new Vector3().setFromMatrixScale(bone.matrixWorld).x;
    local[i * 3] = dir.x * scale;
    local[i * 3 + 1] = dir.y * scale;
    local[i * 3 + 2] = dir.z * scale;
  });
  return { local, tone, tris: faces.flat() };
}
