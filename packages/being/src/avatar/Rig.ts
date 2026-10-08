import {
  type AnimationAction,
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  type Object3D,
  type Quaternion,
} from 'three';
import { applyWorldRotation, EYE_LIMITS, type FaceBones, type FaceDriver, HEAD_LIMITS } from '../face/FaceDriver.ts';
import { CHANNEL, type FaceSource } from '../face/source.ts';
import type { TourAction } from '../types.ts';

/** Clip names in the GLB (avatar asset contract). Idle is mandatory, the rest optional. */
export const CLIP_NAMES = {
  idle: 'Idle',
  breathing: 'Breathing',
  talking: 'Talking',
  pointLeft: 'PointLeft',
  pointRight: 'PointRight',
  wave: 'Wave',
  nod: 'Nod',
} as const;

export interface RigOptions {
  root: Object3D;
  clips: AnimationClip[];
  bones: FaceBones;
  face: FaceDriver;
  reducedMotion?: boolean;
}

type EmoteName = Extract<TourAction, { type: 'emote' }>['name'];
type GestureKind = Exclude<EmoteName, 'neutral'> | 'glanceLeft' | 'glanceRight';

interface Gesture {
  kind: GestureKind;
  startedAt: number;
  durationMs: number;
}

const GESTURE_MS: Readonly<Record<GestureKind, number>> = {
  nod: 900,
  smile: 2600,
  think: 2200,
  glanceLeft: 1600,
  glanceRight: 1600,
};

const CROSSFADE_S = 0.3;
const LOOK_LAMBDA = 7;

/** Small procedural moves on the face channels, used when the GLB has no clip for an emote or a point. */
class GestureSource implements FaceSource {
  readonly name = 'gesture';
  readonly priority = 5;
  private gestures: Gesture[] = [];

  play(kind: GestureKind, nowMs: number): void {
    this.gestures = this.gestures.filter((gesture) => gesture.kind !== kind);
    this.gestures.push({ kind, startedAt: nowMs, durationMs: GESTURE_MS[kind] });
  }

  clear(): void {
    this.gestures = [];
  }

  active(nowMs: number): boolean {
    this.gestures = this.gestures.filter((gesture) => nowMs - gesture.startedAt < gesture.durationMs);
    return this.gestures.length > 0;
  }

  sample(nowMs: number, frame: Float32Array, written: Uint8Array): void {
    const put = (channel: number, value: number): void => {
      // Channels not yet written this call may hold another source's leftovers, so start those from zero.
      frame[channel] = (written[channel] ? (frame[channel] ?? 0) : 0) + value;
      written[channel] = 1;
    };
    for (const gesture of this.gestures) {
      const t = MathUtils.clamp((nowMs - gesture.startedAt) / gesture.durationMs, 0, 1);
      const envelope = Math.sin(Math.PI * t);
      switch (gesture.kind) {
        case 'nod':
          // Two dips, chin first.
          put(CHANNEL.headPitch, -Math.sin(t * Math.PI * 4) * 0.45 * envelope);
          break;
        case 'smile':
          put(CHANNEL.smile, 0.7 * envelope);
          put(CHANNEL.browUp, 0.15 * envelope);
          break;
        case 'think':
          put(CHANNEL.browUp, 0.5 * envelope);
          put(CHANNEL.eyesYaw, 0.5 * envelope);
          put(CHANNEL.eyesPitch, 0.45 * envelope);
          put(CHANNEL.headRoll, 0.3 * envelope);
          put(CHANNEL.headPitch, 0.12 * envelope);
          break;
        case 'glanceLeft':
        case 'glanceRight': {
          const side = gesture.kind === 'glanceLeft' ? -1 : 1;
          put(CHANNEL.headYaw, side * 0.6 * envelope);
          put(CHANNEL.eyesYaw, side * 0.8 * envelope);
          break;
        }
      }
    }
  }
}

/** Bring `to` in over `from`; `to` is re-enabled because a faded-out action disables itself. */
function crossFade(from: AnimationAction | null, to: AnimationAction, seconds: number): void {
  to.enabled = true;
  to.setEffectiveTimeScale(1);
  to.setEffectiveWeight(1);
  to.play();
  if (from && from !== to) from.crossFadeTo(to, seconds, false);
  else to.fadeIn(seconds);
}

/**
 * Body animation: the Idle clip (or a procedural sway when the asset has none), one-shot gesture clips, emotes,
 * and a head and eye look-at layered over the clip pose every frame. Bones the clips do not drive are reset to
 * their rest pose before the mixer runs, so the per-frame deltas from the look-at and the FaceDriver never
 * accumulate.
 */
export class Rig {
  private readonly root: Object3D;
  private readonly bones: FaceBones;
  private readonly face: FaceDriver;
  private readonly clips: AnimationClip[];
  private readonly reducedMotion: boolean;
  private readonly mixer: AnimationMixer | null;
  private readonly idle: AnimationAction | null;
  private readonly talking: AnimationAction | null;
  private base: AnimationAction | null;
  private gesture: AnimationAction | null = null;
  private readonly gestures = new GestureSource();
  private readonly rest: Array<[Object3D, Quaternion]> = [];
  private readonly target = { x: 0, y: 0 };
  private readonly look = { x: 0, y: 0 };
  private elapsed = 0;

  private readonly onFinished = (event: { action: AnimationAction }): void => {
    if (event.action !== this.gesture) return;
    this.gesture = null;
    if (this.base) crossFade(event.action, this.base, CROSSFADE_S);
  };

  constructor(options: RigOptions) {
    this.root = options.root;
    this.bones = options.bones;
    this.face = options.face;
    this.clips = options.clips;
    this.reducedMotion = options.reducedMotion === true;

    const idleClip = this.clip(CLIP_NAMES.idle) ?? this.clip(CLIP_NAMES.breathing) ?? options.clips[0] ?? null;
    this.mixer = idleClip ? new AnimationMixer(options.root) : null;
    this.idle = this.mixer && idleClip ? this.mixer.clipAction(idleClip) : null;
    if (this.idle) {
      this.idle.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
      this.idle.play();
    }
    const talkingClip = this.clip(CLIP_NAMES.talking);
    this.talking = this.mixer && talkingClip ? this.mixer.clipAction(talkingClip) : null;
    this.talking?.setLoop(LoopRepeat, Number.POSITIVE_INFINITY);
    this.base = this.idle;
    this.mixer?.addEventListener('finished', this.onFinished);

    for (const bone of [this.bones.neck, this.bones.head, this.bones.eyeL, this.bones.eyeR]) {
      if (bone) this.rest.push([bone, bone.quaternion.clone()]);
    }
    this.face.add(this.gestures);
  }

  /** Advance the clip and layer the look-at on top. Runs before FaceDriver.update each frame. */
  update(dtSeconds: number): void {
    this.elapsed += dtSeconds;
    for (const [bone, quaternion] of this.rest) bone.quaternion.copy(quaternion);

    if (this.mixer) {
      this.mixer.update(dtSeconds);
    } else if (!this.reducedMotion) {
      // No clips at all: a slow sway and bob keep the figure from looking like a statue.
      this.root.rotation.y = Math.sin(this.elapsed * 0.45) * 0.03;
      this.root.position.y = Math.sin(this.elapsed * 1.15) * 0.004;
    }

    const lambda = this.reducedMotion ? 3 : LOOK_LAMBDA;
    this.look.x = MathUtils.damp(this.look.x, this.target.x, lambda, dtSeconds);
    this.look.y = MathUtils.damp(this.look.y, this.target.y, lambda, dtSeconds);
    const yaw = this.look.x * MathUtils.degToRad(HEAD_LIMITS.yaw);
    const pitch = this.look.y * MathUtils.degToRad(HEAD_LIMITS.pitch);
    // The neck carries a quarter of the turn, the head the rest; the eyes lead so the gaze lands on the pointer.
    const neckShare = this.bones.neck ? (this.bones.head ? 0.25 : 0.7) : 0;
    const headShare = this.bones.head ? 0.45 : 0;
    if (this.bones.neck) applyWorldRotation(this.bones.neck, yaw * neckShare, pitch * neckShare, 0);
    if (this.bones.head) applyWorldRotation(this.bones.head, yaw * headShare, pitch * headShare, 0);
    const eyeYaw = MathUtils.clamp(this.look.x * 0.6, -1, 1) * MathUtils.degToRad(EYE_LIMITS.yaw);
    const eyePitch = MathUtils.clamp(this.look.y * 0.6, -1, 1) * MathUtils.degToRad(EYE_LIMITS.pitch);
    if (this.bones.eyeL) applyWorldRotation(this.bones.eyeL, eyeYaw, eyePitch, 0);
    if (this.bones.eyeR) applyWorldRotation(this.bones.eyeR, eyeYaw, eyePitch, 0);
  }

  /** Pointer position in -1..1 (x right, y up). */
  lookAt(x: number, y: number): void {
    this.target.x = MathUtils.clamp(Number.isFinite(x) ? x : 0, -1, 1);
    this.target.y = MathUtils.clamp(Number.isFinite(y) ? y : 0, -1, 1);
  }

  pose(action: TourAction): void {
    const now = performance.now();
    switch (action.type) {
      case 'point': {
        const played = this.playClip(action.side === 'left' ? CLIP_NAMES.pointLeft : CLIP_NAMES.pointRight);
        if (!played) this.gestures.play(action.side === 'left' ? 'glanceLeft' : 'glanceRight', now);
        break;
      }
      case 'emote':
        this.emote(action.name, now);
        break;
      default:
        // goto, highlight and open belong to the page.
        break;
    }
  }

  /** Switch the base loop to the Talking clip while a line plays, when the asset has one. */
  setSpeaking(on: boolean): void {
    const next = on && this.talking ? this.talking : this.idle;
    if (!next || next === this.base) return;
    const previous = this.base;
    this.base = next;
    if (!this.gesture) crossFade(previous, next, CROSSFADE_S);
  }

  dispose(): void {
    this.face.remove(this.gestures);
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onFinished);
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.root);
    }
  }

  private clip(name: string): AnimationClip | null {
    return AnimationClip.findByName(this.clips, name);
  }

  private emote(name: EmoteName, nowMs: number): void {
    switch (name) {
      case 'neutral':
        this.gestures.clear();
        break;
      case 'nod':
        if (!this.playClip(CLIP_NAMES.nod)) this.gestures.play('nod', nowMs);
        break;
      case 'smile':
      case 'think':
        this.gestures.play(name, nowMs);
        break;
    }
  }

  private playClip(name: string): boolean {
    const clip = this.clip(name);
    if (!clip || !this.mixer) return false;
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(LoopOnce, 1);
    // Hold the last frame so the fade back to the base loop starts from the gesture's pose, not the bind pose.
    action.clampWhenFinished = true;
    const from = this.gesture ?? this.base;
    this.gesture = action;
    crossFade(from, action, CROSSFADE_S);
    return true;
  }
}
