/**
 * The phoneme-timed viseme timeline (lib/phonemes.mjs): token durations to segments, segments to visemes, visemes to
 * cues, and the baked tour timelines themselves. Runs with "node --test tools/**\/*.test.ts".
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cuesFromSpans, DIPHTHONGS, PHONEME_VISEMES, segmentsFromDurations, visemeSpans } from './phonemes.mjs';

const RATE = 24_000;
/** One duration unit as 600 samples (25 ms). */
const UNIT = 600;

/** Tokens as symbols with durations in units; '$' pads, ' ' spaces. */
function speak(tokens: [string, number][]) {
  const symbols = tokens.map(([symbol]) => symbol);
  const ids = symbols.map((_, i) => i);
  const durations = tokens.map(([, units]) => units);
  const samples = durations.reduce((a, b) => a + b, 0) * UNIT;
  return segmentsFromDurations(ids, durations, (id: number) => symbols[id], samples);
}

test('segments: stress gives its time to the next phoneme, length extends the previous', () => {
  const segments = speak([
    ['$', 2],
    ['m', 2],
    ['ˈ', 1],
    ['ɑ', 3],
    ['ː', 2],
    [' ', 1],
    ['$', 2],
  ]);
  assert.deepEqual(
    segments.map((s: { symbol: string; start: number; end: number }) => [s.symbol, s.start / UNIT, s.end / UNIT]),
    [
      ['', 0, 2],
      ['m', 2, 4],
      ['ɑ', 4, 10],
      ['', 10, 11],
      ['', 11, 13],
    ],
  );
});

test('segments: the frame size comes from the waveform, so they span it exactly', () => {
  const segments = segmentsFromDurations([0, 1, 2], [1.5, 2.25, 0.25], (id: number) => ['$', 'p', '$'][id], 9600);
  assert.equal(segments[0].start, 0);
  assert.equal(segments[segments.length - 1].end, 9600);
});

test('spans: diphthongs show both shapes, short gaps join the sound before, long ones close the mouth', () => {
  const spans = visemeSpans(
    speak([
      ['$', 4],
      ['h', 2],
      ['ə', 2],
      ['ʊ', 3],
      [' ', 1],
      ['a', 2],
      ['ɪ', 2],
      ['.', 6],
      ['I', 4],
      ['$', 4],
    ]),
    RATE,
  );
  assert.deepEqual(
    spans.map((s: { viseme: number }) => s.viseme),
    [0, 12, 8, 7, 11, 6, 0, 11, 6, 0],
  );
});

test('every phoneme and diphthong maps to a viseme 0-21', () => {
  for (const viseme of Object.values(PHONEME_VISEMES))
    assert.ok(Number.isInteger(viseme) && viseme >= 0 && viseme <= 21);
  for (const pair of Object.values(DIPHTHONGS))
    for (const viseme of pair) assert.ok(Number.isInteger(viseme) && viseme > 0 && viseme <= 21);
  for (const symbol of 'pbm') assert.equal(PHONEME_VISEMES[symbol], 21);
  for (const symbol of 'fv') assert.equal(PHONEME_VISEMES[symbol], 18);
  for (const symbol of 'θð') assert.equal(PHONEME_VISEMES[symbol], 17);
});

test('cues: closures at full weight and held long enough to show; times shifted by trim and lead-in', () => {
  const spans = visemeSpans(
    speak([
      ['$', 8],
      ['ə', 4],
      ['b', 1],
      ['ˈ', 0],
      ['i', 4],
      ['$', 8],
    ]),
    RATE,
  );
  const trimmed = 4 * UNIT;
  const cues = cuesFromSpans(spans, { rate: RATE, trimmed, leadInMs: 46, durationMs: 800 });
  const closure = cues.findIndex(([, viseme]: number[]) => viseme === 21);
  assert.ok(closure > 0);
  assert.equal(cues[closure][2], 1);
  // The b is 25 ms in the audio; its cue starts early enough to hold 60 ms before the vowel.
  assert.ok(cues[closure + 1][0] - cues[closure][0] >= 60);
  // The schwa starts 4 units (100 ms) after the trim point, plus the 46 ms lead-in, on a 10 ms step.
  assert.deepEqual(cues[1].slice(0, 2), [150, 1]);
  // The closing pad is silence: the timeline ends with the mouth at rest.
  assert.equal(cues[cues.length - 1][1], 0);
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i][0] > cues[i - 1][0]);
});

test('the baked tour: phoneme-timed cues inside each clip, and every written p, b, m closes the lips', () => {
  const dir = fileURLToPath(new URL('../../../apps/web/src/assets/tour/', import.meta.url));
  const texts = fileURLToPath(new URL('../../../apps/web/src/content/tour/', import.meta.url));
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const { durationMs, visemes } = JSON.parse(readFileSync(dir + file, 'utf8'));
    assert.ok(visemes.length > 40, `${file}: ${visemes.length} cues`);
    for (const [at, viseme, weight] of visemes) {
      assert.ok(at >= 0 && at <= durationMs, `${file}: cue at ${at}`);
      assert.ok(viseme >= 0 && viseme <= 21 && weight >= 0 && weight <= 1);
    }
    const yaml = readdirSync(texts).find((name) =>
      readFileSync(texts + name, 'utf8').includes(`id: ${file.slice(0, -5)}`),
    );
    assert.ok(yaml, `${file}: no tour text`);
    const text = (readFileSync(texts + yaml, 'utf8').match(/text:\s*"([^"]*)"/)?.[1] ?? '').toLowerCase();
    // Bilabials in the spelling (doubled letters and silent b after m are one closure or none).
    const written =
      text
        .replace(/mb\b/g, 'm')
        .replace(/([pbm])\1/g, '$1')
        .match(/[pbm]/g)?.length ?? 0;
    const closures = visemes.filter(([, viseme]: number[]) => viseme === 21).length;
    assert.ok(closures >= written * 0.8, `${file}: ${closures} closures for ${written} written p, b, m`);
  }
});
