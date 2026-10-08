import type { VisemeCue } from '../../types.ts';
import { CHANNEL, type FaceSource, VISEME_COUNT } from '../source.ts';
import { clampViseme, jawOpenOf } from '../tables/ms22.ts';

/** The mouth stays owned for a moment after the audio ends so the last shape releases through the driver, not a cut. */
export const TIMELINE_TAIL_MS = 150;

/** How long a cue takes to reach its weight while the previous cue fades: one short phoneme. */
export const VISEME_RAMP_MS = 70;

export interface NormalizedCue {
  readonly at: number;
  readonly viseme: number;
  readonly weight: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const smoothstep = (progress: number): number => progress * progress * (3 - 2 * progress);

/** Sort and sanitise raw cues once, so sampling never has to trust the JSON that produced them. */
export const normalizeCues = (cues: readonly VisemeCue[]): NormalizedCue[] =>
  cues
    .map(([at, viseme, weight]) => ({
      at: Number.isFinite(at) ? at : 0,
      viseme: clampViseme(viseme),
      weight: clamp01(Number.isFinite(weight ?? 1) ? (weight ?? 1) : 1),
    }))
    .sort((a, b) => a.at - b.at);

/** Index of the last cue at or before t, or -1 before the first cue. */
const cueIndexAt = (cues: readonly NormalizedCue[], t: number): number => {
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (cue !== undefined && cue.at <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

const addViseme = (frame: Float32Array, viseme: number, weight: number): void => {
  // Viseme 0 is silence: it closes the mouth by contributing nothing.
  if (viseme === 0 || weight <= 0) return;
  frame[viseme] = Math.min(1, (frame[viseme] ?? 0) + weight);
  frame[CHANNEL.jawOpen] = Math.min(1, (frame[CHANNEL.jawOpen] ?? 0) + weight * jawOpenOf(viseme));
};

/**
 * Write the mouth for time t (milliseconds from clip start) into the frame. The current cue ramps toward its
 * weight while the previous cue fades out; past durationMs a virtual silence cue closes the mouth. All 22
 * viseme channels and jawOpen are claimed, so the driver releases nothing else while a line plays.
 */
export const sampleCues = (
  cues: readonly NormalizedCue[],
  t: number,
  durationMs: number,
  frame: Float32Array,
  written: Uint8Array,
): void => {
  for (let channel = 0; channel < VISEME_COUNT; channel += 1) {
    frame[channel] = 0;
    written[channel] = 1;
  }
  frame[CHANNEL.jawOpen] = 0;
  written[CHANNEL.jawOpen] = 1;
  if (t < 0 || cues.length === 0) return;

  const index = cueIndexAt(cues, t);
  if (index < 0) return;
  const current = cues[index];
  if (current === undefined) return;

  let previous = index > 0 ? cues[index - 1] : undefined;
  let viseme = current.viseme;
  let weight = current.weight;
  let at = current.at;
  if (t > durationMs && current.at <= durationMs) {
    previous = current;
    viseme = 0;
    weight = 0;
    at = durationMs;
  }

  const progress = smoothstep(clamp01((t - at) / VISEME_RAMP_MS));
  addViseme(frame, viseme, weight * progress);
  if (previous !== undefined) addViseme(frame, previous.viseme, previous.weight * (1 - progress));
};

/**
 * A baked lip-sync timeline played against an external clock (the audio element currentTime, or a text
 * timer). Priority 10: it overrides idle breathing but yields to a live ARKit stream.
 */
export class VisemeTimelineSource implements FaceSource {
  readonly name = 'viseme-timeline';
  readonly priority = 10;
  private readonly cues: readonly NormalizedCue[];
  private readonly clock: () => number;
  private readonly durationMs: number;
  private stopped = false;

  /**
   * @param cues [offsetMs, visemeId, weight?] triples; order does not matter.
   * @param clock milliseconds since the clip started; may be negative while the audio is still loading.
   * @param durationMs the clip length; the source stays active for TIMELINE_TAIL_MS beyond it.
   */
  constructor(cues: readonly VisemeCue[], clock: () => number, durationMs: number) {
    this.cues = normalizeCues(cues);
    this.clock = clock;
    this.durationMs = Math.max(0, durationMs);
  }

  active(_nowMs: number): boolean {
    return !this.stopped && this.clock() <= this.durationMs + TIMELINE_TAIL_MS;
  }

  sample(_nowMs: number, frame: Float32Array, written: Uint8Array): void {
    sampleCues(this.cues, this.clock(), this.durationMs, frame, written);
  }

  stop(): void {
    this.stopped = true;
  }
}
