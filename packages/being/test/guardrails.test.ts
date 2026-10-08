/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, contextOf, createBrain } from '../src/brain/Brain.ts';
import { compose } from '../src/brain/compose.ts';
import { dropUrls, guardrails, hostAllowed, TextGuard } from '../src/brain/middleware/guardrails.ts';
import type { BrainEvent } from '../src/types.ts';

const fromTokens = (tokens: string[], extra: BrainEvent[] = []) =>
  createBrain('tokens', async function* respond(): AsyncIterable<BrainEvent> {
    for (const text of tokens) yield { type: 'token', text };
    for (const event of extra) yield event;
    yield { type: 'done', reason: 'complete' };
  });

const guarded = (tokens: string[], extra: BrainEvent[] = []) =>
  collect(compose([guardrails()])(fromTokens(tokens, extra)).respond(contextOf('q')));

test('markers split across tokens become actions and leave clean text', async () => {
  const reply = await guarded(['Let me ', 'show ⟦go', 'to:prod', 'ucts⟧ you', ' around.']);
  assert.deepEqual(reply.actions, [{ type: 'goto', target: 'products' }]);
  assert.equal(reply.text, 'Let me show you around.');
  assert.equal(reply.reason, 'complete');
});

test('foreign links are dropped, our own are kept, even when split across tokens', async () => {
  const reply = await guarded(['Read https://evil.example/x ', 'and https://emersa.io/do', 'cs. Also krupiq.com']);
  assert.equal(reply.text, 'Read and https://emersa.io/docs. Also krupiq.com');
  assert.ok(hostAllowed('https://www.krupiq.com/'));
  assert.ok(!hostAllowed('https://emersa.io.evil.example/'));
  assert.equal(dropUrls('see http://a.example/p?q=1, ok'), 'see , ok');
});

test('actions are capped at four across markers and provider events', async () => {
  const tokens = ['⟦point:left⟧ ', '⟦point:right⟧ ', '⟦emote:nod⟧ ', 'x ⟦emote:think⟧ y ⟦goto:docs⟧'];
  const reply = await guarded(tokens, [{ type: 'action', action: { type: 'open', what: 'talk' } }]);
  assert.equal(reply.actions.length, 4);
  assert.equal(reply.text.trim(), 'x y');
});

test('the reply stops at 1200 characters with a limit reason', async () => {
  const tokens = Array.from({ length: 300 }, () => 'word ');
  const reply = await guarded(tokens);
  assert.equal(reply.text.length, 1200);
  assert.equal(reply.reason, 'limit');
});

test('sentence events are cleaned too and an unfinished marker is dropped at the end', async () => {
  const sentence: BrainEvent = { type: 'sentence', text: 'Go ⟦goto:docs⟧ now https://x.example' };
  const reply = await guarded(['Fine ⟦goto:no'], [sentence]);
  assert.equal(reply.text, 'Fine ');
  assert.deepEqual(reply.sentences, ['Go now']);
});

test('TextGuard releases an over-long opener as plain words', () => {
  const guard = new TextGuard();
  const first = guard.push(`[[${'a'.repeat(100)}`);
  assert.equal(first.text, 'a'.repeat(100));
  assert.deepEqual(first.actions, []);
});
