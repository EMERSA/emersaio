import { type Bone, Euler, MathUtils, type Mesh, type Object3D, Quaternion, type SkinnedMesh } from 'three';
import {
  ARKIT_BASE,
  ARKIT_COUNT,
  CHANNEL,
  CHANNEL_COUNT,
  createFrame,
  type FaceSource,
  VISEME_COUNT,
} from './source.ts';
import { arkit52 } from './tables/arkit52.ts';

/** Morph indices per channel, as found in the GLB; empty where the asset has no such target. */
export type MorphMap = ReadonlyArray<ReadonlyArray<number>>;

/** Head and eye bones the driver may rotate. Any of them may be missing on a placeholder figure. */
export interface FaceBones {
  head?: Bone;
  neck?: Bone;
  eyeL?: Bone;
  eyeR?: Bone;
}

export interface FaceDriverOptions {
  mesh: SkinnedMesh | Mesh;
  bones: FaceBones;
  /** Prebuilt by loadAvatar; derived from the mesh's morphTargetDictionary when absent. */
  morphs?: MorphMap;
  /** The figure's own space (the avatar's root): head and eye turns are taken in it, however the figure is turned. */
  space?: Object3D;
}

/** Degrees of travel for the head and eye channels at full deflection. */
export const HEAD_LIMITS = { yaw: 25, pitch: 15, roll: 10 } as const;
export const EYE_LIMITS = { yaw: 25, pitch: 15 } as const;

const ATTACK_MS = 40;
const RELEASE_MS = 110;
/**
 * The ARKit block follows a live capture that is already smooth: it only takes the edge off each frame step, 90
 * percent of the way in 15 ms rising and 40 ms falling, so a stop consonant still closes the lips in time.
 */
export const ARKIT_ATTACK_MS = 15;
export const ARKIT_RELEASE_MS = 40;
/** The jaw's ARKit channel, which the mouth's energy reads beside the visemes and the expression jaw. */
const ARKIT_JAW = ARKIT_BASE + arkit52.indexOf('jawOpen');
/** The previous dominant viseme is held at this fraction of its weight for this long while the next one rises. */
const COARTICULATION_HOLD = 0.35;
const COARTICULATION_MS = 90;
const ENERGY_RELEASE_S = 0.25;

/** ARKit morph names per expression channel (avatar asset contract); paired shapes move together. */
const EXPRESSION_MORPHS: ReadonlyArray<readonly [channel: number, names: readonly string[]]> = [
  [CHANNEL.jawOpen, ['jawOpen']],
  [CHANNEL.blinkLeft, ['eyeBlinkLeft']],
  [CHANNEL.blinkRight, ['eyeBlinkRight']],
  [CHANNEL.browUp, ['browInnerUp']],
  [CHANNEL.browDown, ['browDownLeft', 'browDownRight']],
  [CHANNEL.smile, ['mouthSmileLeft', 'mouthSmileRight']],
  [CHANNEL.frown, ['mouthFrownLeft', 'mouthFrownRight']],
];

/** The head and eye channels, which run -1..1 and land on bones; the ARKit block comes after them and is not one. */
const isBoneChannel = (channel: number): boolean => channel >= CHANNEL.headYaw && channel <= CHANNEL.eyesPitch;
const isArkitChannel = (channel: number): boolean => channel >= ARKIT_BASE && channel < ARKIT_BASE + ARKIT_COUNT;

/**
 * The GLB morph names a channel maps to: viseme_00..viseme_21, then the ARKit expression shapes, and for the ARKit
 * block the one ARKit shape of the same name.
 */
export function morphNamesFor(channel: number): readonly string[] {
  if (channel >= 0 && channel < VISEME_COUNT) return [`viseme_${String(channel).padStart(2, '0')}`];
  if (isArkitChannel(channel)) {
    const name = arkit52[channel - ARKIT_BASE];
    return name ? [name] : [];
  }
  return EXPRESSION_MORPHS.find(([owner]) => owner === channel)?.[1] ?? [];
}

/** True when every channel of the ARKit block found its morph: a live ARKit stream can then drive the face 1:1. */
export function hasArkitMorphs(map: MorphMap): boolean {
  for (let index = 0; index < ARKIT_COUNT; index += 1) {
    if ((map[ARKIT_BASE + index]?.length ?? 0) === 0) return false;
  }
  return true;
}

/** Resolve the channel-to-morph map against a mesh's dictionary, tolerating every missing target. */
export function buildMorphMap(dictionary: Readonly<Record<string, number>>): MorphMap {
  const map: number[][] = [];
  for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
    const indices: number[] = [];
    for (const name of morphNamesFor(channel)) {
      const index = dictionary[name];
      if (index !== undefined) indices.push(index);
    }
    map.push(indices);
  }
  return map;
}

const scratchEuler = new Euler();
const scratchDelta = new Quaternion();
const scratchParent = new Quaternion();
const scratchInverse = new Quaternion();
const scratchSpace = new Quaternion();

/**
 * Rotate a bone by yaw, pitch and roll given in world space (radians), or in the space of `space` when one is given
 * (the avatar's root, which the turntable turns), on top of whatever the animation set this frame. The delta is moved
 * into the parent's space (q' = P^-1 D P q) so it works whatever the bone's local axes are. Pitch is positive
 * upwards; the figure faces +Z, so that is a negative turn about X: a nod stays a nod however she is turned.
 */
export function applyWorldRotation(bone: Object3D, yaw: number, pitch: number, roll: number, space?: Object3D): void {
  if (yaw === 0 && pitch === 0 && roll === 0) return;
  scratchEuler.set(-pitch, yaw, roll, 'YXZ');
  scratchDelta.setFromEuler(scratchEuler);
  const parent = bone.parent;
  if (parent) {
    parent.getWorldQuaternion(scratchParent);
    if (space) scratchParent.premultiply(space.getWorldQuaternion(scratchSpace).invert());
    scratchInverse.copy(scratchParent).invert();
    scratchDelta.premultiply(scratchInverse).multiply(scratchParent);
  }
  bone.quaternion.premultiply(scratchDelta);
}

/**
 * Blends every active FaceSource onto one face. Per channel the highest-priority source that wrote it wins; the
 * result eases in over 40 ms and out over 110 ms (the ARKit block over 15 and 40), the previous viseme lingers under
 * the next one, and the values land in morphTargetInfluences and on the head and eye bones. A morph both an
 * expression channel and the ARKit block drive (jawOpen, the blinks, the brows, the smile and the frown) takes the
 * larger of the two.
 */
export class FaceDriver {
  private readonly mesh: SkinnedMesh | Mesh;
  private readonly bones: FaceBones;
  private readonly space: Object3D | undefined;
  private readonly morphs: MorphMap;
  /** 1 for each morph index an expression or viseme channel writes, so the ARKit block knows where to take max(). */
  private readonly legacyMorph: Uint8Array;
  private readonly sources: FaceSource[] = [];
  private readonly frame = createFrame();
  private readonly written = new Uint8Array(CHANNEL_COUNT);
  private readonly targets = createFrame();
  private readonly current = createFrame();
  private dominant = -1;
  private previous = -1;
  private previousWeight = 0;
  private switchedAt = Number.NEGATIVE_INFINITY;
  private energyValue = 0;

  constructor(options: FaceDriverOptions) {
    this.mesh = options.mesh;
    this.bones = options.bones;
    this.space = options.space;
    this.morphs = options.morphs ?? buildMorphMap(options.mesh.morphTargetDictionary ?? {});
    let highest = -1;
    for (const indices of this.morphs) for (const index of indices) highest = Math.max(highest, index);
    this.legacyMorph = new Uint8Array(highest + 1);
    for (let channel = 0; channel < CHANNEL.headYaw; channel += 1) {
      for (const index of this.morphs[channel] ?? []) this.legacyMorph[index] = 1;
    }
  }

  add(source: FaceSource): void {
    if (this.sources.includes(source)) return;
    this.sources.push(source);
    // Ascending, so a later (higher) source overwrites what a lower one wrote to the same channel.
    this.sources.sort((a, b) => a.priority - b.priority);
  }

  remove(source: FaceSource): void {
    const index = this.sources.indexOf(source);
    if (index < 0) return;
    this.sources.splice(index, 1);
    source.stop?.();
  }

  has(source: FaceSource): boolean {
    return this.sources.includes(source);
  }

  update(nowMs: number, dtSeconds: number): void {
    this.targets.fill(0);
    for (const source of this.sources) {
      if (!source.active(nowMs)) continue;
      this.written.fill(0);
      source.sample(nowMs, this.frame, this.written);
      for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
        if (this.written[channel]) this.targets[channel] = this.frame[channel] ?? 0;
      }
    }
    this.coarticulate(nowMs);

    // 90 percent of the way within the stated time, exponentially: quick onsets, soft tails.
    const dtMs = Math.max(0, dtSeconds) * 1000;
    const attack = 1 - Math.exp((-dtMs * Math.LN10) / ATTACK_MS);
    const release = 1 - Math.exp((-dtMs * Math.LN10) / RELEASE_MS);
    const arkitAttack = 1 - Math.exp((-dtMs * Math.LN10) / ARKIT_ATTACK_MS);
    const arkitRelease = 1 - Math.exp((-dtMs * Math.LN10) / ARKIT_RELEASE_MS);
    for (let channel = 0; channel < CHANNEL_COUNT; channel += 1) {
      const low = isBoneChannel(channel) ? -1 : 0;
      const target = MathUtils.clamp(this.targets[channel] ?? 0, low, 1);
      const value = this.current[channel] ?? 0;
      const rising = Math.abs(target) > Math.abs(value);
      const k = isArkitChannel(channel) ? (rising ? arkitAttack : arkitRelease) : rising ? attack : release;
      this.current[channel] = value + (target - value) * k;
    }

    this.writeMorphs();
    this.writeBones();
    this.updateEnergy(dtSeconds);
  }

  /** Mouth activity 0..1, for the body dots and the HUD. */
  energy(): number {
    return this.energyValue;
  }

  /** The blended frame as it stands; read only. */
  values(): Float32Array {
    return this.current;
  }

  dispose(): void {
    for (const source of this.sources) source.stop?.();
    this.sources.length = 0;
  }

  private coarticulate(nowMs: number): void {
    let dominant = -1;
    let weight = 0;
    for (let viseme = 1; viseme < VISEME_COUNT; viseme += 1) {
      const target = this.targets[viseme] ?? 0;
      if (target > weight) {
        weight = target;
        dominant = viseme;
      }
    }
    if (dominant !== this.dominant) {
      if (this.dominant > 0) {
        this.previous = this.dominant;
        this.previousWeight = this.current[this.dominant] ?? 0;
        this.switchedAt = nowMs;
      }
      this.dominant = dominant;
    }
    if (this.previous > 0 && nowMs - this.switchedAt < COARTICULATION_MS) {
      const floor = this.previousWeight * COARTICULATION_HOLD;
      if ((this.targets[this.previous] ?? 0) < floor) this.targets[this.previous] = floor;
    }
  }

  /** The viseme and expression channels first; then the ARKit block, the larger value where both drive a morph. */
  private writeMorphs(): void {
    const influences = this.mesh.morphTargetInfluences;
    if (!influences) return;
    for (let channel = 0; channel < CHANNEL.headYaw; channel += 1) {
      const indices = this.morphs[channel];
      if (!indices || indices.length === 0) continue;
      const value = this.current[channel] ?? 0;
      for (const index of indices) influences[index] = value;
    }
    for (let channel = ARKIT_BASE; channel < ARKIT_BASE + ARKIT_COUNT; channel += 1) {
      const indices = this.morphs[channel];
      if (!indices || indices.length === 0) continue;
      const value = this.current[channel] ?? 0;
      for (const index of indices) {
        influences[index] = this.legacyMorph[index] ? Math.max(influences[index] ?? 0, value) : value;
      }
    }
  }

  private writeBones(): void {
    const head = this.bones.head ?? this.bones.neck;
    if (head) {
      applyWorldRotation(
        head,
        (this.current[CHANNEL.headYaw] ?? 0) * MathUtils.degToRad(HEAD_LIMITS.yaw),
        (this.current[CHANNEL.headPitch] ?? 0) * MathUtils.degToRad(HEAD_LIMITS.pitch),
        (this.current[CHANNEL.headRoll] ?? 0) * MathUtils.degToRad(HEAD_LIMITS.roll),
        this.space,
      );
    }
    const eyeYaw = (this.current[CHANNEL.eyesYaw] ?? 0) * MathUtils.degToRad(EYE_LIMITS.yaw);
    const eyePitch = (this.current[CHANNEL.eyesPitch] ?? 0) * MathUtils.degToRad(EYE_LIMITS.pitch);
    if (this.bones.eyeL) applyWorldRotation(this.bones.eyeL, eyeYaw, eyePitch, 0, this.space);
    if (this.bones.eyeR) applyWorldRotation(this.bones.eyeR, eyeYaw, eyePitch, 0, this.space);
  }

  private updateEnergy(dtSeconds: number): void {
    let mouth = 0;
    for (let viseme = 1; viseme < VISEME_COUNT; viseme += 1) mouth = Math.max(mouth, this.current[viseme] ?? 0);
    const jaw = Math.max(this.current[CHANNEL.jawOpen] ?? 0, this.current[ARKIT_JAW] ?? 0);
    const target = Math.min(1, Math.max(mouth, jaw * 1.5));
    if (target > this.energyValue) this.energyValue = target;
    else this.energyValue += (target - this.energyValue) * (1 - Math.exp(-dtSeconds / ENERGY_RELEASE_S));
  }
}
