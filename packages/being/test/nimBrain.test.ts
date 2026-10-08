/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, contextOf } from '../src/brain/Brain.ts';
import { standardChain } from '../src/brain/index.ts';
import { NimBrain, SseParser, speakSentences, toBrainEvent } from '../src/brain/providers/NimBrain.ts';
import type { SpeakRequest, SpeechOut } from '../src/types.ts';

const streamOf = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

const sseFetch = (chunks: string[], seen: unknown[] = []) =>
  (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
    return new Response(streamOf(chunks), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

test('the SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
  const parser = new SseParser();
  const out = [
    ...parser.push(': keep-alive\r\nevent: tok'),
    ...parser.push('en\r\ndata: {"text":"Hel'),
    ...parser.push('lo"}\r\n\r'),
    ...parser.push('\nevent: error\ndata: line one\ndata: line two\n\n'),
    ...parser.push('data: tail'),
    ...parser.flush(),
  ];
  assert.deepEqual(out, [
    { event: 'token', data: '{"text":"Hello"}' },
    { event: 'error', data: 'line one\nline two' },
    { event: 'message', data: 'tail' },
  ]);
});

test('events map to brain events; unknown actions are dropped', () => {
  assert.deepEqual(toBrainEvent({ event: 'token', data: 'plain' }), { type: 'token', text: 'plain' });
  assert.deepEqual(toBrainEvent({ event: 'action', data: '{"type":"goto","target":"#work"}' }), {
    type: 'action',
    action: { type: 'goto', target: '#work' },
  });
  assert.equal(toBrainEvent({ event: 'action', data: '{"type":"navigate"}' }), undefined);
  assert.deepEqual(toBrainEvent({ event: 'done', data: '{"reason":"limit"}' }), { type: 'done', reason: 'limit' });
  assert.deepEqual(toBrainEvent({ event: 'error', data: '{"message":"Too many turns."}' }), {
    type: 'error',
    message: 'Too many turns.',
  });
});

test('NimBrain posts text and the page id and streams tokens to done', async () => {
  const seen: unknown[] = [];
  const brain = new NimBrain({
    fetch: sseFetch(
      [
        'event: token\ndata: {"text":"Hi there. "}\n\n',
        'event: token\ndata: {"text":"I am Emily."}\n\n',
        'event: done\ndata: {}\n\n',
      ],
      seen,
    ),
  });
  const reply = await collect(
    brain.respond(contextOf('hello', { page: { id: 'docs/intro', title: 'Intro', excerpt: 'x' } })),
  );
  assert.equal(reply.text, 'Hi there. I am Emily.');
  assert.equal(reply.reason, 'complete');
  assert.deepEqual(seen[0], { text: 'hello', page: { id: 'docs/intro' } });
});

test('a 503 becomes an error event and a stream without done still completes', async () => {
  const off = new NimBrain({
    fetch: (async () =>
      new Response(JSON.stringify({ ok: false, error: 'The brain is not connected.' }), {
        status: 503,
      })) as typeof fetch,
  });
  const failed = await collect(off.respond(contextOf('hi')));
  assert.equal(failed.error, 'The brain is not connected.');
  const open = new NimBrain({ fetch: sseFetch(['event: token\ndata: {"text":"Hi."}\n\n']) });
  const done = await collect(open.respond(contextOf('hi')));
  assert.equal(done.reason, 'complete');
});

test('through the standard chain tokens are metered and sentences spoken in order', async () => {
  let metered = 0;
  const brain = standardChain({
    onToken: (n) => {
      metered += n;
    },
  })(
    new NimBrain({
      fetch: sseFetch([
        'event: token\ndata: {"text":"First one. "}\n\n',
        'event: token\ndata: {"text":"Second one."}\n\n',
        'event: done\ndata: {}\n\n',
      ]),
    }),
  );
  const spoken: string[] = [];
  const speech: SpeechOut = {
    name: 'fake',
    speak: async (request: SpeakRequest) => {
      spoken.push(request.text);
    },
    stop: () => undefined,
  };
  await speakSentences(brain.respond(contextOf('hi')), speech);
  assert.deepEqual(spoken, ['First one.', 'Second one.']);
  assert.equal(metered, 2);
});
