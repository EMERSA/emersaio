/**
 * Turning Emily by hand, kept free of three.js so node --test can check it. A drag turns her about her own vertical
 * axis, one full turn for a drag across the whole stage, and tilts the view up or down (as camera elevation) within
 * PITCH_LIMIT_DEG at the same rate. Let go and the turn coasts on, fading with a time constant of INERTIA_TAU_S from
 * at most MAX_SPIN. Left alone for RETURN_AFTER_S (RETURN_TALKING_S in a conversation, at once when she speaks) she
 * comes back to face the visitor: a critically damped spring to the nearest whole turn, and the view to level.
 * Under reduced motion a drag turns her directly and that is all: no coasting and no return.
 */

/** Radians of yaw for a drag across the stage's full width: one turn. */
export const TURN_PER_WIDTH = 2 * Math.PI;
/** The coast after a fling fades with this time constant... */
export const INERTIA_TAU_S = 0.5;
/** ...from at most this many radians a second. */
export const MAX_SPIN = 8;
/** The view tilts at most this far above or below level. */
export const PITCH_LIMIT_DEG = 20;
/** Idle time before she turns back to the visitor, and the shorter wait while a conversation is on. */
export const RETURN_AFTER_S = 3.5;
export const RETURN_TALKING_S = 1.5;
/** The return spring's natural frequency: critically damped, it is within 1 percent of home after about 1.1 s. */
export const RETURN_OMEGA = 6;

const PITCH_LIMIT = (PITCH_LIMIT_DEG * Math.PI) / 180;
const TURN = 2 * Math.PI;
/** Below this, in radians and radians a second, a coast or a return has finished. */
const REST = 1e-4;

const clamp = (value: number, min: number, max: number): number => (value < min ? min : value > max ? max : value);

export interface OrbitOptions {
  reducedMotion?: boolean;
}

/**
 * One step of a critically damped spring toward 0, exactly: x(t) = (x0 + (v0 + w x0) t) e^(-w t). Never overshoots
 * from rest, and holds at any frame rate.
 */
export function springStep(x: number, v: number, omega: number, dt: number): [number, number] {
  const decay = Math.exp(-omega * dt);
  const c = v + omega * x;
  return [(x + c * dt) * decay, (v - omega * c * dt) * decay];
}

export class Orbit {
  /** Her turn about her vertical axis and the view's elevation, in radians (yaw positive turns her to her left). */
  yaw = 0;
  pitch = 0;
  private yawSpeed = 0;
  private pitchSpeed = 0;
  private held = false;
  /** Where the drag found her, for a drag that is cancelled. */
  private grabYaw = 0;
  private grabPitch = 0;
  private idleFor = 0;
  private returning = false;
  private home = 0;
  private readonly reducedMotion: boolean;

  // Explicit fields rather than parameter properties: node --test runs this file with type stripping alone.
  constructor(options: OrbitOptions = {}) {
    this.reducedMotion = options.reducedMotion === true;
  }

  /** A drag began: she stops where she is and follows the pointer. */
  grab(): void {
    this.held = true;
    this.returning = false;
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
    this.idleFor = 0;
    this.grabYaw = this.yaw;
    this.grabPitch = this.pitch;
  }

  /**
   * The drag was cancelled: the browser took the pointer for a page scroll it began on touch (the few pixels before
   * it decided were never meant as a turn), or a second pointer came down. She goes back to where the drag found her
   * and nothing coasts.
   */
  cancel(): void {
    if (!this.held) return;
    this.held = false;
    this.idleFor = 0;
    this.yaw = this.grabYaw;
    this.pitch = this.grabPitch;
    this.yawSpeed = 0;
    this.pitchSpeed = 0;
  }

  /** The pointer moved by (dx, dy) CSS pixels over a stage `width` CSS pixels wide. */
  drag(dx: number, dy: number, width: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const k = TURN_PER_WIDTH / Math.max(1, width);
    this.yaw += dx * k;
    this.pitch = clamp(this.pitch + dy * k, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** The drag ended with this velocity in CSS pixels a second; she coasts on unless motion is reduced. */
  release(vx: number, vy: number, width: number): void {
    this.held = false;
    this.idleFor = 0;
    if (this.reducedMotion) return;
    const k = TURN_PER_WIDTH / Math.max(1, width);
    this.yawSpeed = clamp(Number.isFinite(vx) ? vx * k : 0, -MAX_SPIN, MAX_SPIN);
    this.pitchSpeed = clamp(Number.isFinite(vy) ? vy * k : 0, -MAX_SPIN, MAX_SPIN);
  }

  /**
   * Advance by dt seconds. `returnAfterS` is how long she waits, left alone, before turning back: RETURN_AFTER_S,
   * RETURN_TALKING_S in a conversation, 0 while she speaks.
   */
  update(dt: number, returnAfterS: number = RETURN_AFTER_S): void {
    if (this.held || this.reducedMotion || !(dt > 0)) return;
    if (!this.returning) {
      this.coast(dt);
      this.idleFor += dt;
      if (this.idleFor >= returnAfterS && !this.atHome()) {
        this.returning = true;
        this.home = Math.round(this.yaw / TURN) * TURN;
      }
    }
    if (!this.returning) return;
    [this.yaw, this.yawSpeed] = springStep(this.yaw - this.home, this.yawSpeed, RETURN_OMEGA, dt);
    this.yaw += this.home;
    [this.pitch, this.pitchSpeed] = springStep(this.pitch, this.pitchSpeed, RETURN_OMEGA, dt);
    const settled =
      Math.abs(this.yaw - this.home) < REST &&
      Math.abs(this.pitch) < REST &&
      Math.abs(this.yawSpeed) < REST &&
      Math.abs(this.pitchSpeed) < REST;
    if (settled) {
      // A whole turn is no turn: she faces the visitor again and the count starts over.
      this.yaw = 0;
      this.pitch = 0;
      this.yawSpeed = 0;
      this.pitchSpeed = 0;
      this.returning = false;
    }
  }

  /** True while she moves by herself or under the pointer: a drag, a coast or the return. */
  moving(): boolean {
    return this.held || this.returning || this.yawSpeed !== 0 || this.pitchSpeed !== 0;
  }

  /** True while a drag holds her. */
  dragging(): boolean {
    return this.held;
  }

  /** The view's elevation in degrees, for Stage.setElevation. */
  pitchDeg(): number {
    return (this.pitch * 180) / Math.PI;
  }

  /** The fling fading away; the tilt stops at its limit. */
  private coast(dt: number): void {
    if (this.yawSpeed === 0 && this.pitchSpeed === 0) return;
    const decay = Math.exp(-dt / INERTIA_TAU_S);
    const travel = INERTIA_TAU_S * (1 - decay);
    this.yaw += this.yawSpeed * travel;
    const pitch = this.pitch + this.pitchSpeed * travel;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.yawSpeed *= decay;
    this.pitchSpeed = this.pitch === pitch ? this.pitchSpeed * decay : 0;
    if (Math.abs(this.yawSpeed) < REST) this.yawSpeed = 0;
    if (Math.abs(this.pitchSpeed) < REST) this.pitchSpeed = 0;
  }

  /** Facing the visitor already: a whole turn and a level view. */
  private atHome(): boolean {
    const offset = this.yaw - Math.round(this.yaw / TURN) * TURN;
    return Math.abs(offset) < REST && Math.abs(this.pitch) < REST && this.yawSpeed === 0 && this.pitchSpeed === 0;
  }
}
