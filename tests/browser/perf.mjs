// Real-GPU frame rate of the hero being: serves apps/web/dist, opens / in Microsoft Edge on the D3D11 ANGLE backend
// at a few viewport sizes and device pixel ratios, and reports for each the WebGL renderer, the frames per second
// the page drew over a window after warm-up, and every quality event the being sent (em:quality: the first names the
// starting tier, any later one is a step down). A step down
// on a desktop viewport means the look is too heavy for this GPU: the visitor sees the coarser tier.
//
//   node tests/browser/perf.mjs [--seconds 12] [--headed]
import { chromium } from 'playwright-core';
import { parseArgs, ROOT } from './lib.mjs';
import { startStaticServer } from './static-serve.mjs';

const args = parseArgs();
const seconds = Number(args.seconds ?? 12);
const server = await startStaticServer({ dist: `${ROOT}/apps/web/dist`, port: 0 });
const browser = await chromium.launch({
  channel: 'msedge',
  headless: !args.flags.has('headed'),
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-sandbox'],
});

const CASES = [
  { width: 1440, height: 900, dpr: 1 },
  { width: 1320, height: 1144, dpr: 1 },
  { width: 1320, height: 1144, dpr: 1.5 },
  { width: 1920, height: 1080, dpr: 1 },
];

const rows = [];
let failed = false;
try {
  for (const c of CASES) {
    const ctx = await browser.newContext({
      viewport: { width: c.width, height: c.height },
      deviceScaleFactor: c.dpr,
      colorScheme: 'dark',
    });
    await ctx.addInitScript(() => {
      window.__steps = [];
      document.addEventListener('em:quality', (e) =>
        window.__steps.push(`${Math.round(performance.now())}ms:${e.detail}`),
      );
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${server.url}/`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForFunction(
      () => document.querySelector('[data-being-stage]')?.classList.contains('is-ready'),
      null,
      {
        timeout: 30000,
      },
    );
    // Warm-up: shaders compile, the intro plays.
    await page.waitForTimeout(4000);
    const result = await page.evaluate(async (ms) => {
      const g = document.createElement('canvas').getContext('webgl2');
      const d = g?.getExtension('WEBGL_debug_renderer_info');
      const renderer = d && g ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'no webgl2';
      let frames = 0;
      const start = performance.now();
      await new Promise((resolve) => {
        const tick = () => {
          frames += 1;
          if (performance.now() - start < ms) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const canvas = document.querySelector('[data-being-canvas]');
      return {
        renderer,
        fps: (frames * 1000) / (performance.now() - start),
        steps: window.__steps,
        buffer: canvas ? `${canvas.width}x${canvas.height}` : 'none',
      };
    }, seconds * 1000);
    // The first event announces the starting tier; any after it is a step down.
    const stepped = result.steps.length > 1;
    failed ||= stepped || errors.length > 0;
    rows.push(
      `${stepped ? 'FAIL' : 'PASS'}  ${c.width}x${c.height}@${c.dpr}  buffer ${result.buffer}  ${result.fps.toFixed(1)} fps  steps [${result.steps.join(', ')}]${errors.length ? `  errors ${errors.join('; ')}` : ''}`,
    );
    if (rows.length === 1) console.log(`GL renderer: ${result.renderer}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
for (const row of rows) console.log(row);
console.log(failed ? 'perf: FAIL' : 'perf: PASS');
process.exit(failed ? 1 : 0);
