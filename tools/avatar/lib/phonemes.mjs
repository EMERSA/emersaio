/**
 * Viseme timeline from the voice's own phoneme timing. Kokoro's timestamped export reports how long it spoke every
 * input token (a phoneme, a stress mark, a space or punctuation), so each sound's mouth shape lands exactly where the
 * sound is, instead of the text being spread over the loud stretches of the audio. Every English vowel, diphthong and
 * consonant the phonemiser writes (espeak IPA, plus Kokoro's one-letter diphthongs) maps to one of the 22 Microsoft
 * visemes; a diphthong shows both of its shapes. The audio's loudness only scales how far a vowel opens.
 * Output cues are [offsetMs, visemeId, weight], like lib/visemes.mjs.
 */

/** IPA phoneme -> MS22 viseme. */
export const PHONEME_VISEMES = {
  // Vowels.
  æ: 1,
  a: 1,
  ə: 1,
  ɐ: 1,
  ʌ: 1,
  ɑ: 2,
  ɒ: 3,
  ɔ: 3,
  ɛ: 4,
  e: 4,
  ɜ: 5,
  ɚ: 5,
  ɝ: 5,
  i: 6,
  ɪ: 6,
  ᵻ: 6,
  u: 7,
  ʊ: 7,
  o: 8,
  // Consonants.
  j: 6,
  w: 7,
  h: 12,
  ɹ: 13,
  r: 13,
  l: 14,
  s: 15,
  z: 15,
  ʃ: 16,
  ʒ: 16,
  ʧ: 16,
  ʤ: 16,
  θ: 17,
  ð: 17,
  f: 18,
  v: 18,
  t: 19,
  d: 19,
  n: 19,
  ɾ: 19,
  ʔ: 19,
  k: 20,
  g: 20,
  ɡ: 20,
  ŋ: 20,
  p: 21,
  b: 21,
  m: 21,
};

/** Two-phoneme diphthongs and Kokoro's one-letter ones: the shape at the start, then the shape it glides to. */
export const DIPHTHONGS = {
  eɪ: [4, 6],
  aɪ: [11, 6],
  ɔɪ: [10, 6],
  aʊ: [9, 7],
  əʊ: [8, 7],
  oʊ: [8, 7],
  eə: [4, 1],
  ɛə: [4, 1],
  ɪə: [6, 1],
  ʊə: [7, 1],
  A: [4, 6],
  I: [11, 6],
  Y: [10, 6],
  W: [9, 7],
  O: [8, 7],
  Q: [8, 7],
};

const VOWELS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
/** Lips shut, lower lip under the teeth, tongue between them: always shown in full. */
const DOMINANT = new Set([21, 18, 17]);
const STRESS = new Set(['ˈ', 'ˌ']);
const LENGTH = 'ː';
/** A space or punctuation shorter than this is a breath between words, not a pause: the mouth keeps going. */
const PAUSE_MS = 70;
/** The glide of a diphthong starts this far through it. */
const GLIDE_AT = 0.55;
/** Cue times are written at this resolution. */
const STEP_MS = 10;
/** A closure (or F, V, TH) is shown at least this long, enough for the mouth to reach it. */
const MIN_HOLD_MS = 60;

/**
 * @typedef {{ symbol: string, start: number, end: number }} Segment times in samples; symbol '' is a pause
 * @typedef {[number, number, number]} Cue
 */

/**
 * Phoneme segments from the model's tokens and their durations. Durations are in the model's frames; the frame size
 * is the waveform length over their sum. Stress marks give their time to the phoneme they stress, a length mark to the
 * phoneme it lengthens; spaces, punctuation and the padding are pauses.
 * @param {ArrayLike<number>} ids
 * @param {ArrayLike<number>} durations
 * @param {(id: number) => string | undefined} symbolOf
 * @param {number} samples waveform length
 * @returns {Segment[]}
 */
export const segmentsFromDurations = (ids, durations, symbolOf, samples) => {
  let total = 0;
  for (let i = 0; i < durations.length; i++) total += Math.max(0, Number(durations[i]) || 0);
  if (!(total > 0)) return [];
  const unit = samples / total;
  /** @type {Segment[]} */
  const out = [];
  let at = 0;
  let carry = null;
  for (let i = 0; i < ids.length; i++) {
    const length = Math.max(0, Number(durations[i]) || 0) * unit;
    const symbol = symbolOf(Number(ids[i])) ?? '';
    const start = at;
    at += length;
    if (STRESS.has(symbol)) {
      carry ??= start;
      continue;
    }
    if (symbol === LENGTH) {
      const last = out[out.length - 1];
      if (last) last.end = at;
      continue;
    }
    const spoken = symbol in PHONEME_VISEMES || symbol in DIPHTHONGS;
    out.push({ symbol: spoken ? symbol : '', start: carry ?? start, end: at });
    carry = null;
  }
  return out;
};

/**
 * Visemes over time: one per phoneme, two per diphthong, silence for real pauses (short gaps join the phoneme before).
 * @param {Segment[]} segments
 * @param {number} rate
 * @returns {{ viseme: number, start: number, end: number }[]}
 */
export const visemeSpans = (segments, rate) => {
  const spans = [];
  const pauseSamples = (PAUSE_MS / 1000) * rate;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.symbol) {
      const last = spans[spans.length - 1];
      if (seg.end - seg.start < pauseSamples && last) last.end = seg.end;
      else spans.push({ viseme: 0, start: seg.start, end: seg.end });
      continue;
    }
    const next = segments[i + 1];
    const pair = next?.symbol ? DIPHTHONGS[seg.symbol + next.symbol] : undefined;
    if (pair) {
      spans.push({ viseme: pair[0], start: seg.start, end: seg.end });
      spans.push({ viseme: pair[1], start: next.start, end: next.end, glide: true });
      i += 1;
      continue;
    }
    const single = DIPHTHONGS[seg.symbol];
    if (single) {
      const mid = seg.start + (seg.end - seg.start) * GLIDE_AT;
      spans.push({ viseme: single[0], start: seg.start, end: mid });
      spans.push({ viseme: single[1], start: mid, end: seg.end, glide: true });
      continue;
    }
    spans.push({ viseme: PHONEME_VISEMES[seg.symbol], start: seg.start, end: seg.end });
  }
  return spans;
};

/** Mean openness (0..1) of the analysis frames over [fromMs, toMs). */
const opennessOver = (frames, fromMs, toMs) => {
  let sum = 0;
  let count = 0;
  for (const frame of frames) {
    if (frame.atMs + 50 <= fromMs || frame.atMs >= toMs) continue;
    sum += frame.openness;
    count++;
  }
  return count ? sum / count : 0.5;
};

/**
 * @param {{ viseme: number, start: number, end: number, glide?: boolean }[]} spans in samples of the untrimmed audio
 * @param {{ rate: number, trimmed: number, leadInMs: number, durationMs: number, frames?: import('./audio.mjs').Frame[] }} at
 *   trimmed: samples cut from the front; leadInMs: the MP3's delay; frames: analysis of the trimmed audio
 * @returns {Cue[]}
 */
export const cuesFromSpans = (spans, { rate, trimmed, leadInMs, durationMs, frames = [] }) => {
  const toMs = (sample) => ((sample - trimmed) / rate) * 1000;
  /** @type {Cue[]} */
  const cues = [[0, 0, 0]];
  for (const span of spans) {
    const fromMs = toMs(span.start);
    const open = opennessOver(frames, fromMs, toMs(span.end));
    let weight;
    if (span.viseme === 0) weight = 0;
    else if (DOMINANT.has(span.viseme)) weight = 1;
    else if (VOWELS.has(span.viseme)) weight = (span.glide ? 0.7 : 0.62) + 0.38 * open;
    else weight = 0.8 + 0.2 * open;
    const last = cues[cues.length - 1];
    let atMs = Math.max(0, Math.round((fromMs + leadInMs) / STEP_MS) * STEP_MS);
    if (DOMINANT.has(span.viseme)) {
      // The voice times a closure by its release; the lips shut earlier, so a short one starts sooner and holds.
      const endMs = Math.round((toMs(span.end) + leadInMs) / STEP_MS) * STEP_MS;
      if (endMs - atMs < MIN_HOLD_MS) atMs = Math.max(last[0] + 2 * STEP_MS, Math.min(atMs, endMs - MIN_HOLD_MS));
    }
    const cue = [atMs, span.viseme, Math.round(Math.min(1, weight) * 100) / 100];
    if (last[1] === cue[1]) continue;
    // Two sounds on one step: the later one wins, unless the earlier one is a closure that must show.
    if (last[0] >= atMs) {
      if (DOMINANT.has(last[1])) cue[0] = last[0] + STEP_MS;
      else cues.pop();
    }
    if (cue[0] >= durationMs) break;
    if (cues[cues.length - 1]?.[1] !== cue[1]) cues.push(cue);
  }
  if (cues[cues.length - 1][1] !== 0) cues.push([durationMs, 0, 0]);
  return cues;
};
