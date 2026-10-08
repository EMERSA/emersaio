/**
 * /api/memory (GET, DELETE) and /api/memory/turns against the in-memory D1.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { addDocument, bump, getVisitor, MAX_TURNS_PER_DAY, saveFacts, turnCount } from '../lib/memory.ts';
import { asD1 } from '../test/d1.ts';
import { assertSecure, body, call, limiter, post, SAME_SITE, settle } from '../test/harness.ts';
import { seen, talkEnv, upstreams, visitor } from '../test/talk.ts';

const MEMORY = 'https://emersa.io/api/memory';
const TURNS = 'https://emersa.io/api/memory/turns';
const turn = (role: string, text: string, cookie: string) =>
  post(JSON.stringify({ role, text }), { ...SAME_SITE, cookie }, 'application/json');

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

test('turns are appended, read back oldest first, and every sixth distils facts', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  const lines = [
    'Hello Emily',
    'My name is Ada Lovelace',
    'I work at Analytical Engines',
    'We are interested in a museum guide.',
    'Thanks',
  ];
  for (const text of lines) assert.equal((await call(TURNS, turn('user', text, v.cookie), env)).status, 204);
  assert.equal((await call(TURNS, turn('being', 'Lovely to meet you, Ada.', v.cookie), env)).status, 204);
  await settle();

  const response = await call(MEMORY, { headers: { cookie: v.cookie } }, env);
  assert.equal(response.status, 200);
  assertSecure(response, 'memory');
  const reply = (await body(response)) as unknown as {
    remembered: boolean;
    facts: Array<{ key: string; value: string }>;
    turns: Array<{ role: string; text: string }>;
    documents: unknown[];
  };
  assert.equal(reply.remembered, true);
  assert.equal(reply.turns.length, 6);
  assert.equal(reply.turns[0]?.text, 'Hello Emily');
  assert.equal(reply.turns[5]?.role, 'being');
  assert.deepEqual(reply.facts, [
    { key: 'company', value: 'Analytical Engines' },
    { key: 'interest', value: 'a museum guide' },
    { key: 'name', value: 'Ada Lovelace' },
  ]);
});

test('GET without a cookie remembers nothing; GET keeps only the last 50 turns', async () => {
  const { env, db } = talkEnv();
  const empty = await body(await call(MEMORY, {}, env));
  assert.equal(empty.remembered, false);
  const v = await visitor(db);
  for (let i = 0; i < 55; i++) await call(TURNS, turn('user', `line ${i}`, v.cookie), env);
  const reply = (await body(await call(MEMORY, { headers: { cookie: v.cookie } }, env))) as unknown as {
    turns: Array<{ text: string }>;
  };
  assert.equal(reply.turns.length, 50);
  assert.equal(reply.turns[0]?.text, 'line 5');
});

test('Forget me deletes every row, clears the cookie and asks Convai to forget', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  const d1 = asD1(db);
  await call(TURNS, turn('user', 'hello', v.cookie), env);
  await saveFacts(d1, v.id, [{ key: 'name', value: 'Ada', confidence: 1 }]);
  await addDocument(d1, v.id, 'a.txt', 'text');
  restore = upstreams();
  const response = await call(MEMORY, { method: 'DELETE', headers: { ...SAME_SITE, cookie: v.cookie } }, env);
  assert.equal(response.status, 204);
  assertSecure(response, 'forget');
  assert.match(
    response.headers.get('set-cookie') ?? '',
    /^em_vid=; HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=0$/,
  );
  assert.equal(await getVisitor(d1, v.id), null);
  for (const table of ['turn', 'fact', 'document', 'quota', 'session']) {
    assert.equal(db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n, 0, table);
  }
  assert.ok(seen.some((u) => u.startsWith('https://api.convai.com/')));
});

test('Forget me without a cookie still clears it; Convai failing does not fail it', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams({ other: () => new Response(null, { status: 500 }) });
  assert.equal((await call(MEMORY, { method: 'DELETE', headers: { ...SAME_SITE } }, env)).status, 204);
  restore();
  restore = upstreams();
  const failing = await call(MEMORY, { method: 'DELETE', headers: { ...SAME_SITE, cookie: v.cookie } }, env);
  assert.equal(failing.status, 204);
});

test('memory refusals: 403, 405, 411, 413, 422, 429, 503', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  assert.equal(
    (await call(MEMORY, { method: 'DELETE', headers: { origin: 'https://evil.example' } }, env)).status,
    403,
  );
  assert.equal((await call(TURNS, turn('user', 'hi', ''), env)).status, 403);
  assert.equal((await call(TURNS, turn('user', 'hi', `em_vid=${'e'.repeat(32)}.${'A'.repeat(43)}`), env)).status, 403);
  assert.equal((await call(TURNS, { method: 'GET' }, env)).status, 405);
  assert.equal((await call(MEMORY, { method: 'POST', headers: { ...SAME_SITE } }, env)).status, 405);
  assert.equal((await call(TURNS, { method: 'POST', headers: { ...SAME_SITE } }, env)).status, 411);
  assert.equal((await call(TURNS, turn('user', 'x'.repeat(9000), v.cookie), env)).status, 413);
  assert.equal((await call(TURNS, turn('user', 'x'.repeat(2500), v.cookie), env)).status, 413);
  assert.equal((await call(TURNS, turn('system', 'hi', v.cookie), env)).status, 422);
  assert.equal((await call(TURNS, turn('user', '   ', v.cookie), env)).status, 422);
  assert.equal(
    (await call(TURNS, turn('user', 'hi', v.cookie), { ...env, MEMORY_LIMITER: limiter(false) })).status,
    429,
  );
  for (let i = 0; i < MAX_TURNS_PER_DAY; i++) await bump(asD1(db), v.id, 'turns');
  const full = await call(TURNS, turn('user', 'hi', v.cookie), env);
  assert.equal(full.status, 429);
  assert.equal(await turnCount(asD1(db), v.id), 0);
  assert.equal((await call(MEMORY, {}, { ...env, MEMORY: undefined })).status, 503);
  assert.equal((await call(TURNS, turn('user', 'hi', v.cookie), { ...env, VISITOR_HMAC_KEY: undefined })).status, 503);
});
