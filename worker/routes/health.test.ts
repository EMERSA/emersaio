import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERSION } from '../lib/version.ts';
import { assertSecure, body, call, callRequest, fakeEnv } from '../test/harness.ts';

const HEALTH = 'https://emersa.io/api/health';

test('GET /api/health answers the documented shape, with no cache', async () => {
  const response = await call(HEALTH);
  assert.equal(response.status, 200);
  assertSecure(response, 'health');
  assert.deepEqual(await body(response), { ok: true, version: VERSION, colo: null, env: 'production' });
});

test('the colo comes from the platform when it says, and the env from the vars', async () => {
  const request = new Request(HEALTH);
  Object.defineProperty(request, 'cf', { value: { colo: 'LHR', country: 'GB' } });
  const response = await callRequest(request, fakeEnv({ ENV: 'beta' }));
  assert.deepEqual(await body(response), { ok: true, version: VERSION, colo: 'LHR', env: 'beta' });
});
