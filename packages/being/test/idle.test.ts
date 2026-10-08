/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { IdleSource } from '../src/face/sources/Idle.ts';

/** A small linear congruential generator so the idle face is the same on every run. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

test('idle blinks both eyes within six seconds, breathes on the jaw and leaves the mouth alone', () => {
  const source = new IdleSource({ random: seeded(42) });
  assert.equal(source.priority, 0);
  assert.ok(source.active(0));
  let maxBlink = 0;
  let jawMax = 0;
  let jawMin = 1;
  let eyeMax = 0;
  for (let nowMs = 0; nowMs <= 7000; nowMs += 10) {
    const frame = createFrame();
    const written = new Uint8Array(CHANNEL_COUNT);
    source.sample(nowMs, frame, written);
    assert.equal(frame[CHANNEL.blinkLeft], frame[CHANNEL.blinkRight]);
    maxBlink = Math.max(maxBlink, frame[CHANNEL.blinkLeft] ?? 0);
    jawMax = Math.max(jawMax, frame[CHANNEL.jawOpen] ?? 0);
    jawMin = Math.min(jawMin, frame[CHANNEL.jawOpen] ?? 0);
    eyeMax = Math.max(eyeMax, Math.abs(frame[CHANNEL.eyesYaw] ?? 0), Math.abs(frame[CHANNEL.eyesPitch] ?? 0));
    assert.equal(written[CHANNEL.blinkLeft], 1);
    assert.equal(written[CHANNEL.jawOpen], 1);
    assert.equal(written[CHANNEL.browUp], 1);
    assert.equal(written[0], 0, 'viseme channels are not idle channels');
    assert.equal(written[CHANNEL.smile], 0);
    assert.equal(written[CHANNEL.headYaw], 0);
    assert.ok((frame[CHANNEL.browUp] ?? 0) >= 0 && (frame[CHANNEL.browUp] ?? 0) <= 0.08);
  }
  assert.ok(maxBlink > 0.95, `blinked fully (${maxBlink})`);
  assert.ok(jawMax <= 0.02 + 1e-6 && jawMin >= 0, 'breathing stays within 0.02');
  assert.ok(jawMax > 0.015, 'breathing actually moves');
  assert.ok(eyeMax <= 0.15 + 1e-6, 'eyes wander gently');
});

test('a blink closes in about 120 ms and reopens', () => {
  const source = new IdleSource({ random: () => 0, blinkMinMs: 1000, blinkMaxMs: 1000 });
  const read = (nowMs: number): number => {
    const frame = createFrame();
    source.sample(nowMs, frame, new Uint8Array(CHANNEL_COUNT));
    return frame[CHANNEL.blinkLeft] ?? 0;
  };
  assert.equal(read(0), 0);
  assert.equal(read(999), 0);
  assert.ok(read(1060) > 0.3 && read(1060) < 0.7, 'half closed');
  assert.equal(read(1120), 1);
  assert.equal(read(1400), 0);
});
