/**
 * The built site in headless Edge at three widths and both themes: no console errors, no CSP violations (the
 * static server applies dist/_headers), the <h1> as the LCP element on "/" (in Marcellus, uppercase, tracked
 * 0.08em, at least 44px), exactly two font files before the LCP (Marcellus and Inter, 40 KB or less together), no
 * computed backdrop-filter or background-clip: text anywhere, none of the removed ornament classes in the DOM,
 * only the four border radii (8px, 16px, 999px, 50%), no /api/* request before the being mounts, no horizontal
 * overflow, the stored theme applied, and the menu opening at 390 px with JavaScript off.
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
const RADII = ['0px', '8px', '16px', '999px', '50%'];
/** Slack between the page's own clock stamp of the mount and the request event reaching Node. */
const MOUNT_SLACK_MS = 250;

/** Runs before any page script: collects CSP violations, the LCP entry and the moment the being mounts. */
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
  window.__beingMountedAt = null;
  const check = () => {
    if (window.__beingMountedAt) return;
    if (document.querySelector('[data-being-stage].is-ready, [data-being-stage].is-fallback'))
      window.__beingMountedAt = Date.now();
  };
  new MutationObserver(check).observe(document, { attributes: true, subtree: true, attributeFilter: ['class'] });
};

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
          await page.waitForTimeout(SETTLE_MS);
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
              return {
                csp: window.__cspViolations,
                lcp: window.__lcp,
                mountedAt: window.__beingMountedAt,
                loadedAt: window.__loadedAt,
                hasStage: Boolean(document.querySelector('[data-being-stage]')),
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
          for (const href of talkRequests) issues.push(`talk bytes before any tap: ${href}`);
          for (const r of apiRequests) {
            if (m.hasStage) {
              if (!m.mountedAt) issues.push(`${r.path} requested but the being never mounted`);
              else if (r.at < m.mountedAt - MOUNT_SLACK_MS)
                issues.push(`${r.path} requested ${m.mountedAt - r.at}ms before the being mounted`);
            } else if (!m.loadedAt || r.at < m.loadedAt)
              issues.push(`${r.path} requested before load on a page without a being`);
          }
          await page.screenshot({
            path: join(shots, `metrics${path === '/' ? '-home' : path.replaceAll('/', '-')}-${theme}-${width}.png`),
          });
          const h1 = m.h1 ? ` h1=${Math.round(m.h1.size)}px/${m.h1.lines}l` : '';
          const detail = `lcp=${m.lcp?.tag ?? '-'}${h1} fonts=${m.fonts.length}/${fontBytes}B api=${apiRequests.length} mount=${m.hasStage ? (m.mountedAt ? 'yes' : 'no') : 'n/a'}`;
          rows.push([label, issues.length ? 'FAIL' : 'PASS', issues.length ? issues.join('; ') : detail]);
        } catch (error) {
          rows.push([label, 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
        } finally {
          await ctx.close();
        }
      }
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
