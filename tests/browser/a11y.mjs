/**
 * axe-core over every page of the built site in both themes at phone and desktop widths, with the color-contrast
 * rule on, so the palette is checked by a tool rather than by eye (plan 4.7). Serious and critical violations fail
 * the run. The pages open under prefers-reduced-motion so main.ts reveals every [data-reveal] section at once;
 * otherwise everything below the first screen sits at opacity 0 and axe skips its contrast. Contrast checks axe
 * cannot decide (text over the hero canvas or the one gloss gradient) are printed for review, never counted as
 * clean. The brief asks for 0 violations of any impact, so every violation fails the run. On "/" the Talk sheet is
 * also checked open at 390 px, in both themes: the consent view, and the chat view against a faked session grant
 * whose voice never connects. Behind the sheet the page is inert (its <h1> with it, as behind any modal), so those
 * runs cover what the visitor can reach: the header, the stage and the monitor.
 *
 *   node tests/browser/a11y.mjs [--base <url>] [--pages /,/docs] [--widths 390]
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { launch, newPage, parseArgs, ROOT, report, THEMES, withBase } from './lib.mjs';

const args = parseArgs();
/** --pages /,/docs and --widths 390 narrow a local run; without them every route is checked, as in CI. */
const PAGES = args.pages ? args.pages.split(',') : allPages(resolve(args.dist ?? join(ROOT, 'apps', 'web', 'dist')));
const WIDTHS = args.widths ? args.widths.split(',').map(Number) : [390, 1440];
/** Every impact fails: the brief's acceptance is 0 violations. */
const FAILING = new Set(['minor', 'moderate', 'serious', 'critical']);
const { base, close } = await withBase(args);
const browser = await launch();
const rows = [];
const details = [];
/** Undecided contrast checks, grouped by element and reason (the footer gradient repeats on every page). */
const incomplete = new Map();

/** Every route: the fixed pages, each doc from the build, and one unknown path for the 404 page. */
function allPages(dist) {
  const docsDir = join(dist, 'docs');
  const docs = existsSync(docsDir)
    ? readdirSync(docsDir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => `/docs/${f.replace(/\.html$/, '')}`)
    : [];
  return ['/', '/docs', ...docs, '/privacy', '/terms', '/security', '/this-page-does-not-exist'];
}

/**
 * One axe pass over the page as it stands, reported under `label`; `scope` narrows it to those parts (axe then
 * skips its page-level rules, which the whole-page runs cover).
 */
async function audit(page, label, scope = []) {
  const builder = new AxeBuilder({ page });
  for (const selector of scope) builder.include(selector);
  const results = await builder
    .options({
      rules: { 'color-contrast': { enabled: true } },
      // Pseudo-elements (the story dots, the triangle bullets) are decoration, never a text backdrop.
      checks: { 'color-contrast': { options: { ignorePseudo: true } } },
    })
    .analyze();
  const counts = {};
  for (const v of results.violations)
    counts[v.impact ?? 'unknown'] = (counts[v.impact ?? 'unknown'] ?? 0) + v.nodes.length;
  const failing = results.violations.filter((v) => FAILING.has(v.impact ?? ''));
  for (const v of failing) {
    const targets = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' | ');
    details.push(`${label}: [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s): ${targets})`);
  }
  const undecided = results.incomplete.filter((v) => v.id === 'color-contrast').flatMap((v) => v.nodes);
  for (const node of undecided) {
    const why = node.any?.[0]?.data?.messageKey ?? node.any?.[0]?.message ?? 'unknown';
    const key = `${node.target.join(' ')} (${why})`;
    const runs = incomplete.get(key) ?? new Set();
    runs.add(label);
    incomplete.set(key, runs);
  }
  const summary =
    Object.entries(counts)
      .map(([impact, n]) => `${impact}=${n}`)
      .join(' ') || 'clean';
  rows.push([
    label,
    failing.length ? 'FAIL' : 'PASS',
    undecided.length ? `${summary}, ${undecided.length} contrast check(s) undecided` : summary,
  ]);
}

/** A session grant for the chat view; the voice behind it is never answered. */
const GRANT = {
  ok: true,
  provider: 'convai',
  token: 't',
  expiresAt: '2099-01-01T00:00:00.000Z',
  characterId: 'c',
  endUserId: 'e',
  session: { turnsLeft: 60, maxMinutes: 5, secondsLeft: 300 },
};

try {
  for (const path of PAGES) {
    for (const theme of THEMES) {
      for (const width of WIDTHS) {
        const label = `${path} ${theme} ${width}`;
        // axe injects its own script, which the page's CSP would otherwise refuse; the CSP is metrics.mjs's job.
        const { ctx, page } = await newPage(browser, { width, theme, bypassCSP: true, reducedMotion: 'reduce' });
        try {
          await page.goto(base + path, { waitUntil: 'load', timeout: 60000 });
          await page.waitForTimeout(1500);
          await audit(page, label);
        } catch (error) {
          rows.push([label, 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
        } finally {
          await ctx.close();
        }
      }
    }
  }

  // The Talk sheet open on a phone: the consent view, then the chat view.
  if (PAGES.includes('/')) {
    for (const theme of THEMES) {
      const { ctx, page } = await newPage(browser, {
        width: 390,
        height: 844,
        theme,
        bypassCSP: true,
        reducedMotion: 'reduce',
      });
      let label = `/ talk consent ${theme} 390`;
      const sheet = ['[data-header]', '[data-being-stage]', '[data-monitor]'];
      try {
        await ctx.route('**/api/talk/session', (route) =>
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(GRANT) }),
        );
        await ctx.route(/convai\.com|livekit/i, () => {});
        await ctx.routeWebSocket(/convai\.com|livekit/i, () => {});
        await page.goto(`${base}/`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(1000);
        await page.locator('.hero-ctas [data-talk-open]').click();
        await page.locator('[data-talk-consent]').waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(800);
        await audit(page, label, sheet);
        label = `/ talk chat ${theme} 390`;
        await page.locator('[data-talk-start]').click();
        await page.locator('[data-talk-session]').waitFor({ state: 'visible', timeout: 10000 });
        await page.waitForTimeout(800);
        await audit(page, label, sheet);
      } catch (error) {
        rows.push([label, 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
      } finally {
        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await close();
}

const failures = report(`axe against ${base}`, rows);
for (const line of details) console.log(`  - ${line}`);
if (incomplete.size) {
  console.log(
    `\n${incomplete.size} element(s) whose colour contrast axe could not decide (text over the hero canvas or a gradient); check these by hand against every gradient stop and against --bg:`,
  );
  for (const [key, runs] of [...incomplete].sort((a, b) => b[1].size - a[1].size)) {
    const [first] = runs;
    console.log(`  ? ${key}: ${runs.size} run(s), e.g. ${first}`);
  }
}
process.exit(failures ? 1 : 0);
