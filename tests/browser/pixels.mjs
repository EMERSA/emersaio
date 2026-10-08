// Samples screen pixels of the built home page so a canvas that is not truly transparent, or a theme colour that
// drifted, shows up as a number rather than an impression. Serves apps/web/dist, renders / in Edge on the real GPU
// and compares, in both themes, the colour inside the hero far from the face (the stage's corners, outside the rim
// glow's radius of 0.75 head heights and clear of the fan's nodes, which sit down the right edge from 16% of the
// height) with the page's own --bg and with the page just below the hero. The hero is flat: no pool, beams, floor
// or gradient, so every corner must be the page's colour. A glow or a point that reaches a corner fails here by
// design. Each sample is the mean of a 5 x 5 patch.
//
//   node tests/browser/pixels.mjs            (exit 1 when a corner differs from --bg by more than 2 levels)
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { ROOT } from './lib.mjs';
import { startStaticServer } from './static-serve.mjs';

const TOLERANCE = 2;
/** Pixels in from a corner of the stage, and below the hero's edge, where the samples are taken. */
const INSET = 10;
const BELOW_HERO = 24;
const PATCH = 5;

/** Minimal PNG reader for 8-bit RGBA or RGB, non-interlaced, as Chromium writes screenshots. */
function decodePng(buffer) {
  const sig = '\x89PNG\r\n\x1a\n';
  if (buffer.toString('latin1', 0, 8) !== sig) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('only 8-bit PNGs');
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported');
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      const v = raw[pos + x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      row[x] = value & 0xff;
    }
    pos += stride;
  }
  return { width, height, channels, data: out };
}

/** The mean colour of the PATCH x PATCH pixels centred on (x, y), clamped to the image. */
const sample = (png, x, y) => {
  const half = PATCH >> 1;
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -half; dy <= half; dy += 1) {
    for (let dx = -half; dx <= half; dx += 1) {
      const px = Math.min(png.width - 1, Math.max(0, Math.round(x + dx)));
      const py = Math.min(png.height - 1, Math.max(0, Math.round(y + dy)));
      const i = (py * png.width + px) * png.channels;
      sum[0] += png.data[i];
      sum[1] += png.data[i + 1];
      sum[2] += png.data[i + 2];
      n += 1;
    }
  }
  return sum.map((v) => Math.round(v / n));
};
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const diff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
/** "#040918" or "rgb(4, 9, 24)" as [r, g, b]. */
const parseColour = (text) => {
  const hexMatch = text.trim().match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) return [0, 2, 4].map((i) => Number.parseInt(hexMatch[1].slice(i, i + 2), 16));
  const rgb = text.match(/\d+/g);
  return rgb ? rgb.slice(0, 3).map(Number) : null;
};

// A free port, and the promise resolves once the server listens: a stale server from an earlier run cannot answer.
const server = await startStaticServer({ dist: join(ROOT, 'apps', 'web', 'dist'), port: 0 });
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    const viewport = { width: 1440, height: 900 };
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: theme });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('em-theme', t);
      } catch {}
    }, theme);
    const page = await ctx.newPage();
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.waitForTimeout(5000);
    // Document coordinates: the page has not scrolled yet.
    const geometry = await page.evaluate(() => {
      const rect = (selector) => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, bottom: r.bottom };
      };
      return {
        stage: rect('[data-being-stage]'),
        hero: rect('[data-hero]'),
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg'),
      };
    });
    const { stage, hero } = geometry;
    const token = parseColour(geometry.bg);

    // The stage's corners, at rest, in the first screen. The head floats in the middle band of the stage and the
    // fan's nodes keep away from the corners (see the header), so each corner shows the flat page.
    const top = decodePng(await page.screenshot({ type: 'png' }));
    const corners = [
      ['top-left', stage.x + INSET, stage.y + INSET],
      ['top-right', stage.x + stage.w - INSET, stage.y + INSET],
      ['bottom-left', stage.x + INSET, stage.y + stage.h - INSET],
    ].filter(([, , y]) => y < viewport.height);
    const inside = corners.map(([name, x, y]) => [name, sample(top, x, y)]);

    // The page just below the hero, scrolled into view.
    const outsideDocY = hero.bottom + BELOW_HERO;
    const scrollTo = Math.max(0, Math.ceil(outsideDocY - viewport.height + 60));
    const scrolled = await page.evaluate((y) => {
      window.scrollTo({ top: y, behavior: 'instant' });
      return window.scrollY;
    }, scrollTo);
    await page.waitForTimeout(400);
    const below = decodePng(await page.screenshot({ type: 'png' }));
    const outside = sample(below, stage.x + INSET, outsideDocY - scrolled);

    const reference = token ?? outside;
    const worst = Math.max(diff(outside, reference), ...inside.map(([, rgb]) => diff(reference, rgb)));
    const ok = worst <= TOLERANCE;
    if (!ok) failed = true;
    const detail = inside.map(([name, rgb]) => `${name} ${hex(rgb)} (${diff(reference, rgb)})`).join(' | ');
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${theme}: --bg ${hex(reference)} | page below the hero ${hex(outside)} (${diff(outside, reference)}) | stage ${detail} | max diff ${worst} (stage ${Math.round(stage.w)}x${Math.round(stage.h)} at ${Math.round(stage.x)},${Math.round(stage.y)})`,
    );
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
