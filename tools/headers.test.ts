/**
 * Proves what a browser receives from the generated _headers under Cloudflare's inherit-and-join semantics.
 * Runs with "node --test tools/**\/*.test.ts" (type stripping, no build step).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  build,
  CSP_PHASE1,
  CSP_PHASE2_HOME,
  CSP_PHASE2_HOME_REPORT_ONLY,
  emit,
  MAX_LINE_LENGTH,
  MAX_RULES,
  matches,
  PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_TALK,
  parseHeaders,
  render,
  reportOnlyFrom,
  simulate,
  TALK_ORIGINS,
  trace,
} from './headers.ts';

/** Plan 4.5, verbatim. The test fails if anyone edits the policy without editing the plan. */
const PLAN_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; media-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; " +
  "frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'; upgrade-insecure-requests";

const phase1 = emit(1, false);
const phase2 = emit(2, false);

test('the Phase 1 policy is the one in the plan', () => {
  assert.equal(CSP_PHASE1, PLAN_CSP);
});

test('"/" gets exactly one CSP and one Permissions-Policy in Phase 1', () => {
  const { headers, joined } = trace(phase1, '/');
  assert.equal(headers['Content-Security-Policy'], CSP_PHASE1);
  assert.equal(headers['Permissions-Policy'], PERMISSIONS_POLICY);
  assert.match(headers['Permissions-Policy'] ?? '', /microphone=\(\)/);
  assert.deepEqual(joined, []);
  assert.equal(headers['Strict-Transport-Security'], 'max-age=63072000; includeSubDomains; preload');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(headers['Origin-Agent-Cluster'], '?1');
  assert.equal(headers['X-Permitted-Cross-Domain-Policies'], 'none');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
});

test('/og.png gets CORP cross-origin once, with the rest of the security set intact', () => {
  const { headers, joined } = trace(phase1, '/og.png');
  assert.equal(headers['Cross-Origin-Resource-Policy'], 'cross-origin');
  assert.deepEqual(joined, []);
  assert.equal(headers['Content-Security-Policy'], CSP_PHASE1);
  assert.match(headers['Cache-Control'] ?? '', /max-age=86400/);
});

test('caching rules', () => {
  assert.equal(simulate(phase1, '/_astro/x.js')['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(simulate(phase1, '/_astro/fonts/inter.woff2')['Cache-Control'], 'public, max-age=31536000, immutable');
  assert.equal(simulate(phase1, '/theme-boot.js')['Cache-Control'], 'public, max-age=3600');
  assert.equal(simulate(phase1, '/tour/script.json')['Cache-Control'], 'public, max-age=300');
  assert.equal(simulate(phase1, '/docs/index.json')['Cache-Control'], 'public, max-age=300');
  assert.equal(simulate(phase1, '/')['Cache-Control'], undefined);
  assert.equal(simulate(phase1, '/docs')['Cache-Control'], undefined);
});

test('the file respects the limits Cloudflare enforces', () => {
  for (const text of [phase1, phase2, emit(2, true)]) {
    const lines = text.split('\n');
    for (const line of lines) assert.ok(line.length <= MAX_LINE_LENGTH, `line too long: ${line.slice(0, 40)}`);
    assert.ok(parseHeaders(text).length <= MAX_RULES);
    // Every header line is indented, every rule path is not: that is the whole grammar.
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      assert.ok(line.startsWith('/') || line.startsWith('  '), `unexpected line: ${line}`);
    }
  }
});

test('Phase 2: "/" allows the Talk origins and the microphone, /docs does not', () => {
  const home = trace(phase2, '/');
  assert.deepEqual(home.joined, []);
  const csp = home.headers['Content-Security-Policy'] ?? '';
  assert.equal(csp, CSP_PHASE2_HOME);
  for (const origin of [...TALK_ORIGINS.convai, ...TALK_ORIGINS.livekit]) assert.ok(csp.includes(origin), origin);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /report-to csp/);
  assert.equal(home.headers['Permissions-Policy'], PERMISSIONS_POLICY_TALK);
  assert.match(home.headers['Permissions-Policy'] ?? '', /microphone=\(self\)/);
  assert.equal(home.headers['Reporting-Endpoints'], 'csp="/api/csp"');
  assert.equal(home.headers['Content-Security-Policy-Report-Only'], undefined);

  for (const path of ['/docs', '/docs/what-is-a-synthetic-being', '/games', '/contact', '/index.html']) {
    const page = trace(phase2, path);
    assert.equal(page.headers['Content-Security-Policy'], CSP_PHASE1, path);
    assert.equal(page.headers['Permissions-Policy'], PERMISSIONS_POLICY, path);
    assert.equal(page.headers['Reporting-Endpoints'], undefined, path);
    assert.deepEqual(page.joined, []);
  }
});

test('Phase 2 report-only keeps Phase 1 enforced and reports the new policy', () => {
  const home = trace(emit(2, true), '/');
  assert.equal(home.headers['Content-Security-Policy'], CSP_PHASE1);
  assert.equal(home.headers['Content-Security-Policy-Report-Only'], CSP_PHASE2_HOME_REPORT_ONLY);
  assert.match(home.headers['Permissions-Policy'] ?? '', /microphone=\(self\)/);
  assert.deepEqual(home.joined, []);
});

test('the report-only policy drops upgrade-insecure-requests, which browsers reject in a report-only policy', () => {
  assert.match(CSP_PHASE2_HOME, /; upgrade-insecure-requests;/);
  assert.doesNotMatch(CSP_PHASE2_HOME_REPORT_ONLY, /upgrade-insecure-requests/);
  // Otherwise the two policies are the same: every Talk origin, the reporting directives, the same order.
  assert.equal(CSP_PHASE2_HOME.replace('upgrade-insecure-requests; ', ''), CSP_PHASE2_HOME_REPORT_ONLY);
  // The enforced policy next to it still upgrades, so nothing is lost on "/".
  assert.match(trace(emit(2, true), '/').headers['Content-Security-Policy'] ?? '', /upgrade-insecure-requests/);
});

test('render refuses what Cloudflare would drop or rewrite with no more than a deploy warning', () => {
  const lines = (name: string, value: string) => [{ kind: 'set' as const, name, value }];
  assert.throws(
    () =>
      render([
        { path: '/*', lines: lines('X-A', '1') },
        { path: '/*', lines: lines('X-B', '2') },
      ]),
    /appears twice/,
  );
  assert.throws(() => render([{ path: '/x', lines: lines('X-A', '') }]), /sets X-A to nothing/);
  assert.throws(() => render([{ path: '/x', lines: lines('X-A', '   ') }]), /sets X-A to nothing/);
  assert.throws(() => render([{ path: '/x', lines: [] }]), /has no lines/);
  assert.throws(() => render([{ path: '/a/*/b/*', lines: lines('X-A', '1') }]), /one "\*"/);
  assert.throws(() => render([{ path: '/a/*/:splat', lines: lines('X-A', '1') }]), /:splat/);
  assert.throws(() => render([{ path: 'docs/*', lines: lines('X-A', '1') }]), /must start with/);
  assert.throws(() => render([{ path: '/x', lines: [{ kind: 'detach', name: 'Bad Name' }] }]), /Invalid header name/);
  // The real file passes, in every phase.
  for (const text of [emit(1, false), emit(2, false), emit(2, true)]) assert.ok(text.length > 0);
});

test('parseHeaders models the deploy: trimmed lines, "! " with a space, dropped empties, one rule per path', () => {
  // Indentation means nothing: a path line opens a rule wherever it sits, and a bare header line still belongs
  // to the rule above it.
  const loose = parseHeaders(['  /*', 'X-A: 1', '    /page', '  X-B: 2'].join('\n'));
  assert.deepEqual(
    loose.map((rule) => rule.path),
    ['/*', '/page'],
  );
  assert.deepEqual(loose[0]?.lines, [{ kind: 'set', name: 'X-A', value: '1' }]);

  // "!Name" without the space is not a detach line, so the override below it joins instead of replacing.
  const noSpace = trace(['/*', '  X-A: one', '', '/page', '  !X-A', '  X-A: two'].join('\n'), '/page');
  assert.equal(noSpace.headers['X-A'], 'one, two');
  assert.deepEqual(noSpace.joined, ['x-a']);

  // An empty value, a name with a space and a line without a colon are dropped, not applied.
  const dropped = parseHeaders(['/*', '  X-A:', '  X B: 1', '  nonsense', '  X-C: 3'].join('\n'));
  assert.deepEqual(dropped[0]?.lines, [{ kind: 'set', name: 'X-C', value: '3' }]);

  // A rule without lines disappears, and so does a rule whose path carries two splats, lines included.
  const invalid = parseHeaders(['/empty', '', '/a/*/b/*', '  X-A: 1', '', '/ok', '  X-B: 2'].join('\n'));
  assert.deepEqual(
    invalid.map((rule) => rule.path),
    ['/ok'],
  );

  // A path that appears twice keeps its first position with the last rule's lines (constructHeaders).
  const twice = parseHeaders(['/', '  X-A: first', '', '/*', '  X-B: 1', '', '/', '  X-C: last'].join('\n'));
  assert.deepEqual(
    twice.map((rule) => rule.path),
    ['/', '/*'],
  );
  assert.deepEqual(twice[0]?.lines, [{ kind: 'set', name: 'X-C', value: 'last' }]);
  assert.equal(simulate(['/', '  X-A: first', '', '/', '  X-C: last'].join('\n'), '/')['X-A'], undefined);
});

test('applyRules runs every detach line of a rule before its set lines, as the asset worker does', () => {
  const text = ['/*', '  X-A: one', '', '/page', '  X-A: two', '  ! X-A'].join('\n');
  const page = trace(text, '/page');
  assert.equal(page.headers['X-A'], 'two');
  assert.deepEqual(page.joined, []);
});

test('Phase 1 emits no home override and no third-party origin anywhere', () => {
  assert.equal(
    build(1).some((rule) => rule.path === '/'),
    false,
  );
  assert.equal(/https?:\/\//.test(phase1.replace(/^#.*$/gm, '')), false);
});

test('simulate joins duplicates with a comma unless a detach line precedes the new value', () => {
  const text = [
    '/*',
    '  X-Test: one',
    '  Cache-Control: a',
    '',
    '/page',
    '  X-Test: two',
    '  ! Cache-Control',
    '  Cache-Control: b',
  ].join('\n');
  const page = trace(text, '/page');
  assert.equal(page.headers['X-Test'], 'one, two');
  assert.equal(page.headers['Cache-Control'], 'b');
  assert.deepEqual(page.joined, ['x-test']);
  assert.deepEqual(page.matched, ['/*', '/page']);
  const other = trace(text, '/other');
  assert.equal(other.headers['X-Test'], 'one');
  assert.equal(other.headers['Cache-Control'], 'a');
  // Header names are case-insensitive: a detach written in another case still removes the header.
  const mixed = simulate(['/*', '  x-test: one', '', '/page', '  ! X-TEST', '  X-Test: two'].join('\n'), '/page');
  assert.equal(mixed['X-Test'], 'two');
  assert.equal(mixed['x-test'], undefined);
});

test('path patterns: splats, placeholders and literals', () => {
  assert.ok(matches('/*', '/'));
  assert.ok(matches('/*', '/docs/x/y'));
  assert.ok(matches('/_astro/*', '/_astro/a/b.js'));
  assert.ok(!matches('/_astro/*', '/astro.js'));
  assert.ok(matches('/docs/:slug', '/docs/krupiq'));
  assert.ok(!matches('/docs/:slug', '/docs/krupiq/x'));
  assert.ok(matches('/', '/'));
  assert.ok(!matches('/', '/docs'));
  assert.ok(!matches('/', '/index.html'));
  assert.ok(matches('/og.png', '/og.png'));
  assert.ok(!matches('/og.png', '/og.pngx'));
  assert.ok(matches('https://emersa.io/*', '/anything'));
});

test('parseHeaders round-trips what emit writes', () => {
  const rules = parseHeaders(phase2);
  assert.deepEqual(
    rules.map((rule) => rule.path),
    build(2).map((rule) => rule.path),
  );
  assert.deepEqual(
    rules.map((rule) => rule.lines),
    build(2).map((rule) => rule.lines),
  );
});

test('REPORT_ONLY=1 and CSP_ROLLOUT=report-only both select the observation window; nothing else does', () => {
  assert.equal(reportOnlyFrom({ REPORT_ONLY: '1' }), true);
  assert.equal(reportOnlyFrom({ CSP_ROLLOUT: 'report-only' }), true);
  assert.equal(reportOnlyFrom({}), false);
  assert.equal(reportOnlyFrom({ REPORT_ONLY: '0' }), false);
});

test('Phase 2 report-only: "/" carries both policies once each, /docs carries neither the Talk hosts nor the mic', () => {
  const text = emit(2, true);
  const home = trace(text, '/');
  assert.deepEqual(home.joined, []);
  assert.equal(home.headers['Content-Security-Policy'], CSP_PHASE1);
  const ro = home.headers['Content-Security-Policy-Report-Only'] ?? '';
  for (const origin of [...TALK_ORIGINS.convai, ...TALK_ORIGINS.livekit, ...TALK_ORIGINS.turnstile]) {
    assert.ok(ro.includes(origin), origin);
  }
  assert.match(home.headers['Permissions-Policy'] ?? '', /microphone=\(self\)/);
  assert.equal(home.headers['Reporting-Endpoints'], 'csp="/api/csp"');
  const docs = trace(text, '/docs').headers;
  assert.equal(docs['Content-Security-Policy-Report-Only'], undefined);
  assert.equal(docs['Content-Security-Policy'], CSP_PHASE1);
  assert.match(docs['Permissions-Policy'] ?? '', /microphone=\(\)/);
  assert.equal(/convai|livekit/.test(JSON.stringify(docs)), false);
});
