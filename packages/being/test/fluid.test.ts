/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Brush,
  brushAt,
  DROP_BRUSH,
  dropGap,
  FLUID_LIMIT,
  STIR_BRUSH,
  stirPush,
  VOICE_BRUSH,
  voicePush,
  waveStep,
} from '../src/data/fluidMath.ts';

const COLS = 64;
const ROWS = 48;
const everywhere = (): Float32Array => new Float32Array(COLS * ROWS).fill(1);
const energy = (h: Float32Array): number => h.reduce((sum, x) => sum + x * x, 0);
const at = (h: Float32Array, x: number, y: number): number => h[y * COLS + x] ?? 0;

/** Run the twin from a single drop in the middle for `steps` steps; returns every state. */
function ring(steps: number, surface = everywhere()): Float32Array[] {
  const drop: Brush = { u: 0.5, v: 0.5, amount: 0.5, radius: 0.03 };
  let before: Float32Array = new Float32Array(COLS * ROWS);
  let now: Float32Array = waveStep(before, before, surface, COLS, ROWS, [drop]);
  const states = [now];
  for (let i = 0; i < steps; i += 1) {
    const next = waveStep(now, before, surface, COLS, ROWS);
    before = now;
    now = next;
    states.push(now);
  }
  return states;
}

test('a drop spreads as a ring: the front moves outward and the centre falls back', () => {
  const states = ring(24);
  const first = states[0] as Float32Array;
  const late = states[24] as Float32Array;
  assert.ok(at(first, 32, 24) > 0.3, 'the drop lands in the middle');
  // Twenty-four steps later the disturbance has reached cells it had not touched, and the middle is far lower.
  assert.ok(Math.abs(at(late, 44, 24)) > 1e-3, 'the ring has travelled about twelve cells');
  assert.ok(Math.abs(at(late, 32, 24)) < at(first, 32, 24) * 0.5);
  // It spreads the same way both ways: the centre lies between cells 31 and 32, so cell 44 mirrors cell 19.
  assert.ok(Math.abs(at(late, 44, 24) - at(late, 19, 24)) < 1e-6);
});

test('the step is stable and damped: the energy never grows and is mostly gone after a few seconds', () => {
  const states = ring(720);
  const energies = states.map(energy);
  const start = Math.max(...energies.slice(0, 5));
  assert.ok(
    energies.every((e) => Number.isFinite(e)),
    'no blow-up',
  );
  assert.ok(Math.max(...energies) <= start * 1.5, 'never far above the start');
  assert.ok((energies.at(-1) ?? 0) < start * 0.05, 'six seconds at 120 steps a second leave under 5 percent');
});

test('the liquid lives only on the figure: off the surface it is pinned to zero', () => {
  const surface = everywhere();
  // The right half of the frame saw nothing.
  for (let y = 0; y < ROWS; y += 1) for (let x = COLS / 2 + 4; x < COLS; x += 1) surface[y * COLS + x] = 0;
  for (const state of ring(60, surface)) {
    for (let y = 0; y < ROWS; y += 1) assert.equal(at(state, COLS - 1, y), 0);
  }
});

test('heights are held within the limit however hard the brushes push', () => {
  const push: Brush = { u: 0.5, v: 0.5, amount: 5, radius: 0.1 };
  const zero = new Float32Array(COLS * ROWS);
  const next = waveStep(zero, zero, everywhere(), COLS, ROWS, [push]);
  assert.ok(Math.max(...next) <= FLUID_LIMIT);
});

test('the brushes: round, fading with distance; the voice rises and falls; the stir pushes down; drops are spaced', () => {
  const b: Brush = { u: 0.5, v: 0.5, amount: 1, radius: 0.02 };
  assert.equal(brushAt(b, 0.5, 0.5, 4 / 3), 1);
  assert.ok(brushAt(b, 0.52, 0.5, 4 / 3) < brushAt(b, 0.51, 0.5, 4 / 3));
  assert.equal(brushAt({ ...b, amount: 0 }, 0.5, 0.5, 4 / 3), 0);
  // The voice at full loudness swings between plus and minus the force at VOICE_BRUSH.hz; silence pushes nothing.
  const quarter = 1 / (4 * VOICE_BRUSH.hz);
  assert.ok(Math.abs(voicePush(1, quarter) - VOICE_BRUSH.force) < 1e-9);
  assert.ok(Math.abs(voicePush(1, 3 * quarter) + VOICE_BRUSH.force) < 1e-9);
  assert.equal(voicePush(0, quarter), 0);
  assert.equal(voicePush(Number.NaN, quarter), 0);
  // The stir pushes down in proportion to speed, and a wild flick is capped.
  assert.ok(stirPush(1) < 0);
  assert.equal(stirPush(0), -0);
  assert.equal(stirPush(100), -4 * STIR_BRUSH.force);
  // Drops land between the gap's bounds.
  assert.equal(dropGap(0), DROP_BRUSH.minGapS);
  assert.ok(dropGap(0.999) < DROP_BRUSH.maxGapS);
});
