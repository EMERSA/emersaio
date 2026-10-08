/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryClient, parseSnapshot } from '../src/memory/MemoryClient.ts';

const fakeFetch =
  (status: number, body?: unknown, calls: string[] = []): typeof fetch =>
  async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

test('404 and 503 read as nothing remembered', async () => {
  for (const status of [404, 503]) {
    const client = new MemoryClient({ fetch: fakeFetch(status) });
    assert.deepEqual(await client.get(), { facts: [], turns: [] });
    assert.equal(await client.forget(), false);
    assert.equal(await client.recordTurn({ role: 'user', text: 'hi', at: 1 }), false);
  }
});

test('a snapshot keeps only well-formed rows and the routes are the planned ones', async () => {
  const calls: string[] = [];
  const payload = {
    facts: [{ key: 'name', value: 'M', confidence: 0.9 }, { key: 1 }],
    turns: [{ role: 'being', text: 'hi', at: 2 }, 'junk'],
  };
  const client = new MemoryClient({ fetch: fakeFetch(200, payload, calls) });
  const snapshot = await client.get();
  assert.equal(snapshot.facts.length, 1);
  assert.equal(snapshot.turns.length, 1);
  assert.equal(await client.forget(), true);
  assert.equal(await client.recordTurn({ role: 'user', text: 'hello', at: 3 }), true);
  assert.deepEqual(calls, ['GET /api/memory', 'DELETE /api/memory', 'POST /api/memory/turns']);
  assert.deepEqual(parseSnapshot('nope'), { facts: [], turns: [] });
});

test('other failures surface as errors', async () => {
  await assert.rejects(new MemoryClient({ fetch: fakeFetch(500) }).get(), /500/);
});
