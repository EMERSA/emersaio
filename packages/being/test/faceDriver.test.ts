/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Mesh } from 'three';
import {
  ARKIT_ATTACK_MS,
  ARKIT_RELEASE_MS,
  buildMorphMap,
  FaceDriver,
  hasArkitMorphs,
  morphNamesFor,
} from '../src/face/FaceDriver.ts';
import { ARKIT_BASE, ARKIT_COUNT, CHANNEL, CHANNEL_COUNT, type FaceSource } from '../src/face/source.ts';
import { ArkitStreamSource } from '../src/face/sources/ArkitStream.ts';
import { ARKIT_FRAME_LENGTH, arkit52, arkitIndex } from '../src/face/tables/arkit52.ts';
import { MOUTH_RECIPES, VISEME_DETAIL } from '../src/face/tables/mouthShapes.ts';

/**
 * The guide's Head morphs in the order the GLB carries them (tools/avatar): 22 visemes, then the 52 ARKit shapes in
 * MakeHuman's order, which is neither Apple's nor Convai's, so every mapping below has to go by name.
 */
const GUIDE_MORPHS = [
  ...Array.from({ length: 22 }, (_, i) => `viseme_${String(i).padStart(2, '0')}`),
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
] as const;

const dictionary = (names: readonly string[]): Record<string, number> =>
  Object.fromEntries(names.map((name, index) => [name, index]));

/** A head with the guide's morphs and no bones: the driver writes its influences and nothing else. */
const fakeHead = (names: readonly string[] = GUIDE_MORPHS) => {
  const influences = new Array<number>(names.length).fill(0);
  const mesh = { morphTargetInfluences: influences, morphTargetDictionary: dictionary(names) } as unknown as Mesh;
  return { mesh, influences, morph: (name: string): number => influences[names.indexOf(name)] ?? Number.NaN };
};

/** A source that writes fixed values to the channels it is given, every frame. */
const fixed = (values: ReadonlyMap<number, number>, priority = 10): FaceSource => ({
  name: 'fixed',
  priority,
  active: () => true,
  sample: (_now, frame, written) => {
    for (const [channel, value] of values) {
      frame[channel] = value;
      written[channel] = 1;
    }
  },
});

const arkitChannel = (name: string): number => ARKIT_BASE + arkit52.indexOf(name as (typeof arkit52)[number]);

const near = (actual: number | undefined, expected: number, tolerance: number, message: string): void => {
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
};

test('the ARKit block follows the visemes, the expressions and the bones, 52 channels long', () => {
  assert.equal(ARKIT_BASE, CHANNEL.eyesPitch + 1);
  assert.equal(ARKIT_COUNT, arkit52.length);
  assert.equal(CHANNEL_COUNT, 86);
  for (let index = 0; index < ARKIT_COUNT; index += 1) {
    assert.deepEqual(morphNamesFor(ARKIT_BASE + index), [arkit52[index]]);
  }
  assert.deepEqual(morphNamesFor(CHANNEL.smile), ['mouthSmileLeft', 'mouthSmileRight']);
  assert.deepEqual(morphNamesFor(CHANNEL.headYaw), [], 'bones drive no morph');
});

test('the morph map finds every ARKit shape by name, whatever order the asset keeps them in', () => {
  const map = buildMorphMap(dictionary(GUIDE_MORPHS));
  for (let index = 0; index < ARKIT_COUNT; index += 1) {
    const name = arkit52[index] ?? '';
    assert.deepEqual(map[ARKIT_BASE + index], [GUIDE_MORPHS.indexOf(name as (typeof GUIDE_MORPHS)[number])], name);
  }
  assert.deepEqual(map[3], [3], 'visemes map to viseme_03 and so on');
  assert.equal(hasArkitMorphs(map), true);
  // An asset with one shape missing cannot take the stream 1:1.
  assert.equal(hasArkitMorphs(buildMorphMap(dictionary(GUIDE_MORPHS.filter((name) => name !== 'cheekPuff')))), false);
  assert.equal(hasArkitMorphs(buildMorphMap({})), false);
});

test('the ARKit block rises 90 percent in 15 ms and falls 90 percent in 40, the rest in 40 and 110', () => {
  const { mesh, morph } = fakeHead();
  const driver = new FaceDriver({ mesh, bones: {} });
  const values = new Map<number, number>([
    [arkitChannel('cheekPuff'), 1],
    [CHANNEL.smile, 1],
  ]);
  driver.add(fixed(values));
  driver.update(0, ARKIT_ATTACK_MS / 1000);
  near(morph('cheekPuff'), 0.9, 1e-6, 'block attack');
  near(morph('mouthSmileLeft'), 1 - 10 ** (-ARKIT_ATTACK_MS / 40), 1e-6, 'expression attack is slower');
  for (let i = 0; i < 20; i += 1) driver.update(0, 0.05);
  values.set(arkitChannel('cheekPuff'), 0);
  driver.update(0, ARKIT_RELEASE_MS / 1000);
  near(morph('cheekPuff'), 0.1, 1e-3, 'block release');
});

test('the ARKit block is not a bone channel: it never goes below 0', () => {
  const { mesh, morph } = fakeHead();
  const driver = new FaceDriver({ mesh, bones: {} });
  driver.add(fixed(new Map([[arkitChannel('mouthLeft'), -1]])));
  for (let i = 0; i < 10; i += 1) driver.update(0, 0.05);
  assert.equal(morph('mouthLeft'), 0);
});

test('a morph the expressions and the ARKit block both drive takes the larger; the energy reads the ARKit jaw', () => {
  const { mesh, morph } = fakeHead();
  const driver = new FaceDriver({ mesh, bones: {} });
  const values = new Map<number, number>([
    [CHANNEL.jawOpen, 0.2],
    [arkitChannel('jawOpen'), 0.6],
    [CHANNEL.smile, 0.7],
    [arkitChannel('mouthSmileLeft'), 0.3],
    [arkitChannel('tongueOut'), 0.4],
    [5, 0.5],
  ]);
  driver.add(fixed(values));
  let now = 0;
  const step = (frames: number): void => {
    for (let i = 0; i < frames; i += 1) {
      now += 50;
      driver.update(now, 0.05);
    }
  };
  step(20);
  near(morph('jawOpen'), 0.6, 1e-6, 'the block wins on the jaw');
  near(morph('mouthSmileLeft'), 0.7, 1e-6, 'the expression wins on the smile');
  near(morph('mouthSmileRight'), 0.7, 1e-6, 'the expression drives both sides');
  near(morph('tongueOut'), 0.4, 1e-6, 'a shape only the block drives');
  near(morph('viseme_05'), 0.5 * VISEME_DETAIL, 1e-6, 'visemes keep their sculpted detail under the mouth recipes');
  near(driver.energy(), 0.9, 1e-6, 'energy is 1.5 x the larger jaw');
  // The block alone opens the mouth for the energy too.
  values.set(CHANNEL.jawOpen, 0);
  values.set(5, 0);
  step(40);
  near(morph('viseme_05'), 0, 1e-6, 'the viseme has gone');
  near(driver.energy(), 0.9, 1e-3, 'the ARKit jaw alone');
});

test('a direct ARKit stream puts every blendshape on its morph 1:1', () => {
  const { mesh, morph } = fakeHead();
  const driver = new FaceDriver({ mesh, bones: {} });
  const stream = new ArkitStreamSource({ direct: true });
  driver.add(stream);
  const frame61 = new Float32Array(ARKIT_FRAME_LENGTH);
  arkit52.forEach((name, index) => {
    frame61[arkitIndex(name)] = ((index * 37) % 50) / 50;
  });
  for (let t = 0; t <= 400; t += 16) {
    stream.push(frame61, t);
    driver.update(t, 0.016);
  }
  for (const name of arkit52) near(morph(name), frame61[arkitIndex(name)] ?? Number.NaN, 1e-4, name);
  for (let viseme = 0; viseme < 22; viseme += 1) {
    near(morph(`viseme_${String(viseme).padStart(2, '0')}`), 0, 1e-6, 'no viseme is approximated on top');
  }
});

test('every viseme has a mouth recipe of real ARKit shapes, each weight within 0..1', () => {
  assert.equal(MOUTH_RECIPES.length, 22);
  for (const recipe of MOUTH_RECIPES) {
    for (const [name, weight] of Object.entries(recipe)) {
      assert.ok((arkit52 as readonly string[]).includes(name), `${name} is an ARKit shape`);
      assert.ok(weight >= 0 && weight <= 1, `${name} ${weight}`);
    }
  }
});

test('a viseme shapes the lips through its recipe: p, b, m press them shut and o, u round them', () => {
  const { mesh, morph } = fakeHead();
  const driver = new FaceDriver({ mesh, bones: {} });
  const values = new Map<number, number>([[21, 1]]);
  driver.add(fixed(values));
  let now = 0;
  const step = (frames: number): void => {
    for (let i = 0; i < frames; i += 1) {
      now += 50;
      driver.update(now, 0.05);
    }
  };
  step(20);
  near(morph('mouthPressLeft'), MOUTH_RECIPES[21]?.mouthPressLeft ?? 0, 0.01, 'lips pressed');
  near(morph('jawOpen'), 0, 0.01, 'jaw shut');
  values.delete(21);
  values.set(7, 1);
  step(20);
  near(morph('mouthPucker'), MOUTH_RECIPES[7]?.mouthPucker ?? 0, 0.01, 'lips rounded');
  near(morph('mouthPressLeft'), 0, 0.01, 'the press has gone');
});
