/**
 * Shared by the browser checks: the Edge launch recipe, a page factory that applies the theme the way the site
 * stores it, a static server or an external base URL, and one PASS/FAIL table so every script reports alike.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startStaticServer } from './static-serve.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT_DIR = join(ROOT, 'tests', 'browser', 'out');
export const THEMES = ['dark', 'light'];

/** The installed Microsoft Edge on a software renderer, so WebGL exists without a GPU (see docs/CONVENTIONS.md). */
export const EDGE = {
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
};

export const launch = (extraArgs = []) => chromium.launch({ ...EDGE, args: [...EDGE.args, ...extraArgs] });

/** --base <url> | --dist <dir> | --port <n> | <port-or-url> | bare flags. */
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else args.flags.add(key);
    } else if (/^\d+$/.test(arg)) args.port = arg;
    else if (/^https?:\/\//.test(arg)) args.base = arg;
    else args.dist = arg;
  }
  return args;
}

/** A base URL to test: the one given, a local port, or a static server on apps/web/dist that is closed afterwards. */
export async function withBase(args) {
  if (args.base) return { base: args.base.replace(/\/$/, ''), close: async () => {} };
  if (args.port) return { base: `http://127.0.0.1:${args.port}`, close: async () => {} };
  const dist = resolve(args.dist ?? join(ROOT, 'apps', 'web', 'dist'));
  const server = await startStaticServer({ dist, port: 0 });
  return { base: server.url, close: server.close };
}

/** A fresh context and page. The theme is stored the way theme-boot.js reads it, before any page script runs. */
export async function newPage(
  browser,
  { width = 1280, height = 900, theme = 'dark', javaScriptEnabled = true, reducedMotion, bypassCSP = false } = {},
) {
  const ctx = await browser.newContext({ viewport: { width, height }, javaScriptEnabled, reducedMotion, bypassCSP });
  await ctx.addInitScript((value) => {
    try {
      localStorage.setItem('em-theme', value);
    } catch {}
  }, theme);
  const page = await ctx.newPage();
  return { ctx, page };
}

export function outDir() {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/** Prints rows of [name, status, detail] and returns the number of failures. */
export function report(title, rows) {
  const width = Math.max(...rows.map(([name]) => name.length), 4);
  console.log(`\n${title}`);
  for (const [name, status, detail = ''] of rows)
    console.log(`  ${status.padEnd(4)}  ${name.padEnd(width)}  ${detail}`);
  const failures = rows.filter(([, status]) => status === 'FAIL').length;
  console.log(
    failures ? `\n${title}: FAIL (${failures} of ${rows.length})` : `\n${title}: PASS (${rows.length} checks)`,
  );
  return failures;
}

/** Polls until fn() is truthy or the time runs out; returns the last value. */
export async function until(fn, { timeout = 5000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  let value = await fn();
  while (!value && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    value = await fn();
  }
  return value;
}
