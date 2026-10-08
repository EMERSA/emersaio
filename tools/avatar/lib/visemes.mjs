/**
 * Viseme timeline from analysed audio plus the spoken text.
 *
 * The audio decides when the mouth is open and how far (RMS envelope). The text decides which viseme shape to
 * show: its graphemic units are spread over the voiced frames in reading order, so "p", "b" and "m" close
 * the lips where a word actually has them instead of wherever the energy dips. The spectrum only corrects
 * the alignment locally: a consonant frame that sounds like a fricative snaps to a sibilant the text places
 * next to it, and only an extreme, noise-like frame overrides the text outright. Measured on this voice,
 * spectral features alone flag a fifth of a sentence without any sibilant, so they cannot be trusted alone.
 * Output cues are [offsetMs, visemeId, weight].
 */

import { textToUnits } from './text-visemes.mjs';

const VOICED = 0.12;
const MAX_CUES = 400;
const CLOSURES = new Set([21, 18]);
const SIBILANTS = new Set([15, 16, 17, 18]);
const MODERATE_CENTROID = 4000;
const EXTREME_CENTROID = 6000;
const EXTREME_FLATNESS = 0.45;

/**
 * @typedef {import('./audio.mjs').Frame} Frame
 * @typedef {[number, number, number]} Cue
 */

/**
 * Spread the units over the voiced frames: each voiced frame gets the unit that overlaps it most, with lip
 * closures winning any frame they touch for at least a quarter of it.
 * @param {Frame[]} frames
 * @param {import('./text-visemes.mjs').Unit[]} units
 * @returns {{ spoken: import('./text-visemes.mjs').Unit[], assigned: (number | null)[] }} unit index per frame
 */
const alignUnits = (frames, units) => {
  const voiced = frames.map((frame) => frame.openness > VOICED);
  const voicedCount = voiced.filter(Boolean).length;
  const spoken = units.filter((unit) => unit.viseme !== 0 || unit.weight < 1);
  const totalWeight = spoken.reduce((sum, unit) => sum + unit.weight, 0);
  if (!voicedCount || !totalWeight) return { spoken, assigned: frames.map(() => null) };
  const spans = [];
  let at = 0;
  for (const unit of spoken) {
    const length = (unit.weight / totalWeight) * voicedCount;
    spans.push({ unit, from: at, to: at + length });
    at += length;
  }
  const assigned = [];
  let position = 0;
  let cursor = 0;
  for (let i = 0; i < frames.length; i++) {
    if (!voiced[i]) {
      assigned.push(null);
      continue;
    }
    const from = position;
    const to = position + 1;
    position = to;
    while (cursor < spans.length - 1 && spans[cursor].to <= from) cursor++;
    let best = -1;
    let bestOverlap = 0;
    let closure = -1;
    for (let j = cursor; j < spans.length && spans[j].from < to; j++) {
      const overlap = Math.min(to, spans[j].to) - Math.max(from, spans[j].from);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = j;
      }
      if (CLOSURES.has(spans[j].unit.viseme) && overlap >= 0.25) closure = j;
    }
    assigned.push(closure >= 0 ? closure : best >= 0 ? best : Math.min(cursor, spans.length - 1));
  }
  return { spoken, assigned };
};

/** The sibilant the text places within `radius` units of `index`, if any. */
const nearbySibilant = (spoken, index, radius) => {
  for (let distance = 0; distance <= radius; distance++) {
    for (const j of [index - distance, index + distance]) {
      const unit = spoken[j];
      if (unit && SIBILANTS.has(unit.viseme)) return unit.viseme;
    }
  }
  return null;
};

/** Which viseme a voiced frame shows: the aligned text unit, corrected by what the spectrum says. */
const chooseViseme = (frame, spoken, index) => {
  const unit = spoken[index];
  if (SIBILANTS.has(unit.viseme)) return unit.viseme;
  if (frame.centroid > EXTREME_CENTROID && frame.flatness > EXTREME_FLATNESS)
    return nearbySibilant(spoken, index, 2) ?? 15;
  if (frame.centroid > MODERATE_CENTROID && !unit.vowel) return nearbySibilant(spoken, index, 1) ?? unit.viseme;
  return unit.viseme;
};

/**
 * @param {Frame[]} frames
 * @param {string} text
 * @param {number} durationMs
 * @returns {Cue[]}
 */
export const timelineFromAudio = (frames, text, durationMs) => {
  const { spoken, assigned } = alignUnits(frames, textToUnits(text));
  const raw = frames.map((frame, i) => {
    const index = assigned[i];
    if (index === null || frame.openness <= VOICED) return { atMs: frame.atMs, viseme: 0, weight: 0 };
    const unit = spoken[index];
    const viseme = chooseViseme(frame, spoken, index);
    if (viseme === 0) return { atMs: frame.atMs, viseme: 0, weight: 0 };
    let weight;
    if (CLOSURES.has(viseme)) weight = Math.max(0.6, 0.5 + 0.5 * frame.openness);
    else if (unit.vowel) weight = 0.3 + 0.7 * frame.openness;
    else weight = 0.45 + 0.55 * frame.openness;
    return { atMs: frame.atMs, viseme, weight: Math.min(1, weight) };
  });
  return compact(raw, durationMs);
};

/** Emit a cue when the viseme changes, the weight moves by a tenth, or 200 ms passed; then cap the count. */
const compact = (raw, durationMs) => {
  const cues = [];
  let last = null;
  for (const point of raw) {
    const changed =
      !last ||
      point.viseme !== last.viseme ||
      Math.abs(point.weight - last.weight) >= 0.1 ||
      (point.weight > 0 && point.atMs - last.atMs >= 200);
    if (!changed) continue;
    cues.push({ ...point, change: !last || point.viseme !== last.viseme });
    last = point;
  }
  while (cues.length > MAX_CUES - 1) {
    // Drop the weight-only update whose removal changes the envelope least.
    let victim = -1;
    let smallest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < cues.length; i++) {
      if (cues[i].change) continue;
      const delta = Math.abs(cues[i].weight - cues[i - 1].weight);
      if (delta < smallest) {
        smallest = delta;
        victim = i;
      }
    }
    if (victim < 0) break;
    cues.splice(victim, 1);
  }
  const out = cues.map((cue) => [cue.atMs, cue.viseme, Math.round(cue.weight * 100) / 100]);
  if (!out.length || out[out.length - 1][1] !== 0) out.push([durationMs, 0, 0]);
  return out;
};
