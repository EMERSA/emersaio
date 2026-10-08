/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import {
  normalizeCues,
  TIMELINE_TAIL_MS,
  VISEME_RAMP_MS,
  VisemeTimelineSource,
} from '../src/face/sources/VisemeTimeline.ts';

const sampleAt = (source: VisemeTimelineSource, nowMs: number) => {
  const frame = createFrame();
  const written = new Uint8Array(CHANNEL_COUNT);
  source.sample(nowMs, frame, written);
  return { frame, written };
};

const near = (actual: number | undefined, expected: number, message?: string): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.02, `${message ?? ''} ${actual} vs ${expected}`);
};

test('normalizeCues sorts, clamps ids and defaults the weight', () => {
  assert.deepEqual(
    normalizeCues([
      [10, 30],
      [5, -1, 2],
    ]),
    [
      { at: 5, viseme: 0, weight: 1 },
      { at: 10, viseme: 21, weight: 1 },
    ],
  );
});

test('a cue ramps in while the previous one fades, and silence closes the mouth', () => {
  let t = 0;
  const source = new VisemeTimelineSource(
    [
      [300, 0],
      [0, 21],
      [100, 1],
    ],
    () => t,
    400,
  );
  assert.equal(source.priority, 10);

  t = VISEME_RAMP_MS;
  let { frame, written } = sampleAt(source, t);
  near(frame[21], 1, 'p/b/m at full ramp');
  near(frame[CHANNEL.jawOpen], 0, 'closed lips open no jaw');
  for (let channel = 0; channel < 22; channel += 1) assert.equal(written[channel], 1);
  assert.equal(written[CHANNEL.jawOpen], 1);
  assert.equal(written[CHANNEL.blinkLeft], 0);

  t = 100 + VISEME_RAMP_MS / 2;
  ({ frame } = sampleAt(source, t));
  near(frame[1], 0.5, 'next viseme halfway');
  near(frame[21], 0.5, 'previous viseme halfway');

  t = 100 + VISEME_RAMP_MS;
  ({ frame } = sampleAt(source, t));
  near(frame[1], 1, 'ae at full');
  near(frame[21], 0, 'p faded');
  near(frame[CHANNEL.jawOpen], 0.6, 'jaw follows the openness table');

  t = 300 + VISEME_RAMP_MS;
  ({ frame } = sampleAt(source, t));
  for (let channel = 0; channel < 22; channel += 1) near(frame[channel], 0, `silence ${channel}`);
  near(frame[CHANNEL.jawOpen], 0);
});

test('the source is active before the start, through the clip, and for the tail after it', () => {
  let t = -50;
  const source = new VisemeTimelineSource([[0, 2]], () => t, 200);
  assert.ok(source.active(0));
  const { frame } = sampleAt(source, 0);
  near(frame[2], 0, 'closed before the start');
  t = 200 + TIMELINE_TAIL_MS;
  assert.ok(source.active(0));
  t = 200 + TIMELINE_TAIL_MS + 1;
  assert.ok(!source.active(0));
  t = 100;
  source.stop();
  assert.ok(!source.active(0));
});

test('a timeline that does not end in silence closes at its duration', () => {
  let t = 100;
  const source = new VisemeTimelineSource([[0, 2]], () => t, 200);
  near(sampleAt(source, 0).frame[2], 1, 'held open');
  t = 200 + VISEME_RAMP_MS / 2;
  near(sampleAt(source, 0).frame[2], 0.5, 'closing');
  t = 200 + VISEME_RAMP_MS;
  near(sampleAt(source, 0).frame[2], 0, 'closed');
});
