/**
 * scripts/bundle-budget.mjs against small fixture builds: the pre-interaction figure must follow a dynamic
 * import(`./x.js`) the way rolldown writes it, and a static import of a three.js chunk must fail on its own.
 * Runs with "node --test tools/**\/*.test.ts".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'bundle-budget.mjs');

/** A dist directory with index.html loading /_astro/a.js, plus the given _astro files. */
function fixture(files: Record<string, string>, docsHtml?: string): string {
  const dist = mkdtempSync(join(tmpdir(), 'emersa-budget-'));
  mkdirSync(join(dist, '_astro'));
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><head><script src="/theme-boot.js"></script></head>' +
      '<body><script type="module" src="/_astro/a.js"></script></body></html>',
  );
  writeFileSync(join(dist, 'theme-boot.js'), 'document.documentElement.classList.add("js");\n');
  if (docsHtml) writeFileSync(join(dist, 'docs.html'), docsHtml);
  for (const [name, code] of Object.entries(files)) writeFileSync(join(dist, '_astro', name), code);
  return dist;
}

function run(dist: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, dist], {
    encoding: 'utf8',
    env: { ...process.env, SKIP_BUDGET: '' },
  });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

/** Text that gzip cannot shrink much: random bytes as base64, about 24 KB after compression. */
const incompressible = () => `export const blob = "${randomBytes(32_000).toString('base64')}";\n`;

test('a chunk reached only through import(`./x.js`) counts towards the 16 KB pre-interaction budget', () => {
  const dist = fixture({
    'a.js': 'const load = () => import(`./b.js`);\nexport { load };\n',
    'b.js': incompressible(),
  });
  try {
    const { status, output } = run(dist);
    assert.equal(status, 1, output);
    assert.match(output, /\/ before interaction[^\n]*exceeds 16\.0 KB/);
    assert.match(output, /bundle-budget: FAIL/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('a static import of the three.js chunk fails even when the bytes would fit', () => {
  const dist = fixture({
    'a.js': 'import{WebGLRenderer}from"./three.js";console.log(WebGLRenderer);\n',
    'three.js': 'export class WebGLRenderer{};console.log("THREE.WebGLRenderer");\n',
  });
  try {
    const { status, output } = run(dist);
    assert.equal(status, 1, output);
    assert.match(
      output,
      /a\.js statically imports three\.js \(three\); three, @emersa\/being and talk must load through dynamic import\(\)/,
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('a small build passes, dynamic edges into three and the tour are not counted, and /docs counts theme-boot.js', () => {
  const dist = fixture(
    {
      'a.js':
        'const t = () => import(`./three.js`);const u = () => import("./tour.js");import"./HeroCloud.js";export { t, u };\n',
      'three.js': incompressible().replace('export const', 'console.log("THREE.WebGLRenderer");export const'),
      'tour.js': incompressible(),
      'HeroCloud.js': 'export const cloud = 1;\n',
    },
    '<!doctype html><html><head><script src="/theme-boot.js"></script></head>' +
      '<body><script type="module" src="/_astro/HeroCloud.js"></script></body></html>',
  );
  try {
    const { status, output } = run(dist);
    assert.equal(status, 0, output);
    assert.match(output, /\/ before interaction[^\n]*\s0\.[0-9] KB\s+16\.0 KB\s+ok/);
    assert.match(output, /tour chunk\(s\) \(on the Start tap\)/);
    assert.match(output, /hero cloud chunk\s+0\.[0-9] KB\s+7\.0 KB\s+ok/);
    assert.match(output, /\/docs scripts\s+0\.[0-9] KB\s+4\.0 KB\s+ok/);
    assert.match(output, /three\.js chunk\(s\)\s+[1-9][0-9]\.[0-9] KB\s+195\.0 KB\s+ok/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

/** Random bytes as base64: gzip keeps about one byte per random byte, so `bytes` sets the compressed size. */
const incompressibleOf = (bytes: number) => `export const blob = "${randomBytes(bytes).toString('base64')}";\n`;

test('the being chunks after the core are known by name: cloud (16 KB) and sculpture (24 KB, warning from 20)', () => {
  const dist = fixture({
    'a.js': 'const b = () => import(`./src.js`);\nexport { b };\n',
    // The core carries the being's marker; so do its lazy chunks, which the class goes by the name before.
    'src.js':
      'const c = () => import(`./cloud.js`);const s = () => import(`./sculpture.js`);export const uTokenRate = 1;export { c, s };\n',
    'cloud.js': `import{uTokenRate}from"./src.js";console.log(uTokenRate);${incompressibleOf(8_000)}`,
    'sculpture.js': `import{uTokenRate}from"./src.js";console.log(uTokenRate);${incompressibleOf(21_500)}`,
  });
  try {
    const { status, output } = run(dist);
    assert.equal(status, 0, output);
    assert.match(output, /_astro\/cloud\.js\s+cloud\s/);
    assert.match(output, /_astro\/sculpture\.js\s+sculpture\s/);
    assert.match(output, /cloud chunk \(the kinect looks, after the core\)\s+[7-9]\.[0-9] KB\s+16\.0 KB\s+ok/);
    assert.match(output, /sculpture chunk \(after the core\)\s+2[0-3]\.[0-9] KB\s+24\.0 KB\s+WARN/);
    assert.match(output, /WARN {2}sculpture chunk \(after the core\): [0-9.]+ KB is within/);
    // Neither is counted before an interaction: the pre-interaction walk stops at the core.
    assert.match(output, /\/ before interaction[^\n]*\s0\.[0-9] KB\s+16\.0 KB\s+ok/);
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test('a cloud chunk over 16 KB fails, and a page that imports it statically fails on its own', () => {
  const over = fixture({
    'a.js': 'const b = () => import(`./src.js`);\nexport { b };\n',
    'src.js': 'const c = () => import(`./cloud.js`);export const uTokenRate = 1;export { c };\n',
    'cloud.js': incompressibleOf(18_000),
  });
  try {
    const { status, output } = run(over);
    assert.equal(status, 1, output);
    assert.match(output, /cloud chunk \(the kinect looks, after the core\): 1[7-9]\.[0-9] KB exceeds 16\.0 KB/);
  } finally {
    rmSync(over, { recursive: true, force: true });
  }
  const eager = fixture({
    'a.js': 'import{blob}from"./cloud.js";console.log(blob);\n',
    'cloud.js': 'export const blob = 1;\n',
  });
  try {
    const { status, output } = run(eager);
    assert.equal(status, 1, output);
    assert.match(output, /a\.js statically imports cloud\.js \(cloud\)/);
  } finally {
    rmSync(eager, { recursive: true, force: true });
  }
});
