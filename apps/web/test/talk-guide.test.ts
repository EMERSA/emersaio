/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GUIDE_FADE_MS, GUIDE_VISIBLE_MS, guidePlan, guideState } from '../src/scripts/talk-guide.ts';

test('the guide line stays ten seconds, fades over 600 ms, then is hidden', () => {
  assert.equal(GUIDE_VISIBLE_MS, 10_000);
  assert.equal(GUIDE_FADE_MS, 600);
  assert.deepEqual(guidePlan(false), { fadeAt: 10_000, hideAt: 10_600 });
  assert.equal(guideState(0, false), 'shown');
  assert.equal(guideState(9_999, false), 'shown');
  assert.equal(guideState(10_000, false), 'fading');
  assert.equal(guideState(10_599, false), 'fading');
  assert.equal(guideState(10_600, false), 'hidden');
  // The browser check reads the line at 10.8 s.
  assert.equal(guideState(10_800, false), 'hidden');
});

test('under reduced motion the line is simply hidden at ten seconds, with no fade', () => {
  assert.deepEqual(guidePlan(true), { fadeAt: null, hideAt: 10_000 });
  assert.equal(guideState(9_999, true), 'shown');
  assert.equal(guideState(10_000, true), 'hidden');
  for (let ms = 0; ms <= 12_000; ms += 50) assert.notEqual(guideState(ms, true), 'fading');
});

test('hud.css fades the line over the same 600 ms', () => {
  const css = readFileSync(new URL('../src/styles/hud.css', import.meta.url), 'utf8');
  const rule = /\.talk-guide\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const duration = /transition:\s*opacity\s+(\d+)ms/.exec(rule)?.[1];
  assert.equal(Number(duration), GUIDE_FADE_MS, `.talk-guide transition: ${rule.trim()}`);
  assert.match(css, /\.talk-guide\.is-fading\s*\{\s*opacity:\s*0;/);
});
