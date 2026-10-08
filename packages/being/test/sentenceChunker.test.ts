/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, contextOf, createBrain } from '../src/brain/Brain.ts';
import { compose } from '../src/brain/compose.ts';
import { SentenceBuffer, sentenceChunker } from '../src/brain/middleware/sentenceChunker.ts';
import type { BrainEvent } from '../src/types.ts';

const fromTokens = (tokens: string[]) =>
  createBrain('tokens', async function* respond(): AsyncIterable<BrainEvent> {
    for (const text of tokens) yield { type: 'token', text };
    yield { type: 'done', reason: 'complete' };
  });

test('SentenceBuffer splits on terminators followed by space and keeps decimals together', () => {
  const buffer = new SentenceBuffer();
  assert.deepEqual(buffer.push('Hello world. How'), ['Hello world.']);
  assert.deepEqual(buffer.push(' are you? Fine'), ['How are you?']);
  assert.deepEqual(buffer.push(' 3.5 is a number. '), ['Fine 3.5 is a number.']);
  assert.deepEqual(buffer.flush(), []);
});

test('a long clause breaks at its last comma', () => {
  const buffer = new SentenceBuffer();
  assert.deepEqual(buffer.push('When the being speaks, the triangles move, and the mesh'), [
    'When the being speaks, the triangles move,',
  ]);
  assert.deepEqual(buffer.flush(), ['and the mesh']);
});

test('closing quotes stay with their sentence and flush ends a trailing one', () => {
  const buffer = new SentenceBuffer();
  assert.deepEqual(buffer.push('She said "go." Then'), ['She said "go."']);
  assert.deepEqual(buffer.flush(), ['Then']);
});

test('the middleware emits sentence events alongside the tokens', async () => {
  const brain = compose([sentenceChunker()])(fromTokens(['Hi ', 'there. ', 'Bye']));
  const reply = await collect(brain.respond(contextOf('q')));
  assert.equal(reply.text, 'Hi there. Bye');
  assert.deepEqual(reply.sentences, ['Hi there.', 'Bye']);
  assert.equal(reply.reason, 'complete');
});
