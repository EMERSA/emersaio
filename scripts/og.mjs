#!/usr/bin/env node
/**
 * Renders the social card, apps/web/public/og.png (1200 x 630), with the installed Microsoft Edge. A manual step:
 * run it when the wordmark, tagline or palette changes, then commit the PNG.
 *
 *   node scripts/og.mjs [--out <path>]
 *
 * The card is built from the same sources as the site: the tagline from src/data/site.ts, the dark palette from
 * src/styles/tokens.css, the mark from src/assets/logo/emersa-mark.svg and the Marcellus and Inter faces the site
 * ships. Like the hero: flat navy, the EMERSA wordmark and the tagline in tracked Marcellus caps, one azure rim
 * glow, and orange only on the mark. If apps/web/src/assets/og.html exists it is rendered instead, so the web
 * engineer can own the design without touching this script.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps', 'web');
const outIndex = process.argv.indexOf('--out');
const out = resolve(outIndex === -1 ? join(web, 'public', 'og.png') : process.argv[outIndex + 1]);
const template = join(web, 'src', 'assets', 'og.html');

const WIDTH = 1200;
const HEIGHT = 630;

/** Dark-theme custom properties from tokens.css, so the card follows the palette without a second copy of it. */
function tokens() {
  const css = readFileSync(join(web, 'src', 'styles', 'tokens.css'), 'utf8');
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const read = (name, fallback) => rootBlock.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim() ?? fallback;
  return {
    bg: read('--bg', 'black'),
    ink: read('--ink', 'white'),
    muted: read('--ink-muted', 'silver'),
    orange: read('--orange', 'orange'),
    rim: read('--rim', 'blue'),
    line: read('--line-2', 'grey'),
  };
}

function copy() {
  const site = readFileSync(join(web, 'src', 'data', 'site.ts'), 'utf8');
  return {
    name: site.match(/name:\s*'([^']+)'/)?.[1] ?? 'Emersa Labs',
    shortName: site.match(/shortName:\s*'([^']+)'/)?.[1] ?? 'Emersa',
    tagline: site.match(/tagline:\s*'([^']+)'/)?.[1] ?? 'We make synthetic beings.',
    eyebrow: site.match(/eyebrow:\s*'([^']+)'/)?.[1] ?? 'London, since 2023',
  };
}

/** The site's own font files, inlined so the card needs no server. */
const font = (file) => {
  const path = join(web, 'src', 'assets', 'fonts', file);
  return `url(data:font/woff2;base64,${readFileSync(path).toString('base64')}) format('woff2')`;
};

/** The mark's geometry, filled in the orange: the one orange on the card. */
function mark(size, colour) {
  const svg = readFileSync(join(web, 'src', 'assets', 'logo', 'emersa-mark.svg'), 'utf8');
  return svg
    .replace(/fill="currentColor"/, `fill="${colour}" width="${size}" height="${size}"`)
    .replace(/<svg /, '<svg aria-hidden="true" ');
}

function builtInHtml() {
  const t = tokens();
  const c = copy();
  const [r, g, b] = (t.rim.match(/[0-9a-f]{2}/gi) ?? ['28', '96', 'dd']).map((h) => Number.parseInt(h, 16));
  const glow = `rgba(${r}, ${g}, ${b}, 0.22)`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>og</title>
<style>
@font-face { font-family: 'Marcellus'; font-weight: 400; src: ${font('marcellus-latin-400.woff2')}; }
@font-face { font-family: 'Inter'; font-weight: 400 600; src: ${font('inter-latin-wght-400-600.woff2')}; }
html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
body { background: ${t.bg}; color: ${t.ink}; font-family: 'Inter', sans-serif; }
.card { position: relative; box-sizing: border-box; width: ${WIDTH}px; height: ${HEIGHT}px; padding: 64px 80px; display: flex; flex-direction: column; justify-content: space-between; }
.rim { position: absolute; right: 120px; top: 50%; width: 560px; height: 560px; margin-top: -280px; border-radius: 50%; background: radial-gradient(closest-side, ${glow}, transparent 100%); }
.brand { position: relative; display: flex; align-items: center; gap: 16px; }
.brand svg { display: block; }
.wordmark { font-family: 'Marcellus', serif; font-size: 24px; letter-spacing: 0.32em; text-transform: uppercase; }
.eyebrow { position: relative; font-size: 18px; font-weight: 500; letter-spacing: 0.22em; text-transform: uppercase; color: ${t.muted}; margin: 0 0 24px; }
h1 { position: relative; font-family: 'Marcellus', serif; font-weight: 400; font-size: 88px; line-height: 1.04; letter-spacing: 0.08em; text-transform: uppercase; margin: 0; max-width: 820px; }
.foot { position: relative; display: flex; justify-content: space-between; padding-top: 24px; border-top: 1px solid ${t.line}; font-size: 20px; color: ${t.muted}; }
</style></head>
<body><div class="card"><div class="rim"></div>
<div class="brand">${mark(40, t.orange)}<span class="wordmark">${c.shortName}</span></div>
<div><p class="eyebrow">${c.eyebrow}</p><h1>${c.tagline}</h1></div>
<div class="foot"><span>${c.name}</span><span>emersa.io</span></div>
</div></body></html>`;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  if (existsSync(template)) {
    await page.goto(pathToFileURL(template).href, { waitUntil: 'load' });
    console.log(`og: rendering ${template}`);
  } else {
    await page.setContent(builtInHtml(), { waitUntil: 'load' });
    console.log('og: rendering the built-in card (apps/web/src/assets/og.html not present)');
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(100);
  mkdirSync(dirname(out), { recursive: true });
  await page.screenshot({ path: out, type: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT } });
  console.log(`og: wrote ${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
} finally {
  await browser.close();
}
