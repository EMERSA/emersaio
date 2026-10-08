/**
 * The contact form against a running Worker (wrangler dev): the page with and without JavaScript, then the
 * endpoint directly: a filled honeypot and a too-quick submission both get a fake success, missing fields get
 * 422 as JSON or a 303 to the error page as a form, and CSP reports get a 204 in both content types.
 *
 *   npx wrangler dev --port 8850            (in another terminal, after npm run build)
 *   node tests/browser/form-test.mjs 8850   (or --base https://127.0.0.1:8850 --insecure)
 */
import { launch, newPage, parseArgs, report, until, withBase } from './lib.mjs';

const args = parseArgs();
const { base } = await withBase(args);
const insecure = args.flags.has('insecure') || base.startsWith('https://127.0.0.1');
if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const rows = [];
const check = (name, ok, detail) => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);

const FIELDS = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines Ltd',
  topic: 'emily',
  message: 'We would like to see Emily walk a team through a change procedure.',
};

/** A direct POST, the way a browser on the site would send it (Origin and Sec-Fetch-Site named). */
async function post(path, fields, { json = true, contentType, raw } = {}) {
  const headers = {
    'content-type': contentType ?? 'application/x-www-form-urlencoded',
    accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
    origin: base,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': json ? 'cors' : 'navigate',
  };
  const body = raw ?? new URLSearchParams(fields).toString();
  let res = await fetch(base + path, { method: 'POST', headers, body, redirect: 'manual' });
  // wrangler dev simulates the CONTACT_LIMITER (5 posts a minute from one connection); this script sends more
  // than that, so one 429 is waited out, the way a patient visitor would, and the request is sent again.
  if (res.status === 429) {
    const wait = Math.min(70, Math.max(1, Number(res.headers.get('retry-after')) || 60));
    console.log(`  (429 from ${path}: the limiter is on; waiting ${wait} s before retrying)`);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    res = await fetch(base + path, { method: 'POST', headers, body, redirect: 'manual' });
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  return { status: res.status, location: res.headers.get('location') ?? '', data, text };
}

const past = () => String(Date.now() - 10_000);

/** Set when the Worker says the form is not connected (no POSTMARK_TOKEN): every later answer is then an error page. */
let notConnected = false;

// 1. The page, scripts on: the form submits in place and shows the sent or the error state.
const browser = await launch(insecure ? ['--ignore-certificate-errors'] : []);
try {
  for (const javaScriptEnabled of [true, false]) {
    const label = `contact page, scripts ${javaScriptEnabled ? 'on' : 'off'}`;
    const { ctx, page } = await newPage(browser, { width: 1280, height: 1000, javaScriptEnabled });
    try {
      await page.goto(`${base}/contact`, { waitUntil: 'load', timeout: 60000 });
      const form = page.locator('[data-contact-form]').first();
      if (!(await form.count())) {
        check(label, false, 'no [data-contact-form] on /contact');
        continue;
      }
      for (const [name, value] of Object.entries(FIELDS)) {
        const field = form.locator(`[name="${name}"]`).first();
        if (!(await field.count())) continue;
        const tag = await field.evaluate((el) => el.tagName.toLowerCase());
        if (tag === 'select') await field.selectOption(value).catch(() => {});
        else await field.fill(value);
      }
      // The Worker treats anything filled in under 2.5 s as a bot.
      await page.waitForTimeout(3000);
      const responsePromise = page
        .waitForResponse((r) => r.url().includes('/api/contact'), { timeout: 15000 })
        .catch(() => null);
      await form.locator('button[type="submit"], input[type="submit"]').first().click();
      const response = await responsePromise;
      const status = response?.status() ?? 0;
      if (javaScriptEnabled) {
        if (status === 503) notConnected = true;
        const state = await until(
          async () => {
            // Contact.astro reveals [data-contact-done] on success and writes the Worker's sentence (or the
            // site's fallback) into [data-contact-status] on failure.
            const sent = await page
              .locator('[data-contact-done], [data-contact-sent], [data-contact-form] [data-sent]')
              .first()
              .isVisible()
              .catch(() => false);
            const statusLine = page.locator('[data-contact-status]').first();
            const failed =
              (await statusLine.isVisible().catch(() => false)) &&
              ((await statusLine.textContent().catch(() => '')) ?? '').trim() !== '';
            const text = await page
              .locator('body')
              .innerText()
              .catch(() => '');
            if (sent || /Thank you\./.test(text) || /\/contact\/sent/.test(page.url())) return 'sent';
            if (failed || /That did not send\./.test(text) || /\/contact\/error/.test(page.url())) return 'error';
            return '';
          },
          { timeout: 10000 },
        );
        const ok = state === 'sent' || (state === 'error' && status === 503);
        check(
          label,
          ok,
          `POST ${status}, page shows ${state || 'nothing'}${status === 503 ? ' (503: no POSTMARK_TOKEN locally, the wording path)' : ''}`,
        );
      } else {
        await page.waitForURL(/\/contact\/(sent|error)/, { timeout: 15000 }).catch(() => {});
        const landed = page.url().match(/\/contact\/(sent|error)/)?.[1] ?? '';
        // Without scripts the Worker answers 303 whatever happened, so a 503 behind it is known only from the run above.
        const ok = landed === 'sent' || (landed === 'error' && (status === 503 || notConnected));
        check(
          label,
          ok,
          landed ? `redirected to /contact/${landed} (POST ${status})` : `stayed on ${page.url()} (POST ${status})`,
        );
      }
    } catch (error) {
      check(label, false, `threw: ${String(error.message ?? error).slice(0, 160)}`);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}

// 2. The endpoint directly.
{
  const r = await post('/api/contact', { ...FIELDS, website: 'https://spam.example', started: past() });
  check(
    'honeypot filled -> fake success',
    r.status === 200 && r.data?.ok === true,
    `${r.status} ${r.text.slice(0, 80)}`,
  );
}
{
  const r = await post('/api/contact', { ...FIELDS, started: String(Date.now()) });
  check(
    'submitted too fast -> fake success',
    r.status === 200 && r.data?.ok === true,
    `${r.status} ${r.text.slice(0, 80)}`,
  );
}
{
  const r = await post('/api/contact', { name: 'Only a name', started: past() });
  check('missing fields as JSON -> 422', r.status === 422, `${r.status} ${r.text.slice(0, 80)}`);
}
{
  const r = await post('/api/contact', { name: 'Only a name', started: past() }, { json: false });
  check(
    'missing fields as a form -> 303 to /contact/error',
    r.status === 303 && /\/contact\/error$/.test(r.location),
    `${r.status} ${r.location}`,
  );
}
{
  const r = await post('/api/contact', { ...FIELDS, started: past() });
  const ok =
    r.status === 200 || (r.status === 503 && typeof r.data?.error === 'string' && /@emersa\.io/.test(r.data.error));
  check(
    'valid submission -> 200, or 503 naming an inbox when Postmark is not configured',
    ok,
    `${r.status} ${r.text.slice(0, 100)}`,
  );
}
{
  const report = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://emersa.io/',
      'violated-directive': 'script-src',
      'blocked-uri': 'https://evil.example',
      disposition: 'enforce',
    },
  });
  const r = await post('/api/csp', null, { contentType: 'application/csp-report', raw: report });
  check('CSP report (application/csp-report) -> 204', r.status === 204, `${r.status}`);
}
{
  const report = JSON.stringify([
    {
      type: 'csp-violation',
      url: 'https://emersa.io/',
      body: { effectiveDirective: 'script-src', blockedURL: 'https://evil.example', disposition: 'enforce' },
    },
  ]);
  const r = await post('/api/csp', null, { contentType: 'application/reports+json', raw: report });
  check('CSP report (application/reports+json) -> 204', r.status === 204, `${r.status}`);
}
{
  const r = await fetch(`${base}/api/nope`);
  const type = r.headers.get('content-type') ?? '';
  check('unknown /api route -> JSON 404', r.status === 404 && /json/.test(type), `${r.status} ${type}`);
}

process.exit(report(`contact form against ${base}`, rows) ? 1 : 0);
