import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSecure, body, ctx, fakeEnv, metrics, post } from '../test/harness.ts';
import { dispatch, looksLikeTraversal, type Route, readFields, siteOf, siteOrigin } from './http.ts';

const request = (init: RequestInit = {}, url = 'https://emersa.io/api/x'): Request => new Request(url, init);

test('dispatch: a handler that throws answers a JSON 500 with the headers, and counts it', async () => {
  const m = metrics();
  const route: Route = {
    GET: () => {
      throw new Error('boom');
    },
  };
  const response = await dispatch(route, request(), fakeEnv({ METRICS: m.binding }), ctx);
  assert.equal(response.status, 500);
  assertSecure(response, '500');
  assert.equal((await body(response)).ok, false);
  assert.deepEqual(m.points[0]?.blobs, ['/api/x', '500']);
});

test('dispatch: a response built some other way gets the headers it lacks', async () => {
  const response = await dispatch({ GET: () => new Response('plain') }, request(), fakeEnv(), ctx);
  assertSecure(response, 'plain');
  assert.equal(await response.text(), 'plain');
});

test('dispatch: HEAD runs GET without a body; 405 names the methods the route has', async () => {
  const route: Route = { GET: () => new Response('with body'), DELETE: () => new Response(null, { status: 204 }) };
  const head = await dispatch(route, request({ method: 'HEAD' }), fakeEnv(), ctx);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const put = await dispatch(route, request({ method: 'PUT' }), fakeEnv(), ctx);
  assert.equal(put.status, 405);
  assert.equal(put.headers.get('Allow'), 'GET, HEAD, DELETE');
  assert.equal((await dispatch(undefined, request(), fakeEnv(), ctx)).status, 404);
});

test('readFields: the length is checked before anything is read, and only two content types are read', async () => {
  const status = async (init: RequestInit, max = 1024): Promise<number> => {
    const out = await readFields(request(init), max);
    return out instanceof Response ? out.status : 200;
  };
  assert.equal(await status({ method: 'POST', body: 'a=1' }), 411);
  assert.equal(await status(post('a=1', { 'content-length': '2048' })), 413);
  assert.equal(await status(post('a=1', {}, 'text/plain')), 415);
  assert.equal(await status(post('a=1', {}, 'multipart/form-data')), 415);
  assert.equal(await status(post('{', {}, 'application/json')), 400);
  assert.equal(await status(post('[1]', {}, 'application/json')), 400);
  assert.equal(await status(post('"text"', {}, 'application/json')), 400);
  assert.equal(await status(post('a=1', { 'content-length': '2' }), 2), 413, 'a lying length does not help');
});

test('readFields: forms and JSON become flat strings; odd names and nested values are dropped', async () => {
  const fromForm = await readFields(request(post('name=Ada&__proto__=x&bad%20name=y&constructor=z')), 1024);
  assert.deepEqual(fromForm, { name: 'Ada', constructor: 'z' });
  const payload = JSON.stringify({ name: 'Ada', started: 123, ok: true, nested: { a: 1 }, list: [1], none: null });
  const fromJson = await readFields(request(post(payload, {}, 'application/json; charset=utf-8')), 1024);
  assert.deepEqual(fromJson, { name: 'Ada', started: '123', ok: 'true' });
});

test('siteOf: what Origin and Sec-Fetch-Site say about the sender', () => {
  const at = (url: string, headers: Record<string, string>): string =>
    siteOf(new Request(url, { method: 'POST', headers }));
  const site = 'https://emersa.io/api/x';
  assert.equal(at(site, {}), 'unknown');
  assert.equal(at(site, { origin: 'https://emersa.io' }), 'same');
  assert.equal(at(site, { origin: 'https://emersa.io', 'sec-fetch-site': 'same-origin' }), 'same');
  assert.equal(at(site, { 'sec-fetch-site': 'same-origin' }), 'same');
  assert.equal(at(site, { origin: 'null' }), 'other');
  assert.equal(at(site, { origin: 'https://evil.example' }), 'other');
  assert.equal(at(site, { origin: 'https://emersa.io', 'sec-fetch-site': 'cross-site' }), 'other');
  assert.equal(at(site, { 'sec-fetch-site': 'cross-site' }), 'other');
  assert.equal(at(site, { origin: 'http://emersa.io' }), 'other');
  assert.equal(at(site, { origin: 'https://emersa.io.evil.example' }), 'other');
  assert.equal(at(site, { origin: 'http://localhost:4321' }), 'other', 'local origins count only on a local host');
  assert.equal(at('http://localhost:8850/api/x', { origin: 'http://localhost:4321' }), 'same');
  assert.equal(at('http://localhost:8850/api/x', { origin: 'not a url' }), 'other');
  const beta = 'https://emersaio-beta.example.workers.dev';
  assert.equal(at(`${beta}/api/x`, { origin: beta }), 'same', 'a site may post to itself on any host');
});

test('siteOrigin: the real host in production, the request origin for local hosts and beta', () => {
  assert.equal(siteOrigin(request({}, 'https://evil.example/api/x'), { ENV: 'production' }), 'https://emersa.io');
  assert.equal(siteOrigin(request({}, 'http://localhost:8850/api/x'), { ENV: 'production' }), 'http://localhost:8850');
  assert.equal(siteOrigin(request({}, 'https://beta.example/api/x'), { ENV: 'beta' }), 'https://beta.example');
});

test('looksLikeTraversal catches the encoded forms the URL parser leaves alone', () => {
  for (const path of ['/x%2e%2e/y', '/a%2Fb', '/a%5cb', '/a%00b', '/..', '/x/../y'])
    assert.ok(looksLikeTraversal(path), path);
  for (const path of ['/', '/api/health', '/docs/synthetic-beings', '/_astro/a.b12.js', '/x.y']) {
    assert.ok(!looksLikeTraversal(path), path);
  }
});
