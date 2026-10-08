import { CHANNEL, type FaceSource, VISEME_COUNT } from '../source.ts';
import { ARKIT_ORDER_61 } from '../tables/arkit52.ts';

export interface ArkitStreamOptions {
  /** Frame layout by name; pass the provider's own order if it differs from ARKIT_ORDER_61. */
  order?: readonly string[];
  /** Unit of the rotation slots. Radians unless the provider documents degrees. */
  rotationUnit?: 'radians' | 'degrees';
  /** A frame older than this means the stream has stopped and the face releases to lower sources. */
  staleMs?: number;
}

const DEGREES = Math.PI / 180;
/** The driver clamps head rotation to these angles, so a channel value of 1 means "all the way". */
const HEAD_RANGE = { yaw: 25 * DEGREES, pitch: 15 * DEGREES, roll: 10 * DEGREES } as const;
const EYE_RANGE = { yaw: 30 * DEGREES, pitch: 20 * DEGREES } as const;

const NEEDED = [
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthPressLeft',
  'mouthPressRight',
  'eyeBlinkLeft',
  'eyeBlinkRight',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeLookDownLeft',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeLookDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'browDownLeft',
  'browDownRight',
  'headYaw',
  'headPitch',
  'headRoll',
  'leftEyeYaw',
  'leftEyePitch',
  'rightEyeYaw',
  'rightEyePitch',
] as const;

type Needed = (typeof NEEDED)[number];

const clamp = (value: number, min: number, max: number): number => (value < min ? min : value > max ? max : value);
const clamp01 = (value: number): number => clamp(value, 0, 1);

const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now());

/**
 * A live 61-value ARKit frame stream (Convai, or any capture tool) mapped onto the face channels. Priority 20:
 * while frames arrive the stream owns the whole face; 200 ms without a frame and it lets go. The viseme
 * channels are an approximation from jaw and lip shapes, so the wire mouth keeps its phoneme language.
 */
export class ArkitStreamSource implements FaceSource {
  readonly name = 'arkit-stream';
  readonly priority = 20;
  private readonly frame: Float32Array;
  private readonly slots: Record<Needed, number>;
  private readonly rotationScale: number;
  private readonly staleMs: number;
  private lastPushAt = Number.NEGATIVE_INFINITY;

  constructor(options: ArkitStreamOptions = {}) {
    const order = options.order ?? ARKIT_ORDER_61;
    this.frame = new Float32Array(order.length);
    this.slots = Object.fromEntries(NEEDED.map((name) => [name, order.indexOf(name)])) as Record<Needed, number>;
    this.rotationScale = options.rotationUnit === 'degrees' ? DEGREES : 1;
    this.staleMs = options.staleMs ?? 200;
  }

  /** Feed one frame. `atMs` is on the driver clock (performance.now) and defaults to now. */
  push(frame61: ArrayLike<number>, atMs: number = now()): void {
    const length = Math.min(frame61.length, this.frame.length);
    for (let index = 0; index < length; index += 1) {
      const value = frame61[index];
      this.frame[index] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    }
    this.lastPushAt = atMs;
  }

  active(nowMs: number): boolean {
    return nowMs - this.lastPushAt < this.staleMs;
  }

  sample(_nowMs: number, frame: Float32Array, written: Uint8Array): void {
    const jawOpen = this.read('jawOpen');
    const funnel = this.read('mouthFunnel');
    const pucker = this.read('mouthPucker');
    const press = (this.read('mouthPressLeft') + this.read('mouthPressRight')) / 2;
    const stretch = (this.read('mouthStretchLeft') + this.read('mouthStretchRight')) / 2;

    for (let viseme = 0; viseme < VISEME_COUNT; viseme += 1) {
      frame[viseme] = 0;
      written[viseme] = 1;
    }
    frame[1] = clamp01(jawOpen - 0.5 * funnel - 0.5 * pucker);
    frame[7] = clamp01(Math.max(pucker, funnel));
    frame[21] = clamp01(Math.max(this.read('mouthClose'), press));
    frame[18] = clamp01(this.read('mouthRollLower'));
    frame[6] = clamp01(stretch * (1 - jawOpen));

    frame[CHANNEL.jawOpen] = clamp01(jawOpen);
    frame[CHANNEL.blinkLeft] = clamp01(this.read('eyeBlinkLeft'));
    frame[CHANNEL.blinkRight] = clamp01(this.read('eyeBlinkRight'));
    frame[CHANNEL.browUp] = clamp01(
      Math.max(this.read('browInnerUp'), (this.read('browOuterUpLeft') + this.read('browOuterUpRight')) / 2),
    );
    frame[CHANNEL.browDown] = clamp01((this.read('browDownLeft') + this.read('browDownRight')) / 2);
    frame[CHANNEL.smile] = clamp01((this.read('mouthSmileLeft') + this.read('mouthSmileRight')) / 2);
    frame[CHANNEL.frown] = clamp01((this.read('mouthFrownLeft') + this.read('mouthFrownRight')) / 2);

    frame[CHANNEL.headYaw] = this.rotation('headYaw', HEAD_RANGE.yaw);
    frame[CHANNEL.headPitch] = this.rotation('headPitch', HEAD_RANGE.pitch);
    frame[CHANNEL.headRoll] = this.rotation('headRoll', HEAD_RANGE.roll);

    const eyeYaw = (this.rotation('leftEyeYaw', EYE_RANGE.yaw) + this.rotation('rightEyeYaw', EYE_RANGE.yaw)) / 2;
    const eyePitch =
      (this.rotation('leftEyePitch', EYE_RANGE.pitch) + this.rotation('rightEyePitch', EYE_RANGE.pitch)) / 2;
    // Without rotation slots the look blendshapes say where the eyes point: in means toward the nose.
    frame[CHANNEL.eyesYaw] = eyeYaw !== 0 ? eyeYaw : this.lookYaw();
    frame[CHANNEL.eyesPitch] = eyePitch !== 0 ? eyePitch : this.lookPitch();

    for (const channel of OWNED_CHANNELS) written[channel] = 1;
  }

  stop(): void {
    this.lastPushAt = Number.NEGATIVE_INFINITY;
    this.frame.fill(0);
  }

  private read(name: Needed): number {
    const slot = this.slots[name];
    return slot < 0 ? 0 : (this.frame[slot] ?? 0);
  }

  private rotation(name: Needed, range: number): number {
    return clamp((this.read(name) * this.rotationScale) / range, -1, 1);
  }

  private lookYaw(): number {
    const left = this.read('eyeLookInLeft') - this.read('eyeLookOutLeft');
    const right = this.read('eyeLookOutRight') - this.read('eyeLookInRight');
    return clamp((left + right) / 2, -1, 1);
  }

  private lookPitch(): number {
    const left = this.read('eyeLookUpLeft') - this.read('eyeLookDownLeft');
    const right = this.read('eyeLookUpRight') - this.read('eyeLookDownRight');
    return clamp((left + right) / 2, -1, 1);
  }
}

const OWNED_CHANNELS = [
  CHANNEL.jawOpen,
  CHANNEL.blinkLeft,
  CHANNEL.blinkRight,
  CHANNEL.browUp,
  CHANNEL.browDown,
  CHANNEL.smile,
  CHANNEL.frown,
  CHANNEL.headYaw,
  CHANNEL.headPitch,
  CHANNEL.headRoll,
  CHANNEL.eyesYaw,
  CHANNEL.eyesPitch,
] as const;
