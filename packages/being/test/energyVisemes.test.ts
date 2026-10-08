/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { type AnalyserLike, ENERGY_VISEMES, EnergyVisemesSource } from '../src/face/sources/EnergyVisemes.ts';

/** A fake analyser: a flat waveform at `rms` and all spectral energy in one bin. */
const fakeAnalyser = (): AnalyserLike & { rms: number; bin: number } => ({
  rms: 0,
  bin: 0,
  fftSize: 256,
  frequencyBinCount: 128,
  context: { sampleRate: 48_000 },
  getByteFrequencyData(array) {
    array.fill(0);
    array[this.bin] = 255;
  },
  getFloatTimeDomainData(array) {
    array.fill(this.rms);
  },
});

const sample = (source: EnergyVisemesSource, nowMs: number) => {
  const frame = createFrame();
  const written = new Uint8Array(CHANNEL_COUNT);
  source.sample(nowMs, frame, written);
  return { frame, written };
};

test('silence keeps the mouth closed', () => {
  const analyser = fakeAnalyser();
  const source = new EnergyVisemesSource(analyser);
  const { frame, written } = sample(source, 0);
  for (let channel = 0; channel < 22; channel += 1) {
    assert.equal(frame[channel], 0);
    assert.equal(written[channel], 1);
  }
  assert.equal(frame[CHANNEL.jawOpen], 0);
  assert.equal(written[CHANNEL.jawOpen], 1);
  assert.equal(source.level(), 0);
});

test('loudness opens the mouth and the centroid picks the shape', () => {
  const analyser = fakeAnalyser();
  const source = new EnergyVisemesSource(analyser);
  analyser.rms = 0.27;
  analyser.bin = 2;
  let { frame } = sample(source, 0);
  assert.ok((frame[ENERGY_VISEMES.rounded] ?? 0) > 0.9, 'low centroid reads as oo');
  assert.equal(frame[ENERGY_VISEMES.open], 0);
  assert.ok((frame[CHANNEL.jawOpen] ?? 0) > 0.1);

  analyser.bin = 8;
  for (let nowMs = 16; nowMs <= 800; nowMs += 16) ({ frame } = sample(source, nowMs));
  assert.ok((frame[ENERGY_VISEMES.open] ?? 0) > 0.9, 'mid centroid settles on aa');
  assert.ok((frame[ENERGY_VISEMES.rounded] ?? 0) < 0.05, 'oo faded out');

  analyser.bin = 20;
  for (let nowMs = 816; nowMs <= 1600; nowMs += 16) ({ frame } = sample(source, nowMs));
  assert.ok((frame[ENERGY_VISEMES.spread] ?? 0) > 0.9, 'high centroid reads as eh');

  analyser.rms = 0;
  for (let nowMs = 1616; nowMs <= 2400; nowMs += 16) ({ frame } = sample(source, nowMs));
  assert.ok((frame[ENERGY_VISEMES.spread] ?? 0) < 0.05, 'silence closes again');
  source.stop();
  assert.ok(!source.active(0));
});
