/**
 * The built site in headless Edge at three widths and both themes: no console errors, no CSP violations (the
 * static server applies dist/_headers), the <h1> as the LCP element on "/" (in Marcellus, uppercase, tracked
 * 0.08em, at least 44px), exactly two font files before the LCP (Marcellus and Inter, 40 KB or less together), no
 * computed backdrop-filter or background-clip: text anywhere, none of the removed ornament classes in the DOM,
 * only the four border radii (8px, 16px, 999px, 50%), no /api/* request before the being mounts, no horizontal
 * overflow, the stored theme applied, the being actually drawing on "/" (is-ready, not the poster fallback) once
 * it mounts, the hero cloud drawing on a touch device with three.js still unrequested before any tap, and the
 * menu opening at 390 px with JavaScript off.
 *
 *   node tests/browser/metrics.mjs                 (serves apps/web/dist itself)
 *   node tests/browser/metrics.mjs --base http://127.0.0.1:8850   (a running Worker)
 */
import { join } from 'node:path';
import { launch, newPage, outDir, parseArgs, report, THEMES, until, withBase } from './lib.mjs';

const args = parseArgs();
/** --pages /,/docs and --widths 390 narrow a local run; without them these three pages run at every width, as in CI. */
const PAGES = args.pages ? args.pages.split(',') : ['/', '/docs', '/contact'];
const WIDTHS = args.widths ? args.widths.split(',').map(Number) : [390, 1024, 1440];
const SETTLE_MS = 2500;
/**
 * How long the being may take to mount on "/": LCP, then idle, then the three.js chunk, the figure and the first
 * frame, all on a software renderer in CI. The wait ends as soon as the stage reports is-ready or is-fallback.
 */
const MOUNT_TIMEOUT_MS = 25000;
/** The hero cloud on a touch device: LCP, idle, the cloud chunk and its first frame. */
const HERO_TIMEOUT_MS = 15000;
/** Font bytes before the LCP: the brief's ceiling (the Lighthouse budget is 75 KB). */
const FONT_BYTES_MAX = 40 * 1024;
const FONT_FILES = [/marcellus-latin-400/, /inter-latin-wght-400-600/];
/** Classes of the ornaments the minimal brief removed; none may be in any page. */
const FORBIDDEN = [
  '.grain',
  '.leak',
  '.sweep',
  '.metal',
  '.glass',
  '.triangle-divider',
  '.hud-plate',
  '.footer-giant',
  '.being-beam',
  '.being-pool',
  '.being-floor',
  '.being-rim',
  '.hero-scroll',
  '.chrome-text',
];
/** What may only load after the visitor taps Talk: the lazy talk chunks, the SDK, its transports and Turnstile. */
const TALK_BYTES = /convai|livekit|challenges\.cloudflare\.com|\/_astro\/talk[.-]|\/api\/(talk|memory|brain)/i;
/** The renderer's chunk, which a touch device must not request before a tap (CONVENTIONS, Performance). */
const THREE_CHUNK = /\/_astro\/three\./;
const RADII = ['0px', '8px', '16px', '999px', '50%'];
/** Slack between the page's own clock stamp of the mount and the request event reaching Node. */
const MOUNT_SLACK_MS = 250;

/** Runs before any page script: collects CSP violations, the LCP entry, the being's mount and the hero's first frame. */
const instrument = () => {
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
  });
  window.__lcp = null;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const el = entry.element;
        window.__lcp = { tag: el ? el.tagName : null, at: Math.round(entry.startTime) };
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}
  window.__loadedAt = null;
  addEventListener('load', () => {
    window.__loadedAt = Date.now();
  });
  // The being's mount, and whether it drew (is-ready) or gave up on the poster (is-fallback); the hero's first frame.
  window.__beingMount = null;
  window.__heroReadyAt = null;
  const check = () => {
    if (!window.__beingMount) {
      if (document.querySelector('[data-being-stage].is-ready'))
        window.__beingMount = { at: Date.now(), kind: 'ready' };
      else if (document.querySelector('[data-being-stage].is-fallback'))
        window.__beingMount = { at: Date.now(), kind: 'fallback' };
    }
    if (!window.__heroReadyAt && document.querySelector('[data-hero].is-ready')) window.__heroReadyAt = Date.now();
  };
  new MutationObserver(check).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
};

/** Resolves once the stage has reported, or at once on a page without one; false when the wait ran out. */
const waitForMount = (page) =>
  until(() => page.evaluate(() => Boolean(window.__beingMount) || !document.querySelector('[data-being-stage]')), {
    timeout: MOUNT_TIMEOUT_MS,
    interval: 250,
  });

const { base, close } = await withBase(args);
const browser = await launch();
const shots = outDir();
const rows = [];

try {
  for (const path of PAGES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const label = `${path} ${theme} ${width}`;
        const { ctx, page } = await newPage(browser, { width, theme });
        await ctx.addInitScript(instrument);
        const errors = [];
        const apiRequests = [];
        /** Phase 2: nothing of Talk (the talk chunk, Convai, LiveKit, Turnstile, /api/talk) before a tap. */
        const talkRequests = [];
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const url = m.location()?.url ?? '';
          // Chromium asks for /favicon.ico by itself on a page with no icon link; that is not the page's error.
          if (/\/favicon\.ico$/.test(url) && /404/.test(m.text())) return;
          errors.push(`${m.text()}${url ? ` (${url})` : ''}`);
        });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('request', (r) => {
          const url = new URL(r.url());
          if (url.pathname.startsWith('/api/')) apiRequests.push({ path: url.pathname, at: Date.now() });
          if (TALK_BYTES.test(url.href)) talkRequests.push(url.href);
        });
        const issues = [];
        try {
          const response = await page.goto(base + path, { waitUntil: 'load', timeout: 60000 });
          if (response?.status() !== 200) issues.push(`status ${response?.status() ?? 'none'}`);
          // The being mounts after LCP and idle in its own time; the checks below read the page once it has, or
          // once the wait ran out, then settle for the LCP entry and the fonts.
          const mounted = await waitForMount(page);
          await page.waitForTimeout(mounted ? 500 : SETTLE_MS);
          const m = await page.evaluate(
            ({ forbidden, radii }) => {
              const h1 = document.querySelector('h1');
              const h1cs = h1 ? getComputedStyle(h1) : null;
              const h1size = h1cs ? Number.parseFloat(h1cs.fontSize) : 0;
              const h1lines =
                h1 && h1cs ? Math.round(h1.getBoundingClientRect().height / Number.parseFloat(h1cs.lineHeight)) : 0;
              const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
              // Every element, pseudo-elements included: the removed effects must not come back through a ::before.
              const effects = [];
              const badRadii = new Set();
              for (const el of document.querySelectorAll('body *')) {
                for (const pseudo of [null, '::before', '::after']) {
                  const cs = getComputedStyle(el, pseudo);
                  if (pseudo && cs.content === 'none') continue;
                  const backdrop = cs.backdropFilter || cs.webkitBackdropFilter;
                  if (backdrop && backdrop !== 'none') effects.push(`backdrop-filter on ${name(el)}${pseudo ?? ''}`);
                  const clip = cs.backgroundClip || cs.webkitBackgroundClip;
                  if (clip === 'text') effects.push(`background-clip: text on ${name(el)}${pseudo ?? ''}`);
                  const corners = [
                    cs.borderTopLeftRadius,
                    cs.borderTopRightRadius,
                    cs.borderBottomRightRadius,
                    cs.borderBottomLeftRadius,
                  ];
                  for (const corner of corners) {
                    for (const part of corner.split(' '))
                      if (!radii.includes(part)) badRadii.add(`${part} on ${name(el)}`);
                  }
                }
              }
              const fonts = performance
                .getEntriesByType('resource')
                .filter((e) => /[.]woff2?([?]|$)/.test(e.name))
                .map((e) => ({
                  name: e.name.split('/').pop(),
                  start: Math.round(e.startTime),
                  bytes: e.encodedBodySize,
                }));
              let webgl2 = false;
              try {
                webgl2 = Boolean(document.createElement('canvas').getContext('webgl2'));
              } catch {}
              return {
                csp: window.__cspViolations,
                lcp: window.__lcp,
                mount: window.__beingMount,
                loadedAt: window.__loadedAt,
                hasStage: Boolean(document.querySelector('[data-being-stage]')),
                webgl2,
                overflow: document.scrollingElement.scrollWidth - window.innerWidth,
                theme: document.documentElement.getAttribute('data-theme'),
                js: document.documentElement.classList.contains('js'),
                h1: h1cs
                  ? {
                      family: h1cs.fontFamily,
                      transform: h1cs.textTransform,
                      tracking: Number.parseFloat(h1cs.letterSpacing) / h1size,
                      size: h1size,
                      lines: h1lines,
                      align: h1cs.textAlign,
                      loaded: document.fonts.check(`${h1cs.fontWeight} ${h1size}px Marcellus`),
                    }
                  : null,
                effects: effects.slice(0, 5),
                badRadii: [...badRadii].slice(0, 8),
                forbidden: forbidden.filter((selector) => document.querySelector(selector)),
                fonts,
              };
            },
            { forbidden: FORBIDDEN, radii: RADII },
          );
          if (errors.length) issues.push(`${errors.length} console error(s): ${errors[0].slice(0, 120)}`);
          if (m.csp.length) issues.push(`${m.csp.length} CSP violation(s): ${m.csp[0]}`);
          // The <h1> is the LCP element (CONVENTIONS, Performance): not the lead paragraph, an image or a canvas.
          // If the lead ever out-paints the heading at a width, the hero layout is what changes, not this check.
          if (path === '/' && m.lcp?.tag !== 'H1')
            issues.push(`LCP element is ${m.lcp?.tag ?? 'unknown'}, expected the <h1>`);
          if (path === '/' && m.h1) {
            // The home H1 is the bottle wordmark: Marcellus, uppercase, tracked 0.08em, centred, 2 lines at 1440
            // and 3 at 390, never under 44px (the floor that keeps it the LCP element over the lead).
            if (!/Marcellus/.test(m.h1.family) || !m.h1.loaded) issues.push(`h1 is not in Marcellus (${m.h1.family})`);
            if (m.h1.transform !== 'uppercase') issues.push(`h1 text-transform is ${m.h1.transform}`);
            if (Math.abs(m.h1.tracking - 0.08) > 0.005)
              issues.push(`h1 letter-spacing is ${m.h1.tracking.toFixed(3)}em`);
            if (m.h1.align !== 'center') issues.push(`h1 is not centred (${m.h1.align})`);
            if (m.h1.size < 44) issues.push(`h1 is ${m.h1.size}px, under 44px`);
            const lines = width >= 1440 ? 2 : width <= 390 ? 3 : null;
            if (lines && m.h1.lines !== lines) issues.push(`h1 wraps to ${m.h1.lines} lines, expected ${lines}`);
          }
          // Exactly two font files, Marcellus and Inter, both before the LCP, within the brief's 40 KB.
          const beforeLcp = m.fonts.filter((f) => !m.lcp || f.start <= m.lcp.at).map((f) => f.name);
          if (m.fonts.length !== 2 || !FONT_FILES.every((re) => beforeLcp.some((n) => re.test(n)))) {
            const list = m.fonts.map((f) => `${f.name}@${f.start}ms`).join(', ') || 'none';
            issues.push(`font files: ${list} (expected Marcellus and Inter before the LCP at ${m.lcp?.at}ms)`);
          }
          const fontBytes = m.fonts.reduce((n, f) => n + f.bytes, 0);
          if (fontBytes > FONT_BYTES_MAX) issues.push(`font bytes ${fontBytes} exceed ${FONT_BYTES_MAX}`);
          if (m.effects.length) issues.push(m.effects.join('; '));
          if (m.badRadii.length) issues.push(`border-radius outside 8/16/999px and 50%: ${m.badRadii.join(', ')}`);
          if (m.forbidden.length) issues.push(`forbidden classes present: ${m.forbidden.join(', ')}`);
          if (m.overflow > 0) issues.push(`horizontal overflow ${m.overflow}px`);
          if (m.theme !== theme) issues.push(`data-theme is ${m.theme}, expected ${theme}`);
          if (!m.js) issues.push('html.js not set (theme-boot.js did not run)');
          // The being must draw, not fall back to the poster: a shader that fails to compile, a runtime error in the
          // first frames or a missing asset all end in is-fallback, which looked like a pass before this check.
          if (m.hasStage && m.webgl2) {
            if (!m.mount) issues.push(`the being did not mount within ${MOUNT_TIMEOUT_MS / 1000} s`);
            else if (m.mount.kind !== 'ready')
              issues.push('the being fell back to the poster (is-fallback) with WebGL2 available');
          }
          for (const href of talkRequests) issues.push(`talk bytes before any tap: ${href}`);
          for (const r of apiRequests) {
            if (m.hasStage) {
              if (!m.mount) issues.push(`${r.path} requested but the being never mounted`);
              else if (r.at < m.mount.at - MOUNT_SLACK_MS)
                issues.push(`${r.path} requested ${m.mount.at - r.at}ms before the being mounted`);
            } else if (!m.loadedAt || r.at < m.loadedAt)
              issues.push(`${r.path} requested before load on a page without a being`);
          }
          await page.screenshot({
            path: join(shots, `metrics${path === '/' ? '-home' : path.replaceAll('/', '-')}-${theme}-${width}.png`),
          });
          const h1 = m.h1 ? ` h1=${Math.round(m.h1.size)}px/${m.h1.lines}l` : '';
          const mount = m.hasStage ? (m.mount ? m.mount.kind : 'no') : 'n/a';
          const detail = `lcp=${m.lcp?.tag ?? '-'}${h1} fonts=${m.fonts.length}/${fontBytes}B api=${apiRequests.length} mount=${mount}`;
          rows.push([label, issues.length ? 'FAIL' : 'PASS', issues.length ? issues.join('; ') : detail]);
        } catch (error) {
          rows.push([label, 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
        } finally {
          await ctx.close();
        }
      }
    }
  }

  // A touch device at 390 px: the hero cloud draws its first frame, and the renderer's chunk, the being and every
  // /api call wait for a tap (CONVENTIONS, Performance: three.js only on tap on touch).
  if (PAGES.includes('/')) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    try {
      await ctx.addInitScript((value) => {
        try {
          localStorage.setItem('em-theme', value);
        } catch {}
      }, 'dark');
      await ctx.addInitScript(instrument);
      const page = await ctx.newPage();
      const errors = [];
      const early = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('request', (r) => {
        const url = new URL(r.url());
        if (THREE_CHUNK.test(url.pathname) || url.pathname.startsWith('/api/') || TALK_BYTES.test(url.href))
          early.push(url.pathname);
      });
      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
      const hero = await until(() => page.evaluate(() => window.__heroReadyAt), {
        timeout: HERO_TIMEOUT_MS,
        interval: 250,
      });
      const state = await page.evaluate(() => ({
        mount: window.__beingMount,
        cloud: document.querySelector('[data-hero-canvas]')?.dataset.cloud ?? 'none',
        webgl2: Boolean(document.createElement('canvas').getContext('webgl2')),
      }));
      const issues = [];
      if (state.webgl2 && !hero)
        issues.push(`the hero cloud never drew (canvas state "${state.cloud}"): a WebGL2 or shader failure`);
      if (state.mount) issues.push(`the being mounted (${state.mount.kind}) without a tap`);
      for (const path of early) issues.push(`${path} requested before any tap`);
      if (errors.length) issues.push(`${errors.length} console error(s): ${errors[0].slice(0, 120)}`);
      await page.screenshot({ path: join(shots, 'metrics-home-touch-390.png') });
      rows.push([
        'touch hero at 390',
        issues.length ? 'FAIL' : 'PASS',
        issues.length ? issues.join('; ') : `hero cloud ${hero ? 'drew' : 'skipped (no WebGL2)'}, nothing early`,
      ]);
    } catch (error) {
      rows.push(['touch hero at 390', 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
    } finally {
      await ctx.close();
    }
  }

  // The header menu is a CSS-only <details> sheet under 720 px: it must open with scripts disabled.
  {
    const { ctx, page } = await newPage(browser, { width: 390, height: 800, theme: 'dark', javaScriptEnabled: false });
    try {
      await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
      const visibleLinks = () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll('header a[href="/docs"], [data-menu] a[href="/docs"]')].filter((el) => {
              const r = el.getBoundingClientRect();
              const cs = getComputedStyle(el);
              return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
            }).length,
        );
      const trigger = page.locator('[data-menu] summary, summary[data-menu], [data-menu]').first();
      if (!(await trigger.count())) rows.push(['menu without JS at 390', 'FAIL', 'no [data-menu] trigger in the page']);
      else {
        const before = await visibleLinks();
        await trigger.click();
        const opened = await until(visibleLinks, { timeout: 2000 });
        const js = await page.evaluate(() => document.documentElement.classList.contains('js'));
        if (js) rows.push(['menu without JS at 390', 'FAIL', 'html.js is set although scripts are disabled']);
        else if (!opened)
          rows.push(['menu without JS at 390', 'FAIL', 'no header link became visible after the click']);
        else
          rows.push(['menu without JS at 390', 'PASS', `${opened} link(s) visible after the click (${before} before)`]);
        await page.screenshot({ path: join(shots, 'metrics-menu-nojs-390.png') });
      }
    } catch (error) {
      rows.push(['menu without JS at 390', 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await close();
}

process.exit(report(`metrics against ${base}`, rows) ? 1 : 0);
