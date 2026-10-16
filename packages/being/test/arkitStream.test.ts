/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARKIT_BASE, CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { ArkitStreamSource } from '../src/face/sources/ArkitStream.ts';
import { ARKIT_FRAME_LENGTH, arkit52, arkitIndex } from '../src/face/tables/arkit52.ts';

const DEGREES = Math.PI / 180;

const sample = (source: ArkitStreamSource, nowMs: number) => {
  const frame = createFrame();
  const written = new Uint8Array(CHANNEL_COUNT);
  source.sample(nowMs, frame, written);
  return { frame, written };
};

const near = (actual: number | undefined, expected: number, message: string): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.01, `${message}: ${actual} vs ${expected}`);
};

test('frames map jaw, blinks, brows, smile and head rotation, then go stale after 200 ms', () => {
  const source = new ArkitStreamSource();
  assert.equal(source.priority, 20);
  assert.ok(!source.active(0), 'nothing pushed yet');
  const frame61 = new Float32Array(ARKIT_FRAME_LENGTH);
  frame61[arkitIndex('jawOpen')] = 0.8;
  frame61[arkitIndex('eyeBlinkLeft')] = 1;
  frame61[arkitIndex('browInnerUp')] = 0.5;
  frame61[arkitIndex('mouthSmileLeft')] = 0.4;
  frame61[arkitIndex('mouthSmileRight')] = 0.6;
  frame61[arkitIndex('headYaw')] = 25 * DEGREES;
  frame61[arkitIndex('headPitch')] = -7.5 * DEGREES;
  source.push(frame61, 1000);
  assert.ok(source.active(1100));
  assert.ok(!source.active(1200));

  const { frame, written } = sample(source, 1100);
  near(frame[CHANNEL.jawOpen], 0.8, 'jaw');
  near(frame[1], 0.8, 'open jaw reads as the aa viseme');
  near(frame[CHANNEL.blinkLeft], 1, 'left blink');
  near(frame[CHANNEL.blinkRight], 0, 'right eye open');
  near(frame[CHANNEL.browUp], 0.5, 'brow');
  near(frame[CHANNEL.smile], 0.5, 'smile averages both sides');
  near(frame[CHANNEL.headYaw], 1, 'yaw at the clamp');
  near(frame[CHANNEL.headPitch], -0.5, 'pitch half way down');
  for (const channel of [0, 21, CHANNEL.jawOpen, CHANNEL.headRoll, CHANNEL.eyesYaw]) assert.equal(written[channel], 1);
});

test('pucker reads as the rounded viseme and a custom order maps by name', () => {
  const source = new ArkitStreamSource({ order: ['mouthPucker', 'jawOpen', 'headYaw'], rotationUnit: 'degrees' });
  source.push([1, 0.2, -12.5], 0);
  const { frame } = sample(source, 10);
  near(frame[7], 1, 'oo');
  near(frame[1], 0, 'pucker cancels the open vowel');
  near(frame[CHANNEL.headYaw], -0.5, 'degrees converted');
});

test('eyes follow the look blendshapes when no rotation slots are set', () => {
  const source = new ArkitStreamSource();
  const frame61 = new Float32Array(ARKIT_FRAME_LENGTH);
  frame61[arkitIndex('eyeLookInLeft')] = 1;
  frame61[arkitIndex('eyeLookOutRight')] = 1;
  frame61[arkitIndex('eyeLookUpLeft')] = 0.5;
  frame61[arkitIndex('eyeLookUpRight')] = 0.5;
  source.push(frame61, 0);
  const { frame } = sample(source, 0);
  near(frame[CHANNEL.eyesYaw], 1, 'both eyes looking right');
  near(frame[CHANNEL.eyesPitch], 0.5, 'looking up');
  source.stop();
  assert.ok(!source.active(0));
});

test('direct mode writes all 52 blendshapes 1:1 into the ARKit block and keeps the rotations on the bones', () => {
  const source = new ArkitStreamSource({ direct: true });
  assert.equal(source.isDirect(), true);
  const frame61 = new Float32Array(ARKIT_FRAME_LENGTH);
  arkit52.forEach((name, index) => {
    frame61[arkitIndex(name)] = index / 51;
  });
  frame61[arkitIndex('tongueOut')] = 1.4;
  frame61[arkitIndex('cheekPuff')] = -0.2;
  frame61[arkitIndex('headYaw')] = 25 * DEGREES;
  frame61[arkitIndex('headRoll')] = -5 * DEGREES;
  frame61[arkitIndex('leftEyePitch')] = 20 * DEGREES;
  frame61[arkitIndex('rightEyePitch')] = 20 * DEGREES;
  source.push(frame61, 0);
  const { frame, written } = sample(source, 10);
  arkit52.forEach((name, index) => {
    assert.equal(written[ARKIT_BASE + index], 1, `${name} is written`);
    if (name === 'tongueOut') near(frame[ARKIT_BASE + index], 1, 'clamped to 1');
    else if (name === 'cheekPuff') near(frame[ARKIT_BASE + index], 0, 'clamped to 0');
    else near(frame[ARKIT_BASE + index], index / 51, name);
  });
  // Nothing approximated on top: the visemes and the moods are held at rest, and owned, so no lower source adds.
  for (let viseme = 0; viseme < 22; viseme += 1) {
    assert.equal(written[viseme], 1);
    assert.equal(frame[viseme], 0);
  }
  for (const channel of [CHANNEL.jawOpen, CHANNEL.blinkLeft, CHANNEL.browUp, CHANNEL.smile, CHANNEL.frown]) {
    assert.equal(written[channel], 1);
    assert.equal(frame[channel], 0);
  }
  near(frame[CHANNEL.headYaw], 1, 'yaw still on the head bone');
  near(frame[CHANNEL.headRoll], -0.5, 'roll still on the head bone');
  near(frame[CHANNEL.eyesPitch], 1, 'eye pitch still on the eye bones');
});

test('direct mode maps a custom layout by name, a missing shape reads 0, and setDirect switches modes', () => {
  const source = new ArkitStreamSource({ order: ['tongueOut', 'jawOpen', 'headPitch'] });
  assert.equal(source.isDirect(), false, 'approximate by default');
  source.push([0.7, 0.5, 0], 0);
  const before = sample(source, 1);
  assert.equal(before.written[ARKIT_BASE], 0, 'no block without direct mode');
  near(before.frame[CHANNEL.jawOpen], 0.5, 'the jaw on the expression channel');
  source.setDirect(true);
  const { frame } = sample(source, 1);
  near(frame[ARKIT_BASE + arkit52.indexOf('tongueOut')], 0.7, 'tongue by name');
  near(frame[ARKIT_BASE + arkit52.indexOf('jawOpen')], 0.5, 'jaw by name');
  near(frame[ARKIT_BASE + arkit52.indexOf('mouthPucker')], 0, 'a shape the layout lacks');
  near(frame[CHANNEL.jawOpen], 0, 'the expression jaw at rest');
});
