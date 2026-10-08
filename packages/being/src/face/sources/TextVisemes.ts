import type { FaceSource } from '../source.ts';
import { graphemeToMs22, isVowelViseme, splitGraphemes } from '../tables/grapheme2ms22.ts';
import { type NormalizedCue, sampleCues, TIMELINE_TAIL_MS } from './VisemeTimeline.ts';

/** The caption typewriter runs at this rate, so a text mouth timed the same way stays in step with it. */
export const TEXT_CHARS_PER_SECOND = 14;

/** Relative durations: vowels carry a syllable, consonants are quick, punctuation is a breath. */
const VOWEL_UNITS = 1.6;
const CONSONANT_UNITS = 1;
const SPACE_UNITS = 0.5;
const COMMA_UNITS = 1.5;
const STOP_UNITS = 3;

const COMMA_LIKE = /[,;:]/;
const STOP_LIKE = /[.!?]/;
const WORD_CHAR = /[\p{L}\p{M}']/u;

interface Unit {
  readonly viseme: number;
  readonly units: number;
}

const unitsOf = (text: string): Unit[] => {
  const out: Unit[] = [];
  let word = '';
  const flushWord = (): void => {
    if (word === '') return;
    for (const grapheme of splitGraphemes(word)) {
      const viseme = graphemeToMs22(grapheme);
      out.push({ viseme, units: isVowelViseme(viseme) ? VOWEL_UNITS : CONSONANT_UNITS });
    }
    word = '';
  };
  for (const char of text) {
    if (WORD_CHAR.test(char)) {
      word += char;
      continue;
    }
    flushWord();
    if (STOP_LIKE.test(char)) out.push({ viseme: 0, units: STOP_UNITS });
    else if (COMMA_LIKE.test(char)) out.push({ viseme: 0, units: COMMA_UNITS });
    else if (/\s/.test(char)) out.push({ viseme: 0, units: SPACE_UNITS });
  }
  flushWord();
  return out;
};

/** How long the typewriter will take for this text; the mouth should last exactly as long. */
export const estimateDurationMs = (text: string, charsPerSecond = TEXT_CHARS_PER_SECOND): number =>
  Math.max(0, Math.round((text.length / charsPerSecond) * 1000));

/**
 * Turn text into a viseme timeline spread over durationMs. Runs of the same viseme merge into one cue and the
 * timeline always ends closed, so a line never finishes with the mouth hanging open.
 */
export const textToCues = (text: string, durationMs: number): NormalizedCue[] => {
  const units = unitsOf(text);
  const total = units.reduce((sum, unit) => sum + unit.units, 0);
  const cues: NormalizedCue[] = [];
  if (total > 0 && durationMs > 0) {
    const scale = durationMs / total;
    let elapsed = 0;
    for (const unit of units) {
      const last = cues[cues.length - 1];
      if (last === undefined || last.viseme !== unit.viseme) {
        cues.push({ at: Math.round(elapsed * scale), viseme: unit.viseme, weight: 1 });
      }
      elapsed += unit.units;
    }
  }
  const last = cues[cues.length - 1];
  if (last === undefined || last.viseme !== 0) cues.push({ at: Math.max(0, durationMs), viseme: 0, weight: 1 });
  return cues;
};

/**
 * The mouth for text with no audio: graphemes mapped to visemes and spread over the caption time. Priority 10,
 * the same as a clip timeline, because the two never run together.
 */
export class TextVisemesSource implements FaceSource {
  readonly name = 'text-visemes';
  readonly priority = 10;
  private readonly cues: readonly NormalizedCue[];
  private readonly durationMs: number;
  private readonly startedAt: number;
  private stopped = false;

  /**
   * @param text the line being captioned.
   * @param durationMs how long the caption takes (see estimateDurationMs).
   * @param startedAt the driver clock value (performance.now) at which the line began.
   */
  constructor(text: string, durationMs: number, startedAt: number) {
    this.durationMs = Math.max(0, durationMs);
    this.startedAt = startedAt;
    this.cues = textToCues(text, this.durationMs);
  }

  active(nowMs: number): boolean {
    return !this.stopped && nowMs - this.startedAt <= this.durationMs + TIMELINE_TAIL_MS;
  }

  sample(nowMs: number, frame: Float32Array, written: Uint8Array): void {
    sampleCues(this.cues, nowMs - this.startedAt, this.durationMs, frame, written);
  }

  stop(): void {
    this.stopped = true;
  }
}
