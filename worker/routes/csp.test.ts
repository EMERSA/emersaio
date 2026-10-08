import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertSecure, call, fakeEnv, kinds, metrics, post } from '../test/harness.ts';
import { MAX_REPORT_BYTES, parseReports } from './csp.ts';

const CSP = 'https://emersa.io/api/csp';
const CSP_REPORT = 'application/csp-report';
const REPORTS_JSON = 'application/reports+json';

const report = (payload: unknown, type: string, headers: Record<string, string> = {}): RequestInit =>
  post(JSON.stringify(payload), headers, type);

const enforced = {
  'csp-report': {
    'document-uri': 'https://emersa.io/docs/synthetic-beings',
    referrer: '',
    'effective-directive': 'script-src-elem',
    'violated-directive': 'script-src',
    'original-policy': "default-src 'none'; script-src 'self'",
    'blocked-uri': 'https://evil.example/x.js?token=secret',
    disposition: 'enforce',
    'script-sample': 'alert(1)',
    'status-code': 200,
  },
};

test('a report-uri report is reduced to directive, blocked host and disposition, then 204', async () => {
  const m = metrics();
  const response = await call(CSP, report(enforced, CSP_REPORT), fakeEnv({ METRICS: m.binding }));
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assertSecure(response, 'csp');
  assert.deepEqual(
    m.points.map((p) => p.blobs),
    [['csp', 'script-src-elem evil.example', 'enforce']],
  );
  const written = JSON.stringify(m.points);
  for (const secret of ['docs', 'alert', 'token', 'x.js']) assert.ok(!written.includes(secret), secret);
});

test('a Reporting API batch costs one point, its first CSP violation; other report types are ignored', async () => {
  const m = metrics();
  const violation = (blockedURL: string, disposition = 'report') => ({
    age: 10,
    type: 'csp-violation',
    url: 'https://emersa.io/',
    user_agent: 'Mozilla/5.0',
    body: { documentURL: 'https://emersa.io/', effectiveDirective: 'connect-src', blockedURL, disposition },
  });
  const batch = [
    { type: 'deprecation', url: 'https://emersa.io/', body: { id: 'x' } },
    violation('https://api.convai.com/user/connect'),
    violation('wss://cell.livekit.cloud/rtc', 'enforce'),
    ...Array.from({ length: 12 }, (_, i) => violation(`https://h${i}.example/`)),
  ];
  const response = await call(CSP, report(batch, REPORTS_JSON), fakeEnv({ METRICS: m.binding }));
  assert.equal(response.status, 204);
  assert.deepEqual(
    m.points.map((p) => p.blobs),
    [['csp', 'connect-src api.convai.com', 'report']],
  );
});

test('blocked keywords and odd values are kept small: inline, eval, data, none, other, unknown', () => {
  const one = (body: Record<string, unknown>) => parseReports(JSON.stringify({ 'csp-report': body }), CSP_REPORT)[0];
  assert.deepEqual(one({ 'effective-directive': 'script-src', 'blocked-uri': 'inline' }), {
    directive: 'script-src',
    blocked: 'inline',
    disposition: 'unknown',
  });
  assert.equal(one({ 'violated-directive': 'script-src https://x', 'blocked-uri': 'eval' })?.directive, 'script-src');
  assert.equal(one({ 'blocked-uri': 'data' })?.blocked, 'data');
  assert.equal(one({ 'blocked-uri': '' })?.blocked, 'none');
  assert.equal(one({ 'blocked-uri': 'about:blank' })?.blocked, 'none');
  assert.equal(one({ 'blocked-uri': '<script>' })?.blocked, 'other');
  assert.equal(one({ 'blocked-uri': 'x'.repeat(300) })?.blocked, 'other');
  assert.equal(one({ 'effective-directive': 'Script-Src; DROP' })?.directive, 'unknown');
  assert.equal(one({ disposition: 'ENFORCE' })?.disposition, 'enforce');
  assert.deepEqual(parseReports('not json', CSP_REPORT), []);
  assert.deepEqual(parseReports('{"csp-report": "text"}', CSP_REPORT), []);
  assert.deepEqual(parseReports('{"csp-report": {}}', REPORTS_JSON), [], 'the type decides the shape');
});

test('bodies that are not reports still get 204 and are counted as malformed', async () => {
  const m = metrics();
  const env = fakeEnv({ METRICS: m.binding });
  assert.equal((await call(CSP, post('not json', {}, CSP_REPORT), env)).status, 204);
  assert.equal((await call(CSP, report({ other: 1 }, CSP_REPORT), env)).status, 204);
  assert.equal((await call(CSP, report([{ type: 'deprecation' }], REPORTS_JSON), env)).status, 204);
  assert.deepEqual(kinds(m), ['malformed', 'malformed', 'malformed']);
});

test('content type, length and size are checked before anything is parsed', async () => {
  const m = metrics();
  const env = fakeEnv({ METRICS: m.binding });
  assert.equal((await call(CSP, report(enforced, 'application/json'), env)).status, 415);
  assert.equal((await call(CSP, report(enforced, 'text/plain'), env)).status, 415);
  const noLength = await call(
    CSP,
    { method: 'POST', body: JSON.stringify(enforced), headers: { 'content-type': CSP_REPORT } },
    env,
  );
  assert.equal(noLength.status, 411);
  const declared = await call(CSP, post('{}', { 'content-length': String(MAX_REPORT_BYTES + 1) }, CSP_REPORT), env);
  assert.equal(declared.status, 413);
  const padded = { 'csp-report': { 'blocked-uri': 'x'.repeat(MAX_REPORT_BYTES) } };
  assert.equal((await call(CSP, report(padded, CSP_REPORT), env)).status, 413);
  assert.deepEqual(m.points, []);
});

test('reports from another site are refused; a headerless post from a browser is accepted', async () => {
  const m = metrics();
  const env = fakeEnv({ METRICS: m.binding, CSP_LIMITER: { limit: async () => ({ success: true }) } });
  assert.equal((await call(CSP, report(enforced, CSP_REPORT, { origin: 'https://evil.example' }), env)).status, 403);
  assert.equal((await call(CSP, report(enforced, CSP_REPORT, { 'sec-fetch-site': 'cross-site' }), env)).status, 403);
  assert.equal((await call(CSP, report(enforced, CSP_REPORT, { origin: 'https://emersa.io' }), env)).status, 204);
  assert.equal((await call(CSP, report(enforced, CSP_REPORT), env)).status, 204);
  assert.deepEqual(kinds(m), ['403', '403', 'script-src-elem evil.example', 'script-src-elem evil.example']);
});
