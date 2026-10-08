/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, contextOf, createBrain } from '../src/brain/Brain.ts';
import { compose } from '../src/brain/compose.ts';
import { standardChain } from '../src/brain/index.ts';
import { formatFacts, memoryRecall } from '../src/brain/middleware/memoryRecall.ts';
import { pageContext } from '../src/brain/middleware/pageContext.ts';
import { tokenMeter } from '../src/brain/middleware/tokenMeter.ts';
import { MockBrain } from '../src/brain/providers/MockBrain.ts';
import type { BrainContext, BrainEvent, BrainMiddleware, Fact } from '../src/types.ts';

const fromTokens = (tokens: string[]) =>
  createBrain('tokens', async function* respond(): AsyncIterable<BrainEvent> {
    for (const text of tokens) yield { type: 'token', text };
    yield { type: 'done', reason: 'complete' };
  });

const capture = (seen: (context: BrainContext) => void) =>
  createBrain('capture', async function* respond(context): AsyncIterable<BrainEvent> {
    seen(context);
    yield { type: 'done', reason: 'complete' };
  });

test('compose shapes the context inward and wraps the events outward', async () => {
  const order: string[] = [];
  const tag = (name: string): BrainMiddleware =>
    async function* middleware(context, next) {
      order.push(`${name}:context`);
      for await (const event of next({ ...context, text: context.text + name })) {
        order.push(`${name}:event`);
        yield event;
      }
    };
  const brain = compose([tag('a'), tag('b')])(capture((context) => order.push(`brain:${context.text}`)));
  await collect(brain.respond(contextOf('')));
  assert.deepEqual(order, ['a:context', 'b:context', 'brain:ab', 'b:event', 'a:event']);
});

test('tokenMeter counts tokens or characters', async () => {
  let count = 0;
  const add = (n: number): void => {
    count += n;
  };
  await collect(compose([tokenMeter(add)])(fromTokens(['ab', 'c'])).respond(contextOf('q')));
  assert.equal(count, 2);
  count = 0;
  await collect(compose([tokenMeter(add, 'chars')])(fromTokens(['ab', 'c'])).respond(contextOf('q')));
  assert.equal(count, 3);
});

test('memoryRecall keeps the most confident facts within 600 characters and can fetch them', async () => {
  const facts: Fact[] = Array.from({ length: 50 }, (_, index) => ({
    key: `k${index}`,
    value: 'v'.repeat(20),
    confidence: index / 50,
  }));
  let seen: readonly Fact[] = [];
  const brain = capture((context) => {
    seen = context.facts;
  });
  await collect(compose([memoryRecall()])(brain).respond(contextOf('q', { facts })));
  assert.ok(formatFacts(seen).length <= 600);
  assert.ok(seen.length > 10);
  assert.equal(seen[0]?.key, 'k49');

  const remembered: Fact[] = [{ key: 'name', value: 'M', confidence: 1 }];
  await collect(compose([memoryRecall({ recall: () => Promise.resolve(remembered) })])(brain).respond(contextOf('q')));
  assert.deepEqual(seen, remembered);

  const failing = memoryRecall({ recall: () => Promise.reject(new Error('down')) });
  await collect(compose([failing])(brain).respond(contextOf('q')));
  assert.deepEqual(seen, []);
});

test('pageContext adds the current page, trims it and drops ids off the list', async () => {
  let seen: BrainContext | undefined;
  const brain = capture((context) => {
    seen = context;
  });
  const page = { id: 'krupiq', title: 'Krupiq', excerpt: 'x'.repeat(2000) };
  await collect(compose([pageContext({ page, ids: ['krupiq'] })])(brain).respond(contextOf('q')));
  assert.equal(seen?.page?.id, 'krupiq');
  assert.equal(seen?.page?.excerpt.length, 800);
  const other = contextOf('q', { page: { ...page, id: 'other' } });
  await collect(compose([pageContext({ ids: ['krupiq'] })])(brain).respond(other));
  assert.equal(seen?.page, undefined);
  const traversal = contextOf('q', { page: { ...page, id: '../x' } });
  await collect(compose([pageContext()])(brain).respond(traversal));
  assert.equal(seen?.page, undefined);
});

test('MockBrain answers from the FAQ, the tour script, or the fallback, word by word', async () => {
  const script = {
    version: 1 as const,
    persona: 'Emily Wilson',
    stops: [
      { id: 'studio', anchor: '#story', text: 'Emersa began in 2023 as a games studio in London.' },
      { id: 'technology', anchor: '#technology', text: 'Watch my face while I talk. Triangles are data.' },
    ],
  };
  const faq = [{ patterns: /krupiq/i, answer: 'Krupiq guards networks.' }];
  const brain = new MockBrain({ script, faq, delayMs: 0 });
  const answered = await collect(brain.respond(contextOf('What is Krupiq?')));
  assert.equal(answered.text, 'Krupiq guards networks.');
  assert.deepEqual(answered.actions, [{ type: 'goto', target: 'products' }]);

  const toured = await collect(brain.respond(contextOf('Tell me about the studio in London')));
  assert.equal(toured.text, 'Emersa began in 2023 as a games studio in London.');
  assert.deepEqual(toured.actions, [{ type: 'goto', target: 'story' }]);

  const events: BrainEvent[] = [];
  for await (const event of brain.respond(contextOf('xyzzy'))) events.push(event);
  assert.ok(events.filter((event) => event.type === 'token').length > 5, 'streams word by word');
  assert.equal(events.at(-1)?.type, 'done');

  const controller = new AbortController();
  controller.abort();
  const aborted = await collect(brain.respond(contextOf('hello', { signal: controller.signal })));
  assert.equal(aborted.text, '');
  assert.equal(aborted.reason, 'aborted');
});

test('standardChain cleans a mock reply end to end and feeds the meter', async () => {
  let metered = 0;
  const faq = [{ patterns: /hi/i, answer: 'Hello ⟦goto:docs⟧ there. See https://nope.example now.' }];
  const brain = standardChain({
    onToken: (n) => {
      metered += n;
    },
  })(new MockBrain({ faq, delayMs: 0 }));
  const reply = await collect(brain.respond(contextOf('hi')));
  assert.equal(reply.text, 'Hello there. See now.');
  assert.deepEqual(reply.actions, [{ type: 'goto', target: 'docs' }]);
  assert.deepEqual(reply.sentences, ['Hello there.', 'See now.']);
  assert.ok(metered >= 4);
  assert.equal(brain.name, 'mock');
});
