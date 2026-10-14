/**
 * The zero-knowledge QR code generator on "/": nothing of the encoder loads before the card is touched; typing a URL
 * draws a code on the canvas (dark pixels present); the PNG and SVG links are data: URLs; Wipe empties the field,
 * clears the canvas and says so; and the only requests the card makes are its own chunks (no /api, nothing
 * off-site). The colour inputs are filled from the tokens, so neither carries the browser's black default.
 *
 *   node tests/browser/qr-smoke.mjs [--base <url>]
 */
import { join } from 'node:path';
import { launch, newPage, outDir, parseArgs, report, until, withBase } from './lib.mjs';

const args = parseArgs();
const { base, close } = await withBase(args);
const browser = await launch();
const shots = outDir();
const rows = [];
/** The built CSS may shorten #ffffff to #fff; a colour input always reports the long form. */
const hex = (value) =>
  (/^#[0-9a-f]{3}$/i.test(value) ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value).toLowerCase();
const check = (name, ok, detail) => rows.push([name, ok ? 'PASS' : 'FAIL', detail]);
const QR_CHUNK = /\/_astro\/qr(?:code)?[.-]/;

/** Counts the dark pixels of the preview canvas: a drawn code has thousands, a cleared one none. */
const darkPixels = () =>
  document.fonts.ready.then(() => {
    const canvas = document.querySelector('[data-qr-canvas]');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 0 && data[i] + data[i + 1] + data[i + 2] < 384) dark++;
    return dark;
  });

try {
  const { ctx, page } = await newPage(browser, { width: 1280, height: 900, theme: 'dark' });
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('request', (r) => requests.push(new URL(r.url())));
  try {
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(1500);
    const earlyQr = requests.filter((u) => QR_CHUNK.test(u.pathname)).map((u) => u.pathname);
    check('no qr chunk before an interaction', earlyQr.length === 0, earlyQr.join(', ') || 'nothing requested');

    const colours = await page.evaluate(() => {
      const tokens = getComputedStyle(document.documentElement);
      const value = (which) => document.querySelector(`[data-qr-color="${which}"]`)?.value ?? '';
      return {
        fg: value('fg'),
        bg: value('bg'),
        tokenFg: tokens.getPropertyValue('--qr-fg').trim(),
        tokenBg: tokens.getPropertyValue('--qr-bg').trim(),
      };
    });
    check(
      'colour inputs carry the tokens',
      hex(colours.fg) === hex(colours.tokenFg) && hex(colours.bg) === hex(colours.tokenBg) && colours.fg !== '',
      `fg=${colours.fg} bg=${colours.bg} (tokens ${colours.tokenFg} ${colours.tokenBg})`,
    );

    const url = page.locator('[data-qr-field="url"]');
    await url.scrollIntoViewIfNeeded();
    await url.click();
    await url.fill('https://emersa.io/docs');
    const drawn = await until(
      async () => {
        const n = await page.evaluate(darkPixels);
        return n > 500 ? n : 0;
      },
      { timeout: 10000 },
    );
    check('canvas has drawn pixels after typing a URL', drawn > 500, `${drawn} dark pixels`);
    const status = ((await page.locator('[data-qr-status]').textContent()) ?? '').trim();
    check(
      'status reports the encoded characters',
      /^Ready\. \d+ characters encoded and nothing left your device\.$/.test(status),
      `"${status}"`,
    );
    const links = await page.evaluate(() => ({
      png: document.querySelector('[data-qr-png]')?.getAttribute('href') ?? '',
      svg: document.querySelector('[data-qr-svg]')?.getAttribute('href') ?? '',
      disabled: [
        document.querySelector('[data-qr-png]')?.getAttribute('aria-disabled'),
        document.querySelector('[data-qr-svg]')?.getAttribute('aria-disabled'),
      ],
    }));
    check(
      'PNG and SVG downloads are data: URLs',
      links.png.startsWith('data:image/png') &&
        links.svg.startsWith('data:image/svg+xml') &&
        links.disabled.every((d) => d === 'false'),
      `png=${links.png.slice(0, 22)} svg=${links.svg.slice(0, 26)}`,
    );
    await page.screenshot({ path: join(shots, 'qr-ready.png') });

    await page.locator('[data-qr-wipe]').click();
    const wiped = await until(
      async () =>
        (((await page.locator('[data-qr-status]').textContent()) ?? '').trim() === 'Wiped. Nothing was ever stored.' &&
          (await url.inputValue()) === '' &&
          (await page.evaluate(darkPixels)) === 0) ||
        false,
      { timeout: 5000 },
    );
    check(
      'Wipe clears the field, the canvas and says so',
      wiped,
      wiped ? 'field empty, canvas blank, status "Wiped. Nothing was ever stored."' : 'not all cleared',
    );
    const after = await page.evaluate(() => ({
      png: document.querySelector('[data-qr-png]')?.hasAttribute('href'),
      svg: document.querySelector('[data-qr-svg]')?.hasAttribute('href'),
    }));
    check('downloads disabled after Wipe', !after.png && !after.svg, JSON.stringify(after));

    const qrChunks = requests.filter((u) => QR_CHUNK.test(u.pathname)).map((u) => u.pathname);
    check('qr chunks loaded after the interaction', qrChunks.length > 0, qrChunks.join(', ') || 'none');
    const origin = new URL(base).origin;
    const foreign = requests
      .filter((u) => u.origin !== origin || u.pathname.startsWith('/api/'))
      .map((u) => u.href)
      .filter((href) => !/fonts\.(googleapis|gstatic)\.com/.test(href));
    check('no network request beyond the site itself', foreign.length === 0, foreign.slice(0, 3).join(', ') || 'none');
    check('no page errors', errors.length === 0, errors[0]?.slice(0, 160) ?? 'none');
  } catch (error) {
    check('qr smoke', false, `threw: ${String(error.message ?? error).slice(0, 160)}`);
  } finally {
    await ctx.close();
  }

  // Without JavaScript the form shows with its note and no canvas content is expected.
  {
    const { ctx: noJs, page } = await newPage(browser, {
      width: 1280,
      height: 900,
      theme: 'dark',
      javaScriptEnabled: false,
    });
    try {
      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
      const state = await page.evaluate(() => ({
        form: Boolean(document.querySelector('[data-qr-form]')),
        note: (document.querySelector('#qr noscript')?.textContent ?? '').includes('JavaScript'),
      }));
      check('without JavaScript the form and the note show', state.form && state.note, JSON.stringify(state));
    } catch (error) {
      check(
        'without JavaScript the form and the note show',
        false,
        `threw: ${String(error.message ?? error).slice(0, 160)}`,
      );
    } finally {
      await noJs.close();
    }
  }
} finally {
  await browser.close();
  await close();
}

process.exit(report(`qr smoke against ${base}`, rows) ? 1 : 0);
