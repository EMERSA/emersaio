#!/usr/bin/env node
/**
 * Bake the scripted tour: one MP3 and one viseme timeline per stop in apps/web/src/content/tour/*.yaml.
 *
 *   node tools/avatar/bake-tour.mjs [--only <id>] [--captions-only] [--voice bf_emma] [--out apps/web/src/assets/tour]
 *
 * Voice: Kokoro-82M (q8, CPU) with the British female voice bf_emma, falling back to af_heart. Audio is
 * trimmed, peak-normalised and encoded as mono MP3 at 48 kbps (40, then 32, when a clip would exceed 90 KB).
 * Timelines: <id>.json = { durationMs, visemes: [[offsetMs, visemeId, weight], ...] } at 50 ms resolution,
 * derived from the audio's envelope and spectrum aligned with the text. With --captions-only (or when the
 * model cannot be loaded) only the JSON is written, timed from the text alone, so the site runs with captions.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { analyse, normalise, trimSilence } from './lib/audio.mjs';
import { kb, parseArgs } from './lib/io.mjs';
import { encodeMp3 } from './lib/mp3.mjs';
import { textOnlyTimeline } from './lib/text-visemes.mjs';
import { loadVoice } from './lib/tts.mjs';
import { timelineFromAudio } from './lib/visemes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLIP_BUDGET = 90 * 1024;
const BITRATES = [48, 40, 32];
const MAX_WORDS = 40;
// LAME puts 576 samples of encoder delay plus 529 of decoder delay in front of the audio, and lamejs writes no
// Xing/Info tag that would let a browser trim them, so decoded playback starts 1105 samples (46 ms at 24 kHz)
// later than the PCM the cues were measured on. Shifting the cues keeps the mouth on the sound.
const MP3_LEAD_IN_SAMPLES = 1105;

const args = parseArgs(process.argv.slice(2));
const tourDir = resolve(ROOT, args.in ?? 'apps/web/src/content/tour');
const outDir = resolve(ROOT, args.out ?? 'apps/web/src/assets/tour');
const cacheDir = resolve(HERE, 'cache');
const voiceName = typeof args.voice === 'string' ? args.voice : 'bf_emma';
const only = typeof args.only === 'string' ? args.only : null;

/** @returns {{ id: string, order: number, text: string }[]} */
const readStops = () => {
  const stops = [];
  for (const file of readdirSync(tourDir)
    .filter((name) => name.endsWith('.yaml'))
    .sort()) {
    const stop = parse(readFileSync(join(tourDir, file), 'utf8'));
    if (typeof stop?.id !== 'string' || typeof stop?.text !== 'string') throw new Error(`${file}: needs id and text`);
    const words = stop.text.trim().split(/\s+/).length;
    if (words > MAX_WORDS)
      console.warn(`  warning: ${stop.id} has ${words} words, the tour contract allows ${MAX_WORDS}`);
    stops.push({ id: stop.id, order: Number(stop.order ?? stops.length + 1), text: stop.text.trim() });
  }
  return stops.sort((a, b) => a.order - b.order);
};

const writeJson = (path, data) => writeFileSync(path, `${JSON.stringify(data)}\n`);

const bakeStop = async (stop, voice) => {
  const { pcm: rawPcm, rate } = await voice.synthesise(stop.text);
  const pcm = normalise(trimSilence(rawPcm, rate));
  const leadInMs = Math.round((MP3_LEAD_IN_SAMPLES / rate) * 1000);
  const pcmMs = Math.round((pcm.length / rate) * 1000);
  const durationMs = pcmMs + leadInMs;
  const frames = analyse(pcm, rate);
  const visemes = timelineFromAudio(frames, stop.text, pcmMs).map(([offsetMs, viseme, weight]) => [
    offsetMs === 0 ? 0 : offsetMs + leadInMs,
    viseme,
    weight,
  ]);
  let mp3 = null;
  let kbps = 0;
  for (const bitrate of BITRATES) {
    kbps = bitrate;
    mp3 = encodeMp3(pcm, rate, bitrate);
    if (mp3.byteLength <= CLIP_BUDGET) break;
  }
  if (!mp3 || mp3.byteLength > CLIP_BUDGET) {
    throw new Error(
      `${stop.id}: ${kb(mp3?.byteLength ?? 0)} at ${kbps} kbps still exceeds the ${kb(CLIP_BUDGET)} clip budget; shorten the line`,
    );
  }
  writeFileSync(join(outDir, `${stop.id}.mp3`), mp3);
  writeJson(join(outDir, `${stop.id}.json`), { durationMs, visemes });
  console.log(
    `${stop.id}: ${(durationMs / 1000).toFixed(2)} s, ${kb(mp3.byteLength)} at ${kbps} kbps, ${visemes.length} cues`,
  );
};

const bakeCaptionsOnly = (stop) => {
  const timeline = textOnlyTimeline(stop.text);
  writeJson(join(outDir, `${stop.id}.json`), timeline);
  console.log(
    `${stop.id}: captions only, ${(timeline.durationMs / 1000).toFixed(2)} s from text, ${timeline.visemes.length} cues`,
  );
};

const main = async () => {
  const stops = readStops().filter((stop) => !only || stop.id === only);
  if (!stops.length) throw new Error(only ? `no stop with id ${only}` : `no stops in ${tourDir}`);
  mkdirSync(outDir, { recursive: true });
  let voice = null;
  if (args['captions-only'] !== true) {
    try {
      voice = await loadVoice({ cacheDir, voice: voiceName, fallbackVoice: 'af_heart' });
      console.log(`tts: voice ${voice.voice}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      console.error('tts: falling back to captions-only timelines (no mp3)');
    }
  }
  let total = 0;
  for (const stop of stops) {
    if (voice) {
      await bakeStop(stop, voice);
      total += readFileSync(join(outDir, `${stop.id}.mp3`)).byteLength;
    } else {
      bakeCaptionsOnly(stop);
    }
  }
  if (voice) console.log(`baked ${stops.length} stops, ${kb(total)} of audio in total`);
  if (!voice) process.exitCode = args['captions-only'] === true ? 0 : 2;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
