/**
 * How far the token meter scatters the figure, free of three.js and of the depth code: the pieces of the wire
 * (avatar/shatter.ts) and the kinect cloud both follow it. It lives in the being's core rather than with the depth
 * maths, so the core imports nothing of the depth files and the dev harness's depth sources share nothing with it.
 */

/** The scatter amount the token meter asks for: the normalised rate carries it, each arrival adds a flick. */
export function scatterFor(tokenRate01: number, pulse01: number): number {
  const rate = Number.isFinite(tokenRate01) ? Math.min(1, Math.max(0, tokenRate01)) : 0;
  const pulse = Number.isFinite(pulse01) ? Math.min(1, Math.max(0, pulse01)) : 0;
  return Math.min(1, rate + 0.3 * pulse);
}
