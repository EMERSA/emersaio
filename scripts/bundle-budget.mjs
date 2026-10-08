#!/usr/bin/env node
/**
 * Enforces the JavaScript budgets of plan 4.6 on the built site, by gzip size:
 *   - before any interaction on "/": /theme-boot.js + main + hero and whatever they pull in, 16 KB (budgets.json)
 *   - the hero point cloud chunk (raw WebGL2, loaded after LCP + idle on every device), 7 KB
 *   - the three.js vendor chunk, 195 KB (warning from 185)
 *   - the @emersa/being chunk, 30 KB
 *   - content pages (docs), 4 KB (budgets.json)
 * Chunks are classified by their names (Astro keeps the source file's name in front of the hash) and by content
 * markers that survive minification. The pre-interaction set follows the real module graph, static and dynamic
 * edges alike, and stops only at the chunks that load on a tap (the tour) or after LCP + idle on desktops (three and
 * the being). A static import of one of those is a budget failure in itself: CONVENTIONS say they load through
 * dynamic import(). SKIP_BUDGET=1 reports but does not fail, for local iteration only.
 *
 *   node scripts/bundle-budget.mjs [distDir]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.argv[2] ?? join(root, 'apps', 'web', 'dist'));
const KB = 1024;

/** The page-level script budgets live in budgets.json so Lighthouse CI and this script enforce the same numbers. */
function pageBudgetKb(path, fallbackKb) {
  try {
    const budgets = JSON.parse(readFileSync(join(root, 'budgets.json'), 'utf8'));
    const row = budgets.find((b) => b.path === path)?.resourceSizes?.find((r) => r.resourceType === 'script');
    return row?.budget ?? fallbackKb;
  } catch {
    return fallbackKb;
  }
}

const LIMITS = {
  pre: pageBudgetKb('/', 16) * KB,
  content: pageBudgetKb('/docs', 4) * KB,
  heroCloud: 7 * KB,
  three: 195 * KB,
  threeWarn: 185 * KB,
  being: 30 * KB,
  talk: 200 * KB,
};

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`bundle-budget: ${dist}/index.html does not exist. Run "astro build" first.`);
  process.exit(1);
}

const gz = (buffer) => gzipSync(buffer, { level: 9 }).length;
const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

// Static edges: `import{a}from"./x.js"`, `import"./x.js"`, `export*from"./x.js"`. A specifier is always a plain
// string here, so straight quotes are enough, and `import(` never matches because the quote must follow directly.
const STATIC_EDGE = /\b(?:from|import)\s*["']([^"']+\.js)["']/g;
// Dynamic edges: rolldown (Vite 8) writes import(`./x.js`) as a template literal, older builds import("./x.js").
const DYNAMIC_EDGE = /import\s*\(\s*["'`]([^"'`]+\.js)["'`]\s*\)/g;

// Every script in dist/_astro, with its imports, so the pre-interaction set follows the real module graph.
const astroDir = join(dist, '_astro');
const chunks = new Map();
if (existsSync(astroDir)) {
  const edges = (code, pattern) => {
    const targets = new Set();
    for (const m of code.matchAll(pattern)) {
      const target = basename(m[1]);
      if (existsSync(join(astroDir, target))) targets.add(target);
    }
    return [...targets];
  };
  for (const name of readdirSync(astroDir).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(join(astroDir, name), 'utf8');
    chunks.set(name, {
      name,
      code,
      raw: Buffer.byteLength(code),
      gz: gz(code),
      imports: edges(code, STATIC_EDGE),
      dynamic: edges(code, DYNAMIC_EDGE),
    });
  }
}

const stem = (name) => name.replace(/\.[A-Za-z0-9_-]{6,}\.js$/, '').replace(/\.js$/, '');
const THREE_MARK = /THREE\.(?:WebGLRenderer|Object3D|BufferGeometry|Material|GLTFLoader|MeshoptDecoder)/;
// The being's shared uniform names and its package name; never a GLSL builtin such as gl_VertexID, which three's
// own shader chunks use too and would make the three chunk read as "three+being".
const BEING_MARK = /uTokenRate|uTokenPulse|@emersa\/being/;
const TALK_MARK = /convai|livekit/i;

/**
 * three | being | talk | tour | pre | content | shared. "shared" chunks take the class of whoever reaches them.
 * Astro names a component's script "<Component>.astro_astro_type_script_…", so Base (main.ts) and Hero (hero.ts and
 * being-mount.ts) are matched by their component names as well as by the source names a manual chunk would carry.
 */
function classify(chunk) {
  const s = stem(chunk.name);
  const three = THREE_MARK.test(chunk.code);
  const being = BEING_MARK.test(chunk.code) || /^being-mount/.test(s);
  if (three && being) return 'three+being';
  if (three) return 'three';
  if (TALK_MARK.test(chunk.code) || /^talk/i.test(s)) return 'talk';
  if (being) return 'being';
  if (/^tour(-ui)?\b/i.test(s)) return 'tour';
  if (/^(main|hero|theme-boot|Base\.astro|Hero\.astro)(?:[._-]|$)/i.test(s)) return 'pre';
  if (/^contact(?:[._-]|$)/i.test(s)) return 'content';
  return 'shared';
}
for (const chunk of chunks.values()) chunk.class = classify(chunk);

/** Loaded after LCP + idle on hover-capable desktops, on a tap elsewhere: never part of the pre-interaction set. */
const HEAVY = new Set(['three', 'being', 'talk', 'three+being']);
/** Loaded on the Start tap (or a ?tour= deep link), so interaction-only. */
const ON_TAP = new Set(['tour']);

const failures = [];
const warnings = [];

/**
 * Chunks reachable from a page's scripts. Static edges are always followed; one that lands on a heavy chunk is a
 * failure, because three, the being and the talk stack must load through dynamic import() (CONVENTIONS, Performance).
 * Dynamic edges are followed when asked, stopping at the heavy and the tap-only classes.
 */
function reach(entries, followDynamic, label) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.pop();
    const chunk = chunks.get(name);
    if (!chunk || seen.has(name)) continue;
    seen.add(name);
    for (const target of chunk.imports) {
      const cls = chunks.get(target)?.class;
      if (HEAVY.has(cls)) {
        failures.push(
          `${label}: ${name} statically imports ${target} (${cls}); three, @emersa/being and talk must load through dynamic import()`,
        );
      }
      queue.push(target);
    }
    if (!followDynamic) continue;
    for (const target of chunk.dynamic) {
      const cls = chunks.get(target)?.class;
      if (!HEAVY.has(cls) && !ON_TAP.has(cls)) queue.push(target);
    }
  }
  return [...seen].map((name) => chunks.get(name));
}

function pageScripts(htmlFile) {
  if (!existsSync(htmlFile)) return null;
  const html = readFileSync(htmlFile, 'utf8');
  const names = new Set();
  for (const m of html.matchAll(
    /<(?:script[^>]*\ssrc|link[^>]*rel=["']modulepreload["'][^>]*\shref)=["']([^"']+\.js)["']/g,
  )) {
    names.add(m[1]);
  }
  const astro = [...names].filter((n) => n.includes('/_astro/')).map((n) => basename(n));
  const fixed = [...names].filter((n) => !n.includes('/_astro/'));
  return { astro, fixed };
}

/** Fixed-name files a page loads from outside _astro (/theme-boot.js), with their gzip sizes. */
function fixedScripts(page) {
  const files = [];
  for (const url of page.fixed) {
    const file = join(dist, url.replace(/^\//, ''));
    if (existsSync(file)) files.push([url, gz(readFileSync(file))]);
  }
  return files;
}

const rows = [];
const judge = (label, actual, limit, warnAt) => {
  const status = actual > limit ? 'FAIL' : warnAt && actual > warnAt ? 'WARN' : 'ok';
  if (status === 'FAIL') failures.push(`${label}: ${kb(actual)} exceeds ${kb(limit)}`);
  if (status === 'WARN')
    warnings.push(`${label}: ${kb(actual)} is within ${kb(limit - actual)} of the ${kb(limit)} limit`);
  rows.push([label, kb(actual), kb(limit), status]);
};
const sum = (list) => list.reduce((n, c) => n + c.gz, 0);
const byClass = (cls) => [...chunks.values()].filter((c) => c.class === cls);

// Home: scripts referenced by index.html (plus fixed-name files such as /theme-boot.js), every chunk they reach
// before the visitor does anything (the hero cloud included), but not what loads on a tap or after LCP + idle.
const home = pageScripts(join(dist, 'index.html'));
const homeLabel = '/ before interaction (theme-boot + main + hero + hero cloud)';
const homeSet = reach(home.astro, true, homeLabel);
const homeFixed = fixedScripts(home);
judge(homeLabel, sum(homeSet) + homeFixed.reduce((n, [, size]) => n + size, 0), LIMITS.pre);

const tour = byClass('tour');
if (tour.length) rows.push(['tour chunk(s) (on the Start tap)', kb(sum(tour)), '-', 'info']);

// The hero cloud has its own line in the plan (4.4, 4.6): classify() calls it "shared", so match the file stem.
const heroCloud = [...chunks.values()].filter((c) => /^HeroCloud\b/.test(stem(c.name)));
if (heroCloud.length) judge('hero cloud chunk', sum(heroCloud), LIMITS.heroCloud);
else rows.push(['hero cloud chunk', 'absent', kb(LIMITS.heroCloud), 'skip']);

// Content pages: docs.html (build.format 'file') or docs/index.html, static imports plus the fixed-name files.
const docs = pageScripts(join(dist, 'docs.html')) ?? pageScripts(join(dist, 'docs', 'index.html'));
if (docs) {
  const docsSet = reach(docs.astro, false, '/docs scripts');
  judge('/docs scripts', sum(docsSet) + fixedScripts(docs).reduce((n, [, size]) => n + size, 0), LIMITS.content);
} else {
  rows.push(['/docs scripts', 'absent', kb(LIMITS.content), 'skip']);
}

const threeChunks = [...byClass('three'), ...byClass('three+being')];
if (threeChunks.length) judge('three.js chunk(s)', sum(threeChunks), LIMITS.three, LIMITS.threeWarn);
else rows.push(['three.js chunk(s)', 'absent', kb(LIMITS.three), 'skip']);
const beingChunks = byClass('being');
if (beingChunks.length) judge('@emersa/being chunk(s)', sum(beingChunks), LIMITS.being);
else rows.push(['@emersa/being chunk(s)', 'absent', kb(LIMITS.being), 'skip']);
if (byClass('three+being').length) {
  warnings.push(
    'a chunk holds both three.js and @emersa/being; split them (apps/web/astro.config.mjs, vite build.rolldownOptions.output.codeSplitting) so the being budget can be measured',
  );
}
const talk = byClass('talk');
if (talk.length) judge('talk chunk(s) (Phase 2, tap only)', sum(talk), LIMITS.talk);

// Print.
const table = (header, body) => {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(line(header));
  for (const row of body) console.log(line(row));
};
const files = [...chunks.values()]
  .sort((a, b) => b.gz - a.gz)
  .map((c) => [relative(dist, join(astroDir, c.name)).replaceAll('\\', '/'), c.class, kb(c.raw), kb(c.gz)]);
for (const [url, size] of homeFixed) files.push([url, 'pre', '', kb(size)]);
if (files.length) {
  table(['file', 'class', 'raw', 'gzip'], files);
  console.log('');
}
table(['budget', 'actual (gzip)', 'limit', 'status'], rows);
for (const warning of warnings) console.log(`WARN  ${warning}`);

if (failures.length) {
  if (process.env.SKIP_BUDGET === '1') {
    console.warn(`\n${'!'.repeat(72)}`);
    console.warn('!!  SKIP_BUDGET=1: the bundle budget is BREACHED and the failure is suppressed.');
    console.warn('!!  Never set this in CI or in a deploy. Remove it before pushing.');
    for (const failure of failures) console.warn(`!!  ${failure}`);
    console.warn('!'.repeat(72));
    process.exit(0);
  }
  console.error(`\nbundle-budget: FAIL`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nbundle-budget: PASS');
