// Real-GPU look at the built site: serves apps/web/dist in-process, opens pages in Microsoft Edge with the
// D3D11 ANGLE backend (no swiftshader), records console/CSP errors, WebGL renderer string, screenshots over time,
// runs the tour for two stops, and full-page captures of every page in both themes.
//
//   node tests/browser/gpu-look.mjs [outDir] [--headed]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { ROOT } from './lib.mjs';
import { startStaticServer } from './static-serve.mjs';

const OUT = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || join(ROOT, 'tests', 'browser', 'out', 'gpu');
const headed = process.argv.includes('--headed');
mkdirSync(OUT, { recursive: true });

// A free port, and the promise resolves once the server listens: a stale server from an earlier run cannot answer.
const server = await startStaticServer({ dist: join(ROOT, 'apps', 'web', 'dist'), port: 0 });

const browser = await chromium.launch({
  channel: 'msedge',
  headless: !headed,
  args: [
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-webgl',
    '--disable-gpu-sandbox',
  ],
});
const log = [];
const shot = async (page, name, opts = {}) => {
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  log.push(`shot ${name}`);
};
const open = async (path, { width, height, theme }) => {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('em-theme', t);
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning')
      log.push(`console.${m.type()} ${path} ${theme}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => log.push(`pageerror ${path}: ${String(e).slice(0, 300)}`));
  await page.goto(`${server.url}${path}`, { waitUntil: 'load', timeout: 60000 });
  return { ctx, page };
};

/**
 * Walk the page so every reveal has fired before a full capture, the way a reader would see it. The site scrolls
 * smoothly, so each step is an instant jump (a smooth scroll would be interrupted by the next call and never
 * reach the bottom), and the walk ends only once no [data-reveal] is still pending.
 */
const revealAll = async (page, label) => {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.7;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  });
  const settled = await page
    .waitForFunction(() => !document.querySelector('[data-reveal].is-pending'), null, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!settled) log.push(`${label}: some [data-reveal] sections are still pending after the walk`);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(900);
};

try {
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open('/', { width: 1440, height: 900, theme });
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      const d = g?.getExtension('WEBGL_debug_renderer_info');
      return d && g ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no webgl2';
    });
    log.push(`${theme}: GL renderer = ${gl}`);
    await page.waitForTimeout(1500);
    await shot(page, `home-${theme}-1440-t1`);
    await page.waitForTimeout(3500);
    const state = await page.evaluate(() => ({
      stageReady: !!document.querySelector('[data-being-stage].is-ready'),
      heroReady: !!document.querySelector(
        '.is-ready [data-hero-canvas], [data-hero-canvas].is-ready, [data-hero].is-ready',
      ),
      heroCanvasOpacity: getComputedStyle(document.querySelector('[data-hero-canvas]')).opacity,
      beingCanvasOpacity: getComputedStyle(document.querySelector('[data-being-canvas]')).opacity,
      hud: document.querySelector('[data-hud]')?.textContent?.replace(/\s+/g, ' ').trim(),
    }));
    log.push(`${theme}: state after 5s ${JSON.stringify(state)}`);
    await shot(page, `home-${theme}-1440-t5`);
    await revealAll(page, `home ${theme} 1440`);
    await shot(page, `home-${theme}-1440-full`, { fullPage: true });
    // the tour
    const start = page.locator('[data-tour-start]').first();
    if (await start.count()) {
      await start.click();
      await page.waitForTimeout(2500);
      await shot(page, `tour-${theme}-stop1`);
      const cap1 = await page.evaluate(() => document.querySelector('[data-captions]')?.textContent?.trim());
      const next = page.locator('[data-tour-next]').first();
      if (await next.count()) {
        await next.click();
        await page.waitForTimeout(2500);
      }
      await shot(page, `tour-${theme}-stop2`);
      const cap2 = await page.evaluate(() => document.querySelector('[data-captions]')?.textContent?.trim());
      const bar = await page.evaluate(() =>
        document.querySelector('[data-tour]')?.textContent?.replace(/\s+/g, ' ').trim(),
      );
      log.push(
        `${theme}: captions1="${(cap1 || '').slice(0, 80)}" captions2="${(cap2 || '').slice(0, 80)}" bar="${bar}"`,
      );
    } else log.push(`${theme}: no [data-tour-start]`);
    await ctx.close();
  }
  for (const [path, name] of [
    ['/docs', 'docs'],
    ['/docs/what-is-a-synthetic-being', 'doc-page'],
    ['/games', 'games'],
    ['/contact', 'contact'],
    ['/privacy', 'privacy'],
    ['/nope', '404'],
  ]) {
    for (const theme of ['dark', 'light']) {
      const { ctx, page } = await open(path, { width: 1440, height: 900, theme });
      await page.waitForTimeout(800);
      await revealAll(page, `${name} ${theme} 1440`);
      await shot(page, `${name}-${theme}-full`, { fullPage: true });
      await ctx.close();
    }
  }
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open('/', { width: 390, height: 844, theme });
    await page.waitForTimeout(2500);
    await revealAll(page, `home ${theme} 390`);
    await shot(page, `home-${theme}-390-full`, { fullPage: true });
    await page
      .locator('[data-tour-start]')
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(3000);
    await shot(page, `home-${theme}-390-tour`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(log.join('\n'));
