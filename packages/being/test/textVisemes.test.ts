/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { estimateDurationMs, TextVisemesSource, textToCues } from '../src/face/sources/TextVisemes.ts';

test('text becomes a timeline inside the duration that ends closed', () => {
  const cues = textToCues('Hello, world.', 1000);
  assert.ok(cues.length > 3);
  assert.equal(cues[0]?.at, 0);
  assert.notEqual(cues[0]?.viseme, 0);
  // The last unit is the full stop, so the mouth closes at the start of that pause and stays closed.
  assert.equal(cues[cues.length - 1]?.viseme, 0);
  assert.ok((cues[cues.length - 1]?.at ?? 0) <= 1000);
  for (let index = 1; index < cues.length; index += 1) {
    const previous = cues[index - 1];
    const cue = cues[index];
    assert.ok(previous !== undefined && cue !== undefined && cue.at >= previous.at && cue.at <= 1000);
  }
  const pauses = cues.filter((cue) => cue.viseme === 0);
  assert.ok(pauses.length >= 2, 'the comma and the full stop pause');
});

test('vowels take longer than consonants', () => {
  const cues = textToCues('ta', 1000);
  assert.equal(cues.length, 3);
  const t = cues[0];
  const a = cues[1];
  const end = cues[2];
  assert.ok(t !== undefined && a !== undefined && end !== undefined);
  assert.ok(end.at - a.at > a.at - t.at);
});

test('empty text is a single closing cue', () => {
  assert.deepEqual(textToCues('', 500), [{ at: 500, viseme: 0, weight: 1 }]);
});

test('estimateDurationMs follows the typewriter rate', () => {
  assert.equal(estimateDurationMs('x'.repeat(14)), 1000);
  assert.equal(estimateDurationMs(''), 0);
});

test('the source runs from startedAt for the duration plus the tail', () => {
  const source = new TextVisemesSource('Hello world', 1000, 5000);
  assert.ok(source.active(4000), 'waiting for the start is still active');
  assert.ok(source.active(6150));
  assert.ok(!source.active(6151));

  const before = createFrame();
  source.sample(4500, before, new Uint8Array(CHANNEL_COUNT));
  assert.equal(
    before.reduce((sum, value) => sum + value, 0),
    0,
  );

  let open = 0;
  for (let nowMs = 5000; nowMs <= 6000; nowMs += 50) {
    const frame = createFrame();
    const written = new Uint8Array(CHANNEL_COUNT);
    source.sample(nowMs, frame, written);
    assert.equal(written[CHANNEL.jawOpen], 1);
    open = Math.max(open, frame[CHANNEL.jawOpen] ?? 0);
  }
  assert.ok(open > 0.1, 'the mouth opened while speaking');
});
