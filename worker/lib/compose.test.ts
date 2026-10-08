import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asD1, seedCounter, testDatabase } from '../test/d1.ts';
import { body, brokenLimiter, ctx, fakeEnv, form, kinds, limiter, metrics, post, SAME_SITE } from '../test/harness.ts';
import {
  compose,
  hostCheck,
  type Middleware,
  quota,
  rateLimit,
  readBody,
  sameSiteOnly,
  traversalGuard,
} from './compose.ts';
import type { Env } from './env.ts';
import { json } from './http.ts';
import { CONTACT_SENDS, dayKey } from './quota.ts';

const run = (
  middlewares: Middleware[],
  init: RequestInit = {},
  env: Env = fakeEnv(),
  url = 'https://emersa.io/api/t',
): Promise<Response> =>
  Promise.resolve(
    compose('t', middlewares, (c) => json({ ok: true, fields: c.fields }))(new Request(url, init), env, ctx),
  );

test('compose runs the middlewares in order and the handler last; one that answers stops the chain', async () => {
  const order: string[] = [];
  const note =
    (name: string): Middleware =>
    async (_c, next) => {
      order.push(name);
      return next();
    };
  const stop: Middleware = async () => json({ ok: false }, 418);

  const ok = await run([note('a'), note('b')]);
  assert.equal(ok.status, 200);
  assert.deepEqual(order, ['a', 'b']);

  order.length = 0;
  const stopped = await run([note('a'), stop, note('c')]);
  assert.equal(stopped.status, 418);
  assert.deepEqual(order, ['a']);
});

test('traversalGuard and hostCheck answer 404 on their own', async () => {
  assert.equal((await run([traversalGuard], {}, fakeEnv(), 'https://emersa.io/api/x%2e%2e/y')).status, 404);
  assert.equal((await run([traversalGuard])).status, 200);
  assert.equal((await run([hostCheck], {}, fakeEnv(), 'https://evil.example/api/t')).status, 404);
  assert.equal((await run([hostCheck], {}, fakeEnv(), 'http://localhost:8850/api/t')).status, 200);
  assert.equal((await run([hostCheck], {}, fakeEnv({ ENV: 'beta' }), 'https://evil.example/api/t')).status, 200);
});

test('readBody fills the fields for the handler, or answers for it', async () => {
  const filled = await run([readBody(1024)], post(form({ a: '1', b: '2' })));
  assert.deepEqual((await body(filled)).fields, { a: '1', b: '2' });
  assert.equal((await run([readBody(1024)], { method: 'POST', body: 'a=1' })).status, 411);
  assert.equal((await run([readBody(4)], post(form({ a: '12345' })))).status, 413);
});

test('sameSiteOnly: reads pass; a post needs the site; headerless posts need the option; others are counted', async () => {
  const m = metrics();
  const env = fakeEnv({ METRICS: m.binding });
  assert.equal((await run([sameSiteOnly()], { headers: { origin: 'https://evil.example' } }, env)).status, 200);
  assert.equal((await run([sameSiteOnly()], post('', SAME_SITE), env)).status, 200);
  assert.equal((await run([sameSiteOnly()], post(''), env)).status, 403);
  assert.equal((await run([sameSiteOnly({ allowHeaderless: true })], post(''), env)).status, 200);
  const other = await run([sameSiteOnly({ allowHeaderless: true })], post('', { origin: 'https://evil.example' }), env);
  assert.equal(other.status, 403);
  assert.deepEqual(kinds(m), ['403', '403']);
});

test('rateLimit: 429 with Retry-After when the binding says no, counted; absent or broken bindings let it through', async () => {
  const m = metrics();
  const denied = await run(
    [rateLimit('CONTACT_LIMITER')],
    {},
    fakeEnv({ METRICS: m.binding, CONTACT_LIMITER: limiter(false) }),
  );
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal((await body(denied)).ok, false);
  assert.deepEqual(kinds(m), ['429']);

  assert.equal(
    (await run([rateLimit('CONTACT_LIMITER')], {}, fakeEnv({ CONTACT_LIMITER: limiter(true) }))).status,
    200,
  );
  assert.equal((await run([rateLimit('CONTACT_LIMITER')], {}, fakeEnv())).status, 200, 'no binding, no limit');
  assert.equal(
    (await run([rateLimit('CSP_LIMITER')], {}, fakeEnv({ CSP_LIMITER: brokenLimiter }))).status,
    200,
    'fails open',
  );
});

test('quota: refused at the cap when the database is bound, counted; skipped without it; open on a fault', async () => {
  const m = metrics();
  const db = testDatabase();
  const env = fakeEnv({ METRICS: m.binding, MEMORY: asD1(db) });
  assert.equal((await run([quota(CONTACT_SENDS)], {}, env)).status, 200, 'an empty table is under the cap');

  seedCounter(db, CONTACT_SENDS, dayKey(), CONTACT_SENDS.cap);
  const full = await run([quota(CONTACT_SENDS)], {}, env);
  assert.equal(full.status, 503);
  assert.equal((await body(full)).error, CONTACT_SENDS.full);
  const retry = Number(full.headers.get('Retry-After'));
  assert.ok(retry >= 1 && retry <= 86_400, `Retry-After ${retry} reaches the next day`);
  assert.deepEqual(kinds(m), ['503-cap']);

  assert.equal((await run([quota(CONTACT_SENDS)], {}, fakeEnv())).status, 200, 'no database, no cap');
  db.break();
  assert.equal((await run([quota(CONTACT_SENDS)], {}, env)).status, 200, 'a database fault fails open');
  db.close();
});
