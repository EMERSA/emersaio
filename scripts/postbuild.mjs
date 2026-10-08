#!/usr/bin/env node
/**
 * Runs right after "astro build" from apps/web (see its package.json). Three jobs and nothing else:
 *   1. remove the development harness pages (src/pages/dev) from dist, so they never deploy;
 *   2. remove the scripts that only those pages used: any dist/_astro/*.js that no HTML file left in dist and no
 *      surviving chunk reaches (the harness's own script, and anything only it imported);
 *   3. write dist/.build-info.json (build time, commit, phase) so a deployed site can be matched to a commit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fromCwd = resolve(process.cwd(), 'dist');
const dist = existsSync(fromCwd) ? fromCwd : join(root, 'apps', 'web', 'dist');
const rel = (path) => relative(dist, path).replaceAll('\\', '/');

if (!existsSync(dist)) {
  console.error(`postbuild: ${dist} does not exist; nothing was built.`);
  process.exit(1);
}

// With build.format 'file', src/pages/dev/index.astro becomes dist/dev.html and its siblings dist/dev/*.html.
for (const harness of ['dev', 'dev.html']) {
  const path = join(dist, harness);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`postbuild: removed ${rel(path)} (development harness)`);
  }
}

/** Every file under dir that passes the filter, recursively. */
function* walk(dir, filter) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path, filter);
    else if (filter(path)) yield path;
  }
}

/**
 * Orphan chunks. The roots are the scripts the remaining HTML files name (a <script src> or a modulepreload under
 * /_astro/); from there every quoted "./x.js" a chunk carries, static import, dynamic import() or the preload
 * helper's list alike, is an edge. Whatever the walk never reaches is served to nobody and goes.
 */
const astroDir = join(dist, '_astro');
if (existsSync(astroDir)) {
  const chunks = new Set(readdirSync(astroDir).filter((name) => name.endsWith('.js')));
  const roots = new Set();
  for (const html of walk(dist, (path) => path.endsWith('.html'))) {
    for (const m of readFileSync(html, 'utf8').matchAll(/\/_astro\/([A-Za-z0-9_.-]+\.js)\b/g)) {
      if (chunks.has(m[1])) roots.add(m[1]);
    }
  }
  const reached = new Set();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    const code = readFileSync(join(astroDir, name), 'utf8');
    for (const m of code.matchAll(/["'`](?:\.\/)?([A-Za-z0-9_.-]+\.js)["'`]/g)) {
      const target = basename(m[1]);
      if (chunks.has(target) && !reached.has(target)) queue.push(target);
    }
  }
  for (const name of [...chunks].sort()) {
    if (reached.has(name)) continue;
    const path = join(astroDir, name);
    const size = statSync(path).size;
    rmSync(path, { force: true });
    console.log(`postbuild: removed ${rel(path)} (${size} bytes; referenced by no page and no other chunk)`);
  }
}

const gitSha = () => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const info = {
  builtAt: new Date().toISOString(),
  commit: process.env.WORKERS_CI_COMMIT_SHA ?? process.env.GITHUB_SHA ?? gitSha(),
  phase: Number(process.env.SITE_PHASE ?? 1),
};
writeFileSync(join(dist, '.build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`postbuild: wrote .build-info.json (${info.commit ?? 'no commit'}, phase ${info.phase})`);
