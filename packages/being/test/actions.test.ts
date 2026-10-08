/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ACTIONS, parseAction, parseActions, SELECTOR_PATTERN } from '../src/tour/actions.ts';

test('parseActions extracts whitelisted markers in order, caps them and cleans the text', () => {
  const { clean, actions } = parseActions(
    'Let me show you ⟦goto:products⟧ our products ⟦highlight:#story⟧ now ⟦point:left⟧ ⟦emote:smile⟧ ⟦open:talk⟧.',
  );
  assert.equal(clean, 'Let me show you our products now.');
  assert.equal(actions.length, MAX_ACTIONS);
  assert.deepEqual(actions, [
    { type: 'goto', target: 'products' },
    { type: 'highlight', target: '#story' },
    { type: 'point', side: 'left' },
    { type: 'emote', name: 'smile' },
  ]);
});

test('invalid markers are removed from the text but never become actions', () => {
  const { clean, actions } = parseActions('Hi ⟦highlight:body onclick=x⟧ ⟦dance:now⟧ ⟦goto:../etc⟧ ⟦point:up⟧ there');
  assert.equal(clean, 'Hi there');
  assert.deepEqual(actions, []);
});

test('ASCII double brackets work and stray glyphs vanish', () => {
  const { clean, actions } = parseActions('[[goto:#Story]] ok ⟧ [[open:talk]]');
  assert.equal(clean, 'ok');
  assert.deepEqual(actions, [
    { type: 'goto', target: 'story' },
    { type: 'open', what: 'talk' },
  ]);
});

test('the selector whitelist allows ids, classes and attributes only', () => {
  assert.ok(SELECTOR_PATTERN.test('[data-product="emily"]'));
  assert.ok(SELECTOR_PATTERN.test('.card.is-open'));
  assert.ok(SELECTOR_PATTERN.test('#technology'));
  assert.ok(!SELECTOR_PATTERN.test('div > a'));
  assert.ok(!SELECTOR_PATTERN.test('#a b'));
  assert.ok(!SELECTOR_PATTERN.test('a[href]'));
  assert.deepEqual(parseAction('emote', ' nod '), { type: 'emote', name: 'nod' });
  assert.equal(parseAction('emote', 'rage'), undefined);
  assert.equal(parseAction('open', 'settings'), undefined);
});
