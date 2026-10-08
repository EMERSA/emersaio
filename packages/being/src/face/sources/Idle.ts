import { CHANNEL, type FaceSource } from '../source.ts';

export interface IdleOptions {
  /** Random source in [0, 1); injectable so tests get a repeatable face. */
  random?: () => number;
  blinkMinMs?: number;
  blinkMaxMs?: number;
}

const BLINK_CLOSE_MS = 120;
const BLINK_OPEN_MS = 140;
const BREATH_PERIOD_MS = 4400;
const BREATH_JAW = 0.02;
const SACCADE_MIN_MS = 1500;
const SACCADE_MAX_MS = 4000;
const EYE_YAW_RANGE = 0.15;
const EYE_PITCH_RANGE = 0.1;
/** Eyes settle on a new target in roughly this long; a real saccade is faster but the wire reads better slow. */
const EYE_SETTLE_MS = 180;
const TWO_PI = Math.PI * 2;

const IDLE_CHANNELS = [
  CHANNEL.blinkLeft,
  CHANNEL.blinkRight,
  CHANNEL.browUp,
  CHANNEL.browDown,
  CHANNEL.eyesYaw,
  CHANNEL.eyesPitch,
  CHANNEL.jawOpen,
] as const;

const smoothstep = (progress: number): number => progress * progress * (3 - 2 * progress);

/**
 * The face when nothing else owns it: blinks every few seconds, a little brow life, eyes that wander and the
 * breath on the jaw. Priority 0, so any speech or stream takes the channels it needs and the rest keeps living.
 */
export class IdleSource implements FaceSource {
  readonly name = 'idle';
  readonly priority = 0;
  private readonly random: () => number;
  private readonly blinkMinMs: number;
  private readonly blinkMaxMs: number;
  private readonly phases: readonly number[];
  private startedAt = -1;
  private lastSampleAt = -1;
  private nextBlinkAt = 0;
  private blinkStartedAt = -1;
  private nextSaccadeAt = 0;
  private eyeTargetYaw = 0;
  private eyeTargetPitch = 0;
  private eyeYaw = 0;
  private eyePitch = 0;

  constructor(options: IdleOptions = {}) {
    this.random = options.random ?? Math.random;
    this.blinkMinMs = options.blinkMinMs ?? 2000;
    this.blinkMaxMs = Math.max(this.blinkMinMs, options.blinkMaxMs ?? 6000);
    this.phases = [this.random() * TWO_PI, this.random() * TWO_PI, this.random() * TWO_PI];
  }

  active(_nowMs: number): boolean {
    return true;
  }

  sample(nowMs: number, frame: Float32Array, written: Uint8Array): void {
    if (this.startedAt < 0) this.begin(nowMs);
    const dtMs = this.lastSampleAt < 0 ? 0 : Math.max(0, nowMs - this.lastSampleAt);
    this.lastSampleAt = nowMs;
    const seconds = (nowMs - this.startedAt) / 1000;

    const blink = this.blinkAt(nowMs);
    frame[CHANNEL.blinkLeft] = blink;
    frame[CHANNEL.blinkRight] = blink;

    // Two slow sines with unrelated periods look like life without ever repeating within a visit.
    const [phaseA = 0, phaseB = 0, phaseC = 0] = this.phases;
    const browUp =
      0.04 + 0.04 * Math.sin((TWO_PI * seconds) / 7.3 + phaseA) * Math.sin((TWO_PI * seconds) / 3.1 + phaseB);
    const browDown = 0.03 * (0.5 + 0.5 * Math.sin((TWO_PI * seconds) / 5.7 + phaseC));
    frame[CHANNEL.browUp] = browUp;
    frame[CHANNEL.browDown] = browDown;

    this.wander(nowMs, dtMs);
    frame[CHANNEL.eyesYaw] = this.eyeYaw;
    frame[CHANNEL.eyesPitch] = this.eyePitch;

    frame[CHANNEL.jawOpen] = BREATH_JAW * (0.5 + 0.5 * Math.sin((TWO_PI * seconds) / (BREATH_PERIOD_MS / 1000)));

    for (const channel of IDLE_CHANNELS) written[channel] = 1;
  }

  stop(): void {
    this.startedAt = -1;
    this.lastSampleAt = -1;
    this.blinkStartedAt = -1;
  }

  private begin(nowMs: number): void {
    this.startedAt = nowMs;
    this.nextBlinkAt = nowMs + this.between(this.blinkMinMs, this.blinkMaxMs);
    this.nextSaccadeAt = nowMs + this.between(SACCADE_MIN_MS, SACCADE_MAX_MS);
  }

  private between(min: number, max: number): number {
    return min + (max - min) * this.random();
  }

  private blinkAt(nowMs: number): number {
    // The blink starts when it was due, not at the frame that noticed, so timing does not depend on frame rate.
    if (this.blinkStartedAt < 0 && nowMs >= this.nextBlinkAt) this.blinkStartedAt = this.nextBlinkAt;
    if (this.blinkStartedAt < 0) return 0;
    const elapsed = nowMs - this.blinkStartedAt;
    if (elapsed < BLINK_CLOSE_MS) return smoothstep(elapsed / BLINK_CLOSE_MS);
    if (elapsed < BLINK_CLOSE_MS + BLINK_OPEN_MS) return 1 - smoothstep((elapsed - BLINK_CLOSE_MS) / BLINK_OPEN_MS);
    this.blinkStartedAt = -1;
    this.nextBlinkAt = nowMs + this.between(this.blinkMinMs, this.blinkMaxMs);
    return 0;
  }

  private wander(nowMs: number, dtMs: number): void {
    if (nowMs >= this.nextSaccadeAt) {
      this.eyeTargetYaw = this.between(-EYE_YAW_RANGE, EYE_YAW_RANGE);
      this.eyeTargetPitch = this.between(-EYE_PITCH_RANGE, EYE_PITCH_RANGE);
      this.nextSaccadeAt = nowMs + this.between(SACCADE_MIN_MS, SACCADE_MAX_MS);
    }
    const alpha = dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / EYE_SETTLE_MS);
    this.eyeYaw += (this.eyeTargetYaw - this.eyeYaw) * alpha;
    this.eyePitch += (this.eyeTargetPitch - this.eyePitch) * alpha;
  }
}
