/**
 * The pieces: how far the head is scattered (0 assembled, 1 fully apart), free of three.js for node --test. The wire
 * shader moves every triangle as one rigid piece by this amount and the head's depth cloud scatters with it.
 */
import { scatterFor } from '../data/depth/depthMath.ts';

/** The intro: the head assembles from pieces over this long after the being first shows. */
export const INTRO_S = 1.6;
/** How far the pieces pulse apart by themselves while tokens stream. */
export const SHATTER_PULSE = 0.12;
/** A value set from outside holds this long; then the automatic pulse resumes. */
export const SHATTER_MANUAL_HOLD_MS = 2000;
/** The amount eases toward its goal with this time constant, so a change swells rather than snaps. */
export const SHATTER_EASE_S = 0.12;

/** The intro's amount at a time since it began: 1 at the start, 0 from INTRO_S on, easing out (cubic). */
export function introShatter(elapsedS: number): number {
  const t = Math.min(1, Math.max(0, elapsedS / INTRO_S));
  return (1 - t) ** 3;
}

/** The automatic pulse the token meter asks for. */
export function autoShatter(tokenRate01: number, pulse01: number): number {
  return SHATTER_PULSE * scatterFor(tokenRate01, pulse01);
}

/** The goal for a frame: a value set from outside within the hold wins, otherwise the automatic pulse. */
export function shatterGoal(manual: number, manualAgeMs: number, tokenRate01: number, pulse01: number): number {
  return manualAgeMs < SHATTER_MANUAL_HOLD_MS ? manual : autoShatter(tokenRate01, pulse01);
}
