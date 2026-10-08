import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mockFetch, noFetch } from '../test/harness.ts';
import { verify } from './turnstile.ts';

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

test('a pass needs Turnstile to say success; the token, the secret and the address are posted as a form', async () => {
  const seen: Array<{ url: string; body: string }> = [];
  restore = mockFetch(async (url, init) => {
    seen.push({ url, body: String(await new Response(init.body as BodyInit).text()) });
    return Response.json({ success: true, hostname: 'emersa.io' });
  });
  assert.equal(await verify('secret-1', 'token-1', '203.0.113.9'), true);
  assert.equal(seen[0]?.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  const posted = new URLSearchParams(seen[0]?.body);
  assert.equal(posted.get('secret'), 'secret-1');
  assert.equal(posted.get('response'), 'token-1');
  assert.equal(posted.get('remoteip'), '203.0.113.9');

  assert.equal(await verify('secret-1', 'token-1', null), true);
  assert.equal(new URLSearchParams(seen[1]?.body).has('remoteip'), false);
});

test('anything short of success is false: refusals, errors, bad answers and network failures', async () => {
  restore = mockFetch(async () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] }));
  assert.equal(await verify('s', 't', null), false);
  restore();
  restore = mockFetch(async () => new Response('busy', { status: 503 }));
  assert.equal(await verify('s', 't', null), false);
  restore();
  restore = mockFetch(async () => new Response('not json'));
  assert.equal(await verify('s', 't', null), false);
  restore();
  restore = mockFetch(async () => Response.json({ success: 'true' }));
  assert.equal(await verify('s', 't', null), false, 'a string is not a pass');
  restore();
  restore = mockFetch(() => {
    throw new TypeError('network');
  });
  assert.equal(await verify('s', 't', null), false);
});

test('an empty secret, an empty token or an oversized token never reach the network', async () => {
  restore = noFetch();
  assert.equal(await verify('', 't', null), false);
  assert.equal(await verify('s', '', null), false);
  assert.equal(await verify('s', 'x'.repeat(2049), null), false);
});
