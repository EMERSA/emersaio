/**
 * axe-core over every page of the built site in both themes at phone and desktop widths, with the color-contrast
 * rule on, so the palette is checked by a tool rather than by eye (plan 4.7). Serious and critical violations fail
 * the run. The pages open under prefers-reduced-motion so main.ts reveals every [data-reveal] section at once;
 * otherwise everything below the first screen sits at opacity 0 and axe skips its contrast. Contrast checks axe
 * cannot decide (text over the hero canvas or the one gloss gradient) are printed for review, never counted as
 * clean. The brief asks for 0 violations of any impact, so every violation fails the run.
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
  return [
    '/',
    '/docs',
    ...docs,
    '/games',
    '/contact',
    '/contact/sent',
    '/contact/error',
    '/privacy',
    '/terms',
    '/security',
    '/this-page-does-not-exist',
  ];
}

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
          const results = await new AxeBuilder({ page })
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
        } catch (error) {
          rows.push([label, 'FAIL', `threw: ${String(error.message ?? error).slice(0, 160)}`]);
        } finally {
          await ctx.close();
        }
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
