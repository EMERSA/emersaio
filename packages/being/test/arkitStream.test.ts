/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, CHANNEL_COUNT, createFrame } from '../src/face/source.ts';
import { ArkitStreamSource } from '../src/face/sources/ArkitStream.ts';
import { ARKIT_FRAME_LENGTH, arkitIndex } from '../src/face/tables/arkit52.ts';

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
