/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ARKIT_FRAME_LENGTH, ARKIT_ORDER_61, arkit52, arkitIndex } from '../src/face/tables/arkit52.ts';
import { azure2ms22, azureToMs22 } from '../src/face/tables/azure2ms22.ts';
import { grapheme2ms22, graphemeToMs22, splitGraphemes } from '../src/face/tables/grapheme2ms22.ts';
import { clampViseme, jawOpenOf, MS22_COUNT, ms22 } from '../src/face/tables/ms22.ts';
import { OCULUS_VISEMES, oculus2ms22, oculusToMs22 } from '../src/face/tables/oculus2ms22.ts';

test('ms22 lists the 22 canonical visemes with openness in range', () => {
  assert.equal(MS22_COUNT, 22);
  ms22.forEach((viseme, index) => {
    assert.equal(viseme.id, index);
    assert.ok(viseme.name.length > 0 && viseme.description.length > 0);
    assert.ok(viseme.jawOpen >= 0 && viseme.jawOpen <= 1);
  });
  assert.equal(jawOpenOf(0), 0);
  assert.equal(jawOpenOf(21), 0);
  assert.equal(jawOpenOf(99), 0);
  assert.equal(clampViseme(-3), 0);
  assert.equal(clampViseme(40), 21);
  assert.equal(clampViseme(Number.NaN), 0);
  assert.equal(clampViseme(7.9), 7);
});

test('azure2ms22 is the identity', () => {
  assert.deepEqual([...azure2ms22], [...Array(22).keys()]);
  assert.equal(azureToMs22(7), 7);
  assert.equal(azureToMs22(50), 21);
});

test('oculus2ms22 maps every Oculus viseme into range', () => {
  assert.equal(OCULUS_VISEMES.length, 15);
  for (const name of OCULUS_VISEMES) {
    const id = oculus2ms22[name];
    assert.ok(id >= 0 && id < 22, name);
  }
  assert.equal(oculusToMs22('PP'), 21);
  assert.equal(oculusToMs22('sil'), 0);
  assert.equal(oculusToMs22(10), 1);
  assert.equal(oculusToMs22('nope'), 0);
});

test('grapheme table splits words longest match first and ignores unknown characters', () => {
  assert.deepEqual(splitGraphemes('thought'), ['th', 'ou', 'gh', 't']);
  assert.deepEqual(splitGraphemes("don't"), ['d', 'o', 'n', 't']);
  assert.deepEqual(splitGraphemes('A1'), ['a']);
  for (const id of Object.values(grapheme2ms22)) assert.ok(id >= 0 && id < 22);
  assert.equal(graphemeToMs22('sh'), 16);
  assert.equal(graphemeToMs22('SH'), 16);
  assert.equal(graphemeToMs22('?'), 0);
});

test('arkit52 has 52 unique names and the 61 layout adds nine rotations', () => {
  assert.equal(arkit52.length, 52);
  assert.equal(new Set(arkit52).size, 52);
  assert.equal(ARKIT_ORDER_61.length, 61);
  assert.equal(ARKIT_FRAME_LENGTH, 61);
  assert.equal(ARKIT_ORDER_61[17], 'jawOpen');
  assert.equal(ARKIT_ORDER_61[52], 'headYaw');
  assert.equal(arkitIndex('tongueOut'), 51);
  assert.equal(arkitIndex('nope'), -1);
});
