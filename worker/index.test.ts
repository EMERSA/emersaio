/**
 * The Worker end to end through its fetch handler: routing, the method table, the host check and the fall
 * through to the assets. Each route's own behaviour is in worker/routes/*.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  assertSecure,
  assetsAsked,
  body,
  call,
  fakeEnv,
  form,
  good,
  JSON_ACCEPT,
  post,
  SAME_SITE,
} from './test/harness.ts';

const SITE = 'https://emersa.io';

afterEach(() => {
  assetsAsked.length = 0;
});

test('every response the Worker builds carries the security headers', async () => {
  const cases: Array<[string, RequestInit?]> = [
    [`${SITE}/api/health`],
    [`${SITE}/api/health`, { method: 'HEAD' }],
    [`${SITE}/api/nope`],
    [`${SITE}/api/health`, { method: 'POST' }],
    [`${SITE}/api/contact`],
    [`${SITE}/api/contact`, { method: 'OPTIONS' }],
    [`${SITE}/api/contact`, post(form(good), { ...JSON_ACCEPT, origin: 'https://evil.example' })],
    [`${SITE}/api/contact`, post(form(good), { ...JSON_ACCEPT, ...SAME_SITE })],
    [`${SITE}/api/contact`, post(form(good), SAME_SITE)],
    [`${SITE}/api/csp`, { method: 'POST' }],
    [`${SITE}/x%2e%2e/secret`],
    ['https://evil.example/api/health'],
  ];
  for (const [url, init] of cases) assertSecure(await call(url, init), `${init?.method ?? 'GET'} ${url}`);
});

test('traversal is refused before anything else, for API and page paths alike', async () => {
  for (const path of ['/x%2e%2e/y', '/api/%2fetc', '/a%5cb', '/a%00b', '/api/health/..%2f', '/api/..%2e/x']) {
    const response = await call(`${SITE}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal((await body(response)).ok, false, path);
  }
  assert.deepEqual(assetsAsked, []);
});

test('unknown API paths are a JSON 404, prototype names included, and never reach the assets', async () => {
  for (const path of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 'health/extra']) {
    const response = await call(`${SITE}/api/${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', path);
    assert.equal((await body(response)).ok, false, path);
  }
  assert.equal((await call(`${SITE}/api`)).status, 404, 'the bare prefix is an API path too');
  assert.deepEqual(assetsAsked, []);
  assert.equal((await call(`${SITE}/api/health/`)).status, 200, 'a trailing slash is tolerated');
});

test('methods: GET and HEAD on reads, POST on the form, 405 with Allow otherwise', async () => {
  const health = await call(`${SITE}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await body(health)).ok, true);

  const head = await call(`${SITE}/api/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const cases: Array<[string, string, string]> = [
    [`${SITE}/api/health`, 'POST', 'GET, HEAD'],
    [`${SITE}/api/contact`, 'GET', 'POST'],
    [`${SITE}/api/contact`, 'PUT', 'POST'],
    [`${SITE}/api/csp`, 'OPTIONS', 'POST'],
    [`${SITE}/api/health`, 'constructor', 'GET, HEAD'],
  ];
  for (const [url, method, allow] of cases) {
    const response = await call(url, { method });
    assert.equal(response.status, 405, `${method} ${url}`);
    assert.equal(response.headers.get('Allow'), allow, `${method} ${url}`);
  }
});

test('host check: production serves emersa.io and local hosts, any other name is a 404, beta serves its own', async () => {
  assert.equal((await call(`${SITE}/api/health`)).status, 200);
  assert.equal((await call('http://localhost:8850/api/health')).status, 200);
  assert.equal((await call('http://127.0.0.1:8850/api/health')).status, 200);
  for (const host of ['https://evil.example', 'https://www.emersa.io', 'https://emersa.io.evil.example']) {
    const response = await call(`${host}/api/health`);
    assert.equal(response.status, 404, host);
    assert.equal((await body(response)).ok, false, host);
  }
  const beta = fakeEnv({ ENV: 'beta' });
  const onBeta = await call('https://emersaio-beta.example.workers.dev/api/health', {}, beta);
  assert.equal(onBeta.status, 200);
  assert.equal((await body(onBeta)).env, 'beta');
  assert.deepEqual(assetsAsked, []);
});

test('pages and assets fall through to ASSETS untouched', async () => {
  const page = await call(`${SITE}/docs`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset /docs');
  assert.equal(page.headers.get('X-Frame-Options'), null, 'asset responses keep the headers the assets gave them');
  const missing = await call(`${SITE}/missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(assetsAsked, ['/docs', '/missing']);
});
