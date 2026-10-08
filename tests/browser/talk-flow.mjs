/**
 * Talk to Emily (Phase 2) against a running Worker: the consent sheet, Turnstile with Cloudflare's always-pass test
 * keys, the session mint against a mocked Convai, the visitor cookie, a typed turn posted to memory, the memory
 * read, and Forget me clearing it all. The voice itself is not exercised: Convai and LiveKit requests from the
 * page are aborted, so the test proves the shell and the Worker contract, not the SDK.
 *
 * Setup (three terminals, or background jobs that are stopped afterwards):
 *   SITE_PHASE=2 PUBLIC_TURNSTILE_SITEKEY=1x00000000000000000000AA npm run build
 *   node tests/browser/talk-flow.mjs --mock 8851          (starts the mock Convai on 8851 and waits)
 *   npx wrangler dev --port 8850 --var CONVAI_API_BASE:http://127.0.0.1:8851 --var TURNSTILE_SITEKEY:1x00000000000000000000AA
 *     with .dev.vars holding TURNSTILE_SECRET=1x0000000000000000000000000000000AA, CONVAI_API_KEY=test,
 *     VISITOR_HMAC_KEY=<hex> and a migrated local D1 (npx wrangler d1 migrations apply emersa-memory --local)
 *   node tests/browser/talk-flow.mjs 8850 --mock-port 8851
 * Without --mock-port the mock is started in this process on a free port and its URL printed; wrangler dev must
 * then point CONVAI_API_BASE at it.
 */
import { createServer } from 'node:http';
import { launch, newPage, parseArgs, report, withBase } from './lib.mjs';

const args = parseArgs();
const rows = [];
const check = (name, ok, detail = '') => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);

/** The Convai endpoints the Worker calls, answered the way the real API does (fact sheet A.5). */
function startMock(port) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      calls.push({ path: req.url, key: req.headers['convai-api-key'], body });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/user/connect') {
        res.end(JSON.stringify({ apiAuthToken: 'mock-token-123', expiresIn: 3600 }));
        return;
      }
      res.end('{}');
    });
  });
  return new Promise((resolve) =>
    server.listen(Number(port) || 0, '127.0.0.1', () =>
      resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

if (args.mock) {
  const mock = await startMock(args.mock);
  console.log(`mock Convai on ${mock.url}; Ctrl+C to stop`);
  process.on('SIGINT', () => mock.server.close(() => process.exit(0)));
} else {
  const { base, close } = await withBase(args);
  const mock = args['mock-port'] ? null : await startMock(0);
  if (mock) console.log(`mock Convai on ${mock.url} (wrangler dev needs CONVAI_API_BASE pointed here)`);
  const browser = await launch();
  try {
    const { ctx, page } = await newPage(browser, { width: 1280, height: 1000 });
    // The voice is out of scope: no request leaves for Convai or LiveKit from the page.
    await ctx.route(/convai\.com|livekit\.cloud/, (route) => route.abort());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    const talkBytes = [];
    page.on('request', (r) => {
      if (/challenges\.cloudflare\.com|\/api\/talk|convai/.test(r.url())) talkBytes.push(r.url());
    });
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    check('no talk bytes before the tap', talkBytes.length === 0, talkBytes.join(' '));

    const cta = page.locator('.hero-ctas [data-talk-open]');
    check('Talk CTA visible on /', await cta.isVisible());
    check('header Talk link on /', (await page.locator('header [data-talk-open]').count()) === 1);
    await cta.click();
    const sheet = page.locator('[data-talk-sheet]');
    await sheet.waitFor({ state: 'visible', timeout: 5000 });
    const consent = (await page.locator('[data-talk-consent]').textContent()) ?? '';
    for (const phrase of [
      'Convai Technologies',
      'Cloudflare',
      'Microsoft',
      '12 months',
      'type instead',
      'Emily is an AI',
    ]) {
      check(`consent mentions ${phrase}`, consent.includes(phrase));
    }
    await page
      .waitForRequest(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/, { timeout: 10000 })
      .catch(() => null);
    check(
      'Turnstile loaded after opening',
      talkBytes.some((u) => u.includes('challenges.cloudflare.com')),
    );

    const minted = page.waitForResponse((r) => r.url().endsWith('/api/talk/session'), { timeout: 30000 });
    await page.locator('[data-talk-start]').click();
    const session = await minted.catch(() => null);
    const grant = session ? await session.json().catch(() => null) : null;
    check('session minted', session?.status() === 200 && grant?.ok === true, `status ${session?.status()}`);
    check('grant carries the mocked token', grant?.token === 'mock-token-123');
    check('grant names a character and an opaque endUserId', Boolean(grant?.characterId && grant?.endUserId));
    if (mock)
      check(
        'Worker sent CONVAI-API-KEY to /user/connect',
        mock.calls.some((c) => c.path === '/user/connect' && c.key),
      );

    const cookies = await ctx.cookies(`${base}/api/`);
    const vid = cookies.find((c) => c.name === 'em_vid');
    check(
      'em_vid set HttpOnly, SameSite=Lax, Path=/api',
      Boolean(vid?.httpOnly && vid.sameSite === 'Lax' && vid.path === '/api'),
    );

    const api = (path, init) =>
      page.evaluate(
        async ([p, i]) => {
          const r = await fetch(p, { credentials: 'same-origin', ...i });
          const text = await r.text();
          return { status: r.status, text };
        },
        [path, init],
      );
    const turn = await api('/api/memory/turns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'user', text: 'Hello Emily, my name is Ada.' }),
    });
    check('typed turn posted to memory', turn.status >= 200 && turn.status < 300, `status ${turn.status}`);
    const memory = await api('/api/memory');
    check('GET memory returns the turn', memory.status === 200 && memory.text.includes('my name is Ada'));
    const forget = await api('/api/memory', { method: 'DELETE' });
    check('DELETE memory answers 204', forget.status === 204, `status ${forget.status}`);
    const after = await api('/api/memory');
    check('memory empty after Forget me', !after.text.includes('my name is Ada'), `status ${after.status}`);
    const left = (await ctx.cookies(`${base}/api/`)).find((c) => c.name === 'em_vid');
    check('cookie cleared', !left);
    check('no page errors', errors.length === 0, errors.join('; '));
    await ctx.close();
  } finally {
    await browser.close();
    mock?.server.close();
    await close();
  }
  process.exit(report('talk-flow', rows) ? 1 : 0);
}
