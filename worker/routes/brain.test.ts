/**
 * POST /api/brain: the SSE stream from a mocked NIM, the markers, the caps and the refusals.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { addDocument, bump, MAX_TURNS_PER_DAY, MAX_TURNS_PER_SESSION, saveFacts } from '../lib/memory.ts';
import { asD1 } from '../test/d1.ts';
import { assertSecure, call, limiter, post, SAME_SITE } from '../test/harness.ts';
import { talkEnv, upstreams, visitor } from '../test/talk.ts';
import { BRAIN_OFF } from './brain.ts';

const BRAIN = 'https://emersa.io/api/brain';
const NIM = { NIM_BASE_URL: 'https://nim.example/v1', NVIDIA_API_KEY: 'nvapi-test' };
const ask = (text: string, cookie: string, extra: Record<string, unknown> = {}) =>
  post(JSON.stringify({ text, ...extra }), { ...SAME_SITE, cookie }, 'application/json');

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

const chunk = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function nimStream(parts: string[]): Response {
  const text = `${parts.map(chunk).join('')}data: [DONE]\n\n`;
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

const events = (text: string): Array<{ event: string; data: unknown }> =>
  text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const [e = '', d = ''] = block.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });

test('a reply streams as token events, markers become actions, and it ends with done', async () => {
  const { env, db } = talkEnv(NIM);
  const v = await visitor(db);
  await saveFacts(asD1(db), v.id, [{ key: 'name', value: 'Ada', confidence: 1 }]);
  await addDocument(asD1(db), v.id, 'brief.txt', 'The museum opens in May.');
  let sent: { model: string; messages: Array<{ role: string; content: string }>; stream: boolean } | undefined;
  restore = upstreams({
    other: async (url, init) => {
      assert.equal(url, 'https://nim.example/v1/chat/completions');
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer nvapi-test');
      sent = JSON.parse(String(init.body));
      return nimStream(['Hello Ada. ', 'Let me show you [[go', 'to:contact]] the form.', ' [[bogus:x]]Done.']);
    },
  });
  const response = await call(BRAIN, ask('Where is the contact form?', v.cookie, { page: 'hero' }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assertSecure(response, 'brain');
  const got = events(await response.text());
  const tokens = got.filter((e) => e.event === 'token').map((e) => (e.data as { text: string }).text);
  assert.equal(tokens.join(''), 'Hello Ada. Let me show you  the form. Done.');
  assert.deepEqual(
    got.filter((e) => e.event === 'action').map((e) => e.data),
    [{ type: 'goto', target: 'contact' }],
  );
  assert.deepEqual(got.at(-1), { event: 'done', data: { reason: 'complete' } });
  assert.equal(sent?.stream, true);
  assert.equal(sent?.model, env.NIM_MODEL);
  const system = sent?.messages[0]?.content ?? '';
  assert.match(system, /name: Ada/);
  assert.match(system, /The museum opens in May\./);
  assert.match(system, /page section "hero"/);
  assert.deepEqual(sent?.messages.at(-1), { role: 'user', content: 'Where is the contact form?' });
});

test('an upstream failure is an error event, not a broken stream', async () => {
  const { env, db } = talkEnv(NIM);
  const v = await visitor(db);
  restore = upstreams({ other: () => new Response('busy', { status: 503 }) });
  const got = events(await (await call(BRAIN, ask('hi', v.cookie), env)).text());
  assert.equal(got.length, 1);
  assert.equal(got[0]?.event, 'error');
});

test('brain refusals: 503 in production, 403, 405, 411, 413, 422, 429', async () => {
  const prod = talkEnv();
  const pv = await visitor(prod.db);
  const off = await call(BRAIN, ask('hi', pv.cookie), prod.env);
  assert.equal(off.status, 503);
  assert.equal(((await off.json()) as { error: string }).error, BRAIN_OFF);
  assert.equal((await call(BRAIN, ask('hi', pv.cookie), { ...prod.env, NIM_BASE_URL: 'https://x/v1' })).status, 503);

  const { env, db } = talkEnv(NIM);
  const v = await visitor(db);
  restore = upstreams({ other: () => nimStream(['ok']) });
  assert.equal((await call(BRAIN, ask('hi', ''), env)).status, 403);
  assert.equal(
    (await call(BRAIN, post('{}', { origin: 'https://evil.example' }, 'application/json'), env)).status,
    403,
  );
  assert.equal((await call(BRAIN, { method: 'GET' }, env)).status, 405);
  assert.equal((await call(BRAIN, { method: 'POST', headers: { ...SAME_SITE } }, env)).status, 411);
  assert.equal((await call(BRAIN, ask('x'.repeat(5000), v.cookie), env)).status, 413);
  assert.equal((await call(BRAIN, ask('é'.repeat(1100), v.cookie), env)).status, 413, '2 KB is bytes, not characters');
  assert.equal((await call(BRAIN, ask('', v.cookie), env)).status, 422);
  assert.equal((await call(BRAIN, ask('hi', v.cookie), { ...env, BRAIN_LIMITER: limiter(false) })).status, 429);

  for (let i = 0; i < MAX_TURNS_PER_DAY; i++) await bump(asD1(db), v.id, 'turns');
  assert.equal((await call(BRAIN, ask('hi', v.cookie), env)).status, 429);
});

test('the 41st turn of a session is refused', async () => {
  const { env, db } = talkEnv(NIM);
  const v = await visitor(db);
  restore = upstreams({ other: () => nimStream(['ok']) });
  for (let i = 0; i < MAX_TURNS_PER_SESSION; i++) {
    const r = await call(BRAIN, ask('hi', v.cookie), env);
    assert.equal(r.status, 200);
    await r.text();
  }
  assert.equal((await call(BRAIN, ask('hi', v.cookie), env)).status, 429);
});
