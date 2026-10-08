#!/usr/bin/env node
/**
 * Fails the build when the built HTML could not run under the strict Content-Security-Policy, or when the
 * generated _headers would hand a browser a doubled or missing security header once Cloudflare applies its
 * inherit-and-join rules (ADR-0004).
 *
 * Runs after "astro build" and "node tools/headers.ts --emit" (root package.json, "build").
 *   node scripts/csp-check.mjs [distDir]
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRules,
  CSP_PHASE1,
  CSP_PHASE2_HOME,
  CSP_PHASE2_HOME_REPORT_ONLY,
  PERMISSIONS_POLICY,
  PERMISSIONS_POLICY_TALK,
  PHASE,
  parseHeaders,
  REPORT_ONLY,
} from '../tools/headers.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(process.argv[2] ?? join(root, 'apps', 'web', 'dist'));
const SITE_ORIGIN = (process.env.PUBLIC_SITE_URL || 'https://emersa.io').replace(/\/$/, '');

const problems = [];
const fail = (file, line, message) => problems.push(`${file}:${line}  ${message}`);

// --- HTML -------------------------------------------------------------------------------------------------------

const START_TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Walks the start tags of a document, skipping comments and the raw text inside <script> and <style>. */
function* tags(html) {
  const lower = html.toLowerCase();
  let pos = 0;
  let line = 1;
  let cursor = 0;
  const lineOf = (index) => {
    for (; cursor < index; cursor++) if (html.charCodeAt(cursor) === 10) line++;
    return line;
  };
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) return;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      pos = end === -1 ? html.length : end + 3;
      continue;
    }
    START_TAG.lastIndex = lt;
    const match = START_TAG.exec(html);
    if (!match) {
      pos = lt + 1;
      continue;
    }
    const name = match[1].toLowerCase();
    const attrs = {};
    for (const attr of match[2].matchAll(ATTR)) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    let end = START_TAG.lastIndex;
    let content = '';
    if (name === 'script' || name === 'style') {
      const close = lower.indexOf(`</${name}`, end);
      content = html.slice(end, close === -1 ? html.length : close);
      end = close === -1 ? html.length : close;
    }
    yield { name, attrs, content, line: lineOf(lt) };
    pos = end;
  }
}

const hasScheme = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value);

/** True when the CSP's 'self' covers the URL: relative, or absolute on the site's own origin. */
const sameOrigin = (value) => {
  const url = value.trim();
  if (!url || url.startsWith('#')) return true;
  if (url.startsWith('//')) return false;
  if (hasScheme(url)) return url === SITE_ORIGIN || url.startsWith(`${SITE_ORIGIN}/`);
  return true;
};

/** Browsers strip whitespace and control characters before reading the scheme, so "java\tscript:" counts. */
const isJavascriptUrl = (value) =>
  [...value]
    .filter((char) => char.charCodeAt(0) > 0x20)
    .join('')
    .toLowerCase()
    .startsWith('javascript:');

const URL_ATTRS = ['href', 'src', 'action', 'formaction', 'xlink:href', 'data', 'poster', 'ping'];
const FETCHING_RELS = [
  'stylesheet',
  'preload',
  'modulepreload',
  'prefetch',
  'preconnect',
  'dns-prefetch',
  'icon',
  'manifest',
  'apple-touch-icon',
];
const MEDIA_TAGS = new Set(['img', 'source', 'video', 'audio', 'track']);
const FORBIDDEN_TAGS = {
  iframe: "frame-src 'none'",
  frame: "frame-src 'none'",
  object: "object-src 'none'",
  embed: "object-src 'none'",
  base: "base-uri 'none'",
};

function checkHtml(file, html) {
  for (const { name, attrs, line } of tags(html)) {
    if (name === 'script') {
      const type = (attrs.type ?? '').trim().toLowerCase();
      if (!('src' in attrs)) {
        if (type !== 'application/ld+json')
          fail(file, line, `inline <script${type ? ` type="${type}"` : ''}>: every script must be an external file`);
      } else if (!sameOrigin(attrs.src)) {
        fail(file, line, `<script src="${attrs.src}"> is not same-origin (script-src 'self')`);
      }
    }
    if (name === 'style') fail(file, line, "<style> element: styles must be external files (style-src 'self')");
    if (name in FORBIDDEN_TAGS) fail(file, line, `<${name}> is blocked by ${FORBIDDEN_TAGS[name]}`);
    if (name === 'meta' && (attrs['http-equiv'] ?? '').toLowerCase() === 'content-security-policy') {
      fail(file, line, 'CSP in a <meta> tag: the policy comes from _headers only (tools/headers.ts)');
    }
    if (name === 'link') {
      const rels = (attrs.rel ?? '').toLowerCase().split(/\s+/);
      if (rels.some((rel) => FETCHING_RELS.includes(rel)) && !sameOrigin(attrs.href ?? '')) {
        fail(file, line, `<link rel="${attrs.rel}" href="${attrs.href}"> points off-origin`);
      }
    }
    if (name === 'form' && attrs.action && !sameOrigin(attrs.action)) {
      fail(file, line, `<form action="${attrs.action}"> is blocked by form-action 'self'`);
    }
    if (MEDIA_TAGS.has(name)) {
      for (const attr of ['src', 'poster']) {
        const value = attrs[attr];
        if (!value) continue;
        const dataAllowed = name === 'img' && attr === 'src' && value.trim().toLowerCase().startsWith('data:');
        if (!dataAllowed && !sameOrigin(value))
          fail(file, line, `<${name} ${attr}="${value.slice(0, 80)}"> is off-origin`);
      }
      if (attrs.srcset) {
        for (const candidate of attrs.srcset.split(',')) {
          const url = candidate.trim().split(/\s+/)[0] ?? '';
          if (url && !sameOrigin(url)) fail(file, line, `<${name} srcset> contains the off-origin ${url.slice(0, 80)}`);
        }
      }
    }
    for (const [attr, value] of Object.entries(attrs)) {
      if (attr === 'style') fail(file, line, `<${name} style="..."> inline style attribute (style-src 'self')`);
      if (attr.startsWith('on')) fail(file, line, `<${name} ${attr}="..."> inline event handler`);
      if (URL_ATTRS.includes(attr) && isJavascriptUrl(value))
        fail(file, line, `<${name} ${attr}="javascript:..."> URL`);
    }
  }
}

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

// --- _headers ---------------------------------------------------------------------------------------------------

/** Representative paths with exact expectations: the home override must reach "/" alone, /og.png alone is embeddable. */
const PATHS = ['/', '/docs', '/docs/x', '/_astro/x.js', '/og.png', '/theme-boot.js'];
const TALK_ON_HOME = PHASE >= 2;

function expectedFor(path) {
  const home = path === '/' && TALK_ON_HOME;
  return {
    csp: home && !REPORT_ONLY ? CSP_PHASE2_HOME : CSP_PHASE1,
    reportOnly: home && REPORT_ONLY ? CSP_PHASE2_HOME_REPORT_ONLY : undefined,
    permissions: home ? PERMISSIONS_POLICY_TALK : PERMISSIONS_POLICY,
    corp: path === '/og.png' ? 'cross-origin' : 'same-origin',
  };
}

const header = (headers, name) => headers[Object.keys(headers).find((key) => key.toLowerCase() === name) ?? ''];

/** A concrete request path for a rule pattern: the splat becomes two segments, a ":name" placeholder one. */
const samplePath = (pattern) =>
  pattern
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/\*/g, 'x/y')
    .replace(/:[A-Za-z0-9_]+/g, 'x');

/** Every URL the built site answers: pages by their clean URL (build.format "file"), everything else by file path. */
function* distUrls(dir, base = '') {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = `${base}/${entry.name}`;
    if (entry.isDirectory()) yield* distUrls(join(dir, entry.name), url);
    else if (entry.name === '_headers' || entry.name === '_redirects') continue;
    else if (entry.name.endsWith('.html')) yield url === '/index.html' ? '/' : url.replace(/(\/index)?\.html$/, '');
    else yield url;
  }
}

/**
 * Every rule in the file and every file in dist, not just the representative paths: a rule added later without its
 * detach line (ADR-0004) fails here whatever path it covers. The exact-value table stays for the paths above.
 */
function checkEveryPath(text) {
  const rules = parseHeaders(text);
  const probes = new Set([...rules.map((rule) => samplePath(rule.path)), ...distUrls(dist)]);
  for (const path of probes) {
    const { headers, joined } = applyRules(rules, path);
    const want = expectedFor(path);
    if (joined.length)
      problems.push(`_headers ${path}  comma-joined: ${joined.join(', ')} (missing "! Header" detach line)`);
    if (header(headers, 'content-security-policy') !== want.csp)
      problems.push(`_headers ${path}  CSP is not the expected policy`);
    if (!header(headers, 'strict-transport-security')) problems.push(`_headers ${path}  HSTS missing`);
  }
  return probes.size;
}

function checkHeaders(text) {
  const rows = [];
  const rules = parseHeaders(text);
  for (const path of PATHS) {
    const { headers, joined } = applyRules(rules, path);
    const want = expectedFor(path);
    const issues = [];
    const get = (name) => header(headers, name);
    if (joined.length) issues.push(`comma-joined: ${joined.join(', ')} (missing "! Header" detach line)`);
    if (get('content-security-policy') !== want.csp) issues.push('CSP is not the expected policy');
    if (get('content-security-policy-report-only') !== want.reportOnly) issues.push('unexpected Report-Only state');
    if (get('permissions-policy') !== want.permissions) issues.push('Permissions-Policy is not the expected value');
    if (get('cross-origin-resource-policy') !== want.corp) issues.push(`CORP should be ${want.corp}`);
    if (!get('strict-transport-security')) issues.push('HSTS missing');
    if (path.startsWith('/_astro/') && !/immutable/.test(get('cache-control') ?? ''))
      issues.push('/_astro/* is not immutable');
    if (path === '/theme-boot.js' && !/max-age=3600/.test(get('cache-control') ?? ''))
      issues.push('theme-boot.js should cache for an hour');
    for (const issue of issues) problems.push(`_headers ${path}  ${issue}`);
    rows.push([
      path,
      issues.length ? 'FAIL' : 'ok',
      get('content-security-policy') === want.csp ? (want.csp === CSP_PHASE1 ? 'phase-1' : 'phase-2') : 'WRONG',
      /microphone=\(self\)/.test(get('permissions-policy') ?? '') ? 'mic=self' : 'mic=off',
      get('cross-origin-resource-policy') ?? '-',
      get('cache-control') ?? '-',
    ]);
  }
  return rows;
}

function printTable(rows) {
  const header = ['path', 'result', 'csp', 'permissions', 'corp', 'cache-control'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ');
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

// --- run --------------------------------------------------------------------------------------------------------

if (!existsSync(dist) || !statSync(dist).isDirectory()) {
  console.error(`csp-check: ${dist} does not exist. Run "astro build" first.`);
  process.exit(1);
}

let scanned = 0;
for (const file of htmlFiles(dist)) {
  checkHtml(relative(dist, file).replaceAll('\\', '/'), readFileSync(file, 'utf8'));
  scanned++;
}

const headersFile = join(dist, '_headers');
if (!existsSync(headersFile)) {
  problems.push('_headers is missing: run "node tools/headers.ts --emit apps/web/dist/_headers"');
} else {
  console.log(`csp-check: _headers simulated for phase ${PHASE}${REPORT_ONLY ? ' (CSP report-only rollout)' : ''}`);
  const text = readFileSync(headersFile, 'utf8');
  printTable(checkHeaders(text));
  const before = problems.length;
  const probed = checkEveryPath(text);
  console.log(`csp-check: ${probed} rule and dist paths traced, ${problems.length - before} problem(s)`);
}

if (problems.length) {
  console.error(`\ncsp-check: FAIL, ${problems.length} problem(s) across ${scanned} HTML file(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`csp-check: PASS, ${scanned} HTML file(s) clean, headers compose without joins`);
