/**
 * The liquid skin of the kinect-demo shards, kept free of three.js so node --test can check it. A height field over
 * the sensor's frame obeys the wave equation, stepped explicitly on a grid: each step the new height is half the
 * sum of the four neighbours less the height two steps back (Courant number squared of one half, the stable choice),
 * times a damping. Disturbances are Gaussian brushes added to the height: Emily's voice at her mouth, the pointer
 * stirring the surface, and now and then a drop somewhere on the face. avatar/shaders/fluid.glsl.ts is this step
 * written in GLSL; keep the two in step.
 */

/** The simulation's grid over the sensor frame, 4:3 like the sensor. */
export const FLUID_GRID = { cols: 256, rows: 192 } as const;
/** One step of the wave equation in seconds: 120 a second, so a ring crosses the face in about a second. */
export const FLUID_STEP_S = 1 / 120;
/** The most steps one frame may take: a long frame skips time rather than piling work on the next. */
export const FLUID_MAX_STEPS = 4;
/** What a step keeps of the motion: about half after a second, so a ring fades before it has crossed twice. */
export const FLUID_DAMPING = 0.994;
/** Emily's voice: a brush at her lips that rises and falls at this rate while she speaks, scaled by her loudness. */
export const VOICE_BRUSH = { radius: 0.016, force: 0.05, hz: 5 } as const;
/** The pointer: a brush that pushes the surface down in proportion to how fast it moves over the face. */
export const STIR_BRUSH = { radius: 0.016, force: 0.06 } as const;
/** A drop: one step's push somewhere on the face, every so often, so the skin is never quite still. */
export const DROP_BRUSH = { radius: 0.007, force: 0.7, minGapS: 0.6, maxGapS: 1.8 } as const;
/** Where drops land, in sensor uv: the face and the upper chest, not the empty corners. */
export const DROP_AREA = { u: [0.3, 0.7], v: [0.4, 0.85] } as const;
/** Heights are held within this, so a run of strong brushes can never blow the surface up. */
export const FLUID_LIMIT = 1;

/** A brush: centre in sensor uv, the height it adds this step at its centre, and its radius in uv (height units). */
export interface Brush {
  u: number;
  v: number;
  amount: number;
  radius: number;
}

/** The height a brush adds at (u, v); `aspect` is the frame's width over its height, so the brush is round. */
export function brushAt(brush: Brush, u: number, v: number, aspect: number): number {
  if (brush.amount === 0 || !(brush.radius > 0)) return 0;
  const du = (u - brush.u) * aspect;
  const dv = v - brush.v;
  return brush.amount * Math.exp(-(du * du + dv * dv) / (brush.radius * brush.radius));
}

/** The voice brush's push for this step: loudness 0..1 at time t (seconds of simulation). */
export function voicePush(level: number, t: number): number {
  const loud = Math.min(1, Math.max(0, Number.isFinite(level) ? level : 0));
  return loud * VOICE_BRUSH.force * Math.sin(2 * Math.PI * VOICE_BRUSH.hz * t);
}

/** The stir brush's push for a pointer moving at `speed` sensor-frames a second (0 when it rests). */
export function stirPush(speed: number): number {
  const s = Math.min(4, Math.max(0, Number.isFinite(speed) ? speed : 0));
  return -STIR_BRUSH.force * s;
}

/** Seconds until the next drop, from a random number in [0, 1). */
export function dropGap(random: number): number {
  return DROP_BRUSH.minGapS + (DROP_BRUSH.maxGapS - DROP_BRUSH.minGapS) * random;
}

/**
 * One step on the CPU, the twin of the shader: `now` and `before` are the heights at this step and the last,
 * `surface` is 1 where the sensor saw the figure (the liquid exists only there). Returns the next heights.
 */
export function waveStep(
  now: Float32Array,
  before: Float32Array,
  surface: Float32Array,
  cols: number,
  rows: number,
  brushes: readonly Brush[] = [],
): Float32Array {
  const next = new Float32Array(cols * rows);
  const at = (x: number, y: number): number =>
    now[Math.min(rows - 1, Math.max(0, y)) * cols + Math.min(cols - 1, Math.max(0, x))] ?? 0;
  const aspect = cols / rows;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      let h = ((at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.5 - (before[i] ?? 0)) * FLUID_DAMPING;
      const u = (x + 0.5) / cols;
      const v = (y + 0.5) / rows;
      for (const brush of brushes) h += brushAt(brush, u, v, aspect);
      next[i] = Math.min(FLUID_LIMIT, Math.max(-FLUID_LIMIT, h)) * (surface[i] ?? 0);
    }
  }
  return next;
}
