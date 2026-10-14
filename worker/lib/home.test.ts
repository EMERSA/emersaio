import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CSP_PHASE1, CSP_PHASE2_HOME, PERMISSIONS_POLICY, PERMISSIONS_POLICY_TALK } from '../../tools/policy.ts';
import { home } from './home.ts';

/** An asset layer that answers the way Cloudflare's does for "/": the Talk policy and the base one, both. */
const doubled = (extra: Record<string, string> = {}, status = 200): Fetcher =>
  ({
    fetch: async () => {
      const headers = new Headers({ 'content-type': 'text/html', ...extra });
      headers.append('Content-Security-Policy', CSP_PHASE2_HOME);
      headers.append('Content-Security-Policy', CSP_PHASE1);
      headers.append('Permissions-Policy', PERMISSIONS_POLICY_TALK);
      headers.append('Permissions-Policy', PERMISSIONS_POLICY);
      return new Response(status === 200 ? '<!doctype html>' : null, { status, headers });
    },
  }) as unknown as Fetcher;

test('the home page leaves the Worker with exactly one CSP and one Permissions-Policy, the Talk ones', async () => {
  const response = await home(new Request('https://emersa.io/'), doubled());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), CSP_PHASE2_HOME);
  assert.equal(response.headers.get('permissions-policy'), PERMISSIONS_POLICY_TALK);
  assert.match(response.headers.get('permissions-policy') ?? '', /microphone=\(self\)/);
  assert.equal(response.headers.get('reporting-endpoints'), 'csp="/api/csp"');
  assert.equal(await response.text(), '<!doctype html>');
});

test('during the report-only rollout the base policy stays enforced', async () => {
  const response = await home(
    new Request('https://emersa.io/'),
    doubled({ 'Content-Security-Policy-Report-Only': 'default-src x' }),
  );
  assert.equal(response.headers.get('content-security-policy'), CSP_PHASE1);
  assert.equal(response.headers.get('content-security-policy-report-only'), 'default-src x');
});

test('a redirect from the asset layer passes through untouched', async () => {
  const response = await home(new Request('https://emersa.io/index.html'), doubled({ location: '/' }, 307));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), '/');
});
