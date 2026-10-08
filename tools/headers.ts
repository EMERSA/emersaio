/**
 * The one source of truth for the HTTP headers of every static response emersa.io sends.
 *
 * Cloudflare reads apps/web/dist/_headers at deploy time and applies every rule whose path matches the request.
 * When two rules set the same header the values are comma-joined rather than replaced, so each per-path override
 * is emitted behind a "! Header-Name" detach line (ADR-0004). simulate() reproduces those semantics so the build
 * (scripts/csp-check.mjs) and the tests (headers.test.ts) can prove what a browser will actually receive.
 *
 * Worker responses (/api/*) never see this file: they carry SECURE_HEADERS from worker/lib/http.ts.
 *
 * Runs directly under Node 24 (type stripping, erasable syntax only):
 *   node tools/headers.ts --emit apps/web/dist/_headers
 *   SITE_PHASE=2 node tools/headers.ts --print
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 1 = scripted tour only. 2 = Talk: Convai, LiveKit, Turnstile and the microphone, on the home page only. */
export const PHASE = Number(process.env.SITE_PHASE ?? 1);

/**
 * CSP_ROLLOUT=report-only keeps the Phase 1 policy enforced on "/" and ships the Phase 2 policy as
 * Content-Security-Policy-Report-Only, which is the 48 hour observation the plan requires before any new origin
 * is enforced. Everything else about Phase 2 (microphone, reporting endpoint) is applied as normal.
 */
export const REPORT_ONLY = process.env.CSP_ROLLOUT === 'report-only';

/** Cloudflare's documented limits for _headers. render() refuses to emit a file that breaks them. */
export const MAX_RULES = 100;
export const MAX_LINE_LENGTH = 2000;

type Directive = readonly [name: string, value: string];

const serialise = (directives: readonly Directive[]): string =>
  directives.map(([name, value]) => (value ? `${name} ${value}` : name)).join('; ');

const extend = (directives: readonly Directive[], name: string, extra: readonly string[]): Directive[] =>
  directives.map(([n, v]): Directive => {
    if (n !== name) return [n, v];
    // 'none' cannot share a directive with a source, so the origins replace it.
    return [n, v === "'none'" ? extra.join(' ') : `${v} ${extra.join(' ')}`];
  });

/**
 * Phase 1, every path. No hash and no nonce: the site ships zero inline scripts and zero inline styles, JSON-LD is
 * data and meshopt's WASM needs only 'wasm-unsafe-eval'. Documented degrade if a style ever has to be inline:
 * style-src 'self' 'unsafe-inline'.
 */
const BASE_DIRECTIVES: readonly Directive[] = [
  ['default-src', "'none'"],
  ['script-src', "'self' 'wasm-unsafe-eval'"],
  ['style-src', "'self'"],
  ['img-src', "'self' data:"],
  ['font-src', "'self'"],
  ['media-src', "'self'"],
  ['connect-src', "'self'"],
  ['worker-src', "'self'"],
  ['manifest-src', "'self'"],
  ['frame-src', "'none'"],
  ['child-src', "'none'"],
  ['object-src', "'none'"],
  ['base-uri', "'none'"],
  ['form-action', "'self'"],
  ['frame-ancestors', "'none'"],
  ['upgrade-insecure-requests', ''],
];

export const CSP_PHASE1 = serialise(BASE_DIRECTIVES);

/** The origins the Talk feature needs (plan 4.5). Nothing else ever joins the policy without a Report-Only window. */
export const TALK_ORIGINS = {
  turnstile: ['https://challenges.cloudflare.com'],
  convai: ['https://api.convai.com', 'https://realtime-api.convai.com'],
  livekit: ['https://*.livekit.cloud', 'wss://*.livekit.cloud'],
} as const;

/** Phase 2, home page only. Violations go to the Worker's /api/csp (report-uri for Firefox and Safari, report-to for Chromium). */
const PHASE2_HOME_DIRECTIVES: readonly Directive[] = [
  ...extend(
    extend(extend(BASE_DIRECTIVES, 'script-src', TALK_ORIGINS.turnstile), 'frame-src', TALK_ORIGINS.turnstile),
    'connect-src',
    [...TALK_ORIGINS.convai, ...TALK_ORIGINS.livekit],
  ),
  ['report-uri', '/api/csp'],
  ['report-to', 'csp'],
];

export const CSP_PHASE2_HOME = serialise(PHASE2_HOME_DIRECTIVES);

/**
 * The same policy for the Report-Only observation window, without upgrade-insecure-requests: a report-only policy
 * cannot upgrade anything, browsers ignore the directive there and Chromium logs a console error about it, which
 * would trip the zero-console-errors gate on exactly the build being observed. The enforced Phase 1 policy that sits
 * next to it on "/" carries the directive already.
 */
export const CSP_PHASE2_HOME_REPORT_ONLY = serialise(
  PHASE2_HOME_DIRECTIVES.filter(([name]) => name !== 'upgrade-insecure-requests'),
);

/** The named reporting group the Phase 2 policy's report-to directive refers to. */
export const REPORTING_ENDPOINTS = 'csp="/api/csp"';

/**
 * krupiq's feature list. This site has no passkeys, so both publickey-credentials features are off here too; the
 * microphone is the only feature that ever opens, and only on "/" from Phase 2.
 */
const FEATURES = [
  'accelerometer',
  'autoplay',
  'browsing-topics',
  'camera',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'local-fonts',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-create',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
] as const;

type Feature = (typeof FEATURES)[number];

export const permissionsPolicy = (allow: Partial<Record<Feature, 'self'>> = {}): string =>
  FEATURES.map((feature) => `${feature}=(${allow[feature] ?? ''})`).join(', ');

export const PERMISSIONS_POLICY = permissionsPolicy();
export const PERMISSIONS_POLICY_TALK = permissionsPolicy({ microphone: 'self' });

export const HSTS = 'max-age=63072000; includeSubDomains; preload';

export const CACHE = {
  /** Hashed build output never changes under the same name. */
  immutable: 'public, max-age=31536000, immutable',
  /** Fixed-name files that change with a deploy: one hour, so a release is live everywhere within the hour. */
  hourly: 'public, max-age=3600',
  /** Generated data the tour and the docs search read: five minutes. */
  short: 'public, max-age=300',
  /** The social card: a day. Link previews fetch it rarely and it is only replaced on purpose. */
  daily: 'public, max-age=86400',
} as const;

export type HeaderLine = { kind: 'set'; name: string; value: string } | { kind: 'detach'; name: string };

export interface HeaderRule {
  /** A Cloudflare path pattern: "*" matches anything, ":name" one segment, otherwise literal. */
  path: string;
  comment?: string;
  lines: HeaderLine[];
}

const set = (name: string, value: string): HeaderLine => ({ kind: 'set', name, value });
const detach = (name: string): HeaderLine => ({ kind: 'detach', name });
/** A replacement for an inherited header: detach the inherited value first, then set the new one. */
const replace = (name: string, value: string): HeaderLine[] => [detach(name), set(name, value)];

const securityLines = (): HeaderLine[] => [
  set('Content-Security-Policy', CSP_PHASE1),
  set('Strict-Transport-Security', HSTS),
  set('X-Content-Type-Options', 'nosniff'),
  set('X-Frame-Options', 'DENY'),
  set('X-Permitted-Cross-Domain-Policies', 'none'),
  set('Referrer-Policy', 'strict-origin-when-cross-origin'),
  set('Permissions-Policy', PERMISSIONS_POLICY),
  set('Cross-Origin-Opener-Policy', 'same-origin'),
  set('Cross-Origin-Resource-Policy', 'same-origin'),
  set('Origin-Agent-Cluster', '?1'),
];

/** The home page override for Phase 2: the only place a third-party origin or the microphone is allowed. */
const talkLines = (reportOnly: boolean): HeaderLine[] => [
  ...(reportOnly
    ? [set('Content-Security-Policy-Report-Only', CSP_PHASE2_HOME_REPORT_ONLY)]
    : replace('Content-Security-Policy', CSP_PHASE2_HOME)),
  ...replace('Permissions-Policy', PERMISSIONS_POLICY_TALK),
  set('Reporting-Endpoints', REPORTING_ENDPOINTS),
];

/** Every rule, in the order Cloudflare applies them. */
export function build(phase: number = PHASE, reportOnly: boolean = REPORT_ONLY): HeaderRule[] {
  const rules: HeaderRule[] = [
    {
      path: '/*',
      comment: 'Security headers for every static response. The Worker sets its own on /api/* (worker/lib/http.ts).',
      lines: securityLines(),
    },
    { path: '/_astro/*', comment: 'Hashed build output.', lines: [set('Cache-Control', CACHE.immutable)] },
    {
      path: '/theme-boot.js',
      comment: 'Fixed name, first script in <head>; an hour keeps a theme fix from lagging a deploy for long.',
      lines: [set('Cache-Control', CACHE.hourly)],
    },
    { path: '/tour/*', comment: 'The tour script and its data.', lines: [set('Cache-Control', CACHE.short)] },
    {
      path: '/docs/index.json',
      comment: 'The docs index the guide reads.',
      lines: [set('Cache-Control', CACHE.short)],
    },
    {
      path: '/og.png',
      comment: 'Link previews are fetched by other origins, so the social card alone is embeddable.',
      lines: [...replace('Cross-Origin-Resource-Policy', 'cross-origin'), set('Cache-Control', CACHE.daily)],
    },
  ];
  if (phase >= 2) {
    rules.push({
      path: '/',
      comment: reportOnly
        ? 'Phase 2 Talk origins under observation: reported, not yet enforced (CSP_ROLLOUT=report-only).'
        : 'Phase 2: the Talk feature lives on the home page only.',
      lines: talkLines(reportOnly),
    });
  }
  return rules;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** What Cloudflare's parser takes for a rule path: a trimmed line that starts with "/" or with a scheme. */
const PATH_LINE = /^(?:[^\s]+:\/\/|\/)/;

const assertLine = (line: string): void => {
  if (line.length > MAX_LINE_LENGTH) {
    throw new Error(`_headers line exceeds ${MAX_LINE_LENGTH} characters: ${line.slice(0, 60)}...`);
  }
  if (/[\r\n]/.test(line)) throw new Error(`_headers line contains a line break: ${line.slice(0, 60)}...`);
};

/** The reason Cloudflare would drop a rule with this path at deploy time, or undefined when it is accepted. */
export function pathProblem(path: string): string | undefined {
  if (!PATH_LINE.test(path)) return 'a rule path must start with "/" (or a scheme)';
  const splats = (path.match(/\*/g) ?? []).length;
  if (splats > 1) return `only one "*" is allowed per rule path, found ${splats}`;
  if (splats > 0 && /:splat(?!\w)/.test(path)) return '"*" cannot be combined with a ":splat" placeholder';
  return undefined;
}

/**
 * Cloudflare's format: a path line, then indented header lines; "! Name" detaches an inherited header. Anything
 * the deploy would drop or rewrite with no more than a warning (a duplicate path, an empty value, a rule without
 * lines, a second splat) is refused here, so the file that ships is the file that was simulated.
 */
export function render(rules: readonly HeaderRule[]): string {
  if (rules.length > MAX_RULES) throw new Error(`_headers allows ${MAX_RULES} rules, got ${rules.length}`);
  const out: string[] = [
    '# Generated by tools/headers.ts. Do not edit: change the source and rebuild.',
    '# Cloudflare applies every matching rule and comma-joins duplicates; "! Name" lines detach an inherited header first.',
    '',
  ];
  const seen = new Set<string>();
  for (const rule of rules) {
    const problem = pathProblem(rule.path);
    if (problem) throw new Error(`_headers rule ${rule.path}: ${problem}`);
    if (seen.has(rule.path)) {
      throw new Error(`_headers rule ${rule.path} appears twice; Cloudflare would keep only the last one's lines`);
    }
    seen.add(rule.path);
    if (rule.lines.length === 0) throw new Error(`_headers rule ${rule.path} has no lines; Cloudflare drops it`);
    if (rule.comment) out.push(`# ${rule.comment}`);
    assertLine(rule.path);
    out.push(rule.path);
    for (const line of rule.lines) {
      if (!TOKEN.test(line.name)) throw new Error(`Invalid header name: ${line.name}`);
      if (line.kind === 'set' && !line.value.trim()) {
        throw new Error(`_headers rule ${rule.path} sets ${line.name} to nothing; Cloudflare drops the line`);
      }
      const text = line.kind === 'detach' ? `  ! ${line.name}` : `  ${line.name}: ${line.value}`;
      assertLine(text);
      out.push(text);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export const emit = (phase: number = PHASE, reportOnly: boolean = REPORT_ONLY): string =>
  render(build(phase, reportOnly));

/**
 * Parse a _headers file the way Cloudflare's deploy does (workers-shared parseHeaders and constructHeaders), so
 * what the simulator applies is what the asset worker will hold:
 *   - every line is trimmed first: indentation means nothing, and any line that starts with "/" (or a scheme)
 *     opens a new rule wherever it sits;
 *   - a detach line is "! Name", with the space; "!Name" is not a header line and is dropped;
 *   - a header line needs a name without spaces and a non-empty value, or it is dropped;
 *   - a path with two "*" (or "*" next to ":splat") drops the whole rule, lines included;
 *   - a rule without lines is dropped, and the file stops at MAX_RULES rules;
 *   - a path that appears twice keeps its first position but takes the last rule's lines.
 * Comments and blank lines are dropped. Whatever is dropped here is dropped at deploy, which is the point.
 */
export function parseHeaders(text: string): HeaderRule[] {
  const byPath = new Map<string, HeaderRule>();
  let rule: HeaderRule | undefined;
  let skipping = false;
  const commit = (): void => {
    if (rule?.lines.length) {
      const existing = byPath.get(rule.path);
      if (existing) existing.lines = rule.lines;
      else byPath.set(rule.path, rule);
    }
    rule = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.length > MAX_LINE_LENGTH) continue;
    if (PATH_LINE.test(line)) {
      commit();
      if (byPath.size >= MAX_RULES) break;
      skipping = pathProblem(line) !== undefined;
      if (!skipping) rule = { path: line, lines: [] };
      continue;
    }
    if (skipping || !rule) continue;
    const colon = line.indexOf(':');
    if (colon === -1) {
      if (line.startsWith('! ')) rule.lines.push(detach(line.slice(2).trim()));
      continue;
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!name || /\s/.test(name) || !value) continue;
    rule.lines.push(set(name, value));
  }
  commit();
  return [...byPath.values()];
}

const patternCache = new Map<string, RegExp>();

/** Cloudflare matching: "*" is a splat (anything, slashes included), ":name" is one path segment, the rest is literal. */
export function matches(pattern: string, path: string): boolean {
  let regex = patternCache.get(pattern);
  if (!regex) {
    // A rule may be scoped to a host ("https://emersa.io/*"); only the path part is matched here.
    const bare = pattern.replace(/^https?:\/\/[^/]+/, '');
    const source = bare
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z0-9_]+/g, '[^/]+'))
      .join('.*');
    regex = new RegExp(`^${source}$`);
    patternCache.set(pattern, regex);
  }
  return regex.test(path);
}

export interface Simulation {
  /** Final headers, keyed by the name as first written. */
  headers: Record<string, string>;
  /** Paths of the rules that matched, in order. */
  matched: string[];
  /** Lower-cased names that were comma-joined at least once: an override that forgot its detach line. */
  joined: string[];
}

/**
 * Apply parsed rules the way the asset worker does: every matching rule in file order; within a rule every detach
 * line runs before any set line; a name set again without a detach in between is comma-joined.
 */
export function applyRules(rules: readonly HeaderRule[], path: string): Simulation {
  const state = new Map<string, { name: string; value: string }>();
  const joined = new Set<string>();
  const matched: string[] = [];
  for (const rule of rules) {
    if (!matches(rule.path, path)) continue;
    matched.push(rule.path);
    for (const line of rule.lines) if (line.kind === 'detach') state.delete(line.name.toLowerCase());
    for (const line of rule.lines) {
      if (line.kind !== 'set') continue;
      const key = line.name.toLowerCase();
      const current = state.get(key);
      if (current) {
        current.value = `${current.value}, ${line.value}`;
        joined.add(key);
      } else {
        state.set(key, { name: line.name, value: line.value });
      }
    }
  }
  const headers: Record<string, string> = {};
  for (const { name, value } of state.values()) headers[name] = value;
  return { headers, matched, joined: [...joined] };
}

/** The headers a request for `path` receives under `headersText`. */
export const simulate = (headersText: string, path: string): Record<string, string> =>
  applyRules(parseHeaders(headersText), path).headers;

/** simulate() with the diagnostics csp-check needs. */
export const trace = (headersText: string, path: string): Simulation => applyRules(parseHeaders(headersText), path);

const usage = `usage:
  node tools/headers.ts --emit <path>   write the _headers file (SITE_PHASE=1|2, CSP_ROLLOUT=report-only)
  node tools/headers.ts --print         print it to stdout`;

function main(argv: readonly string[]): void {
  const text = emit();
  const summary = `${build().length} rules, phase ${PHASE}${REPORT_ONLY ? ', Phase 2 CSP report-only' : ''}`;
  if (argv[0] === '--print') {
    process.stdout.write(text);
    return;
  }
  if (argv[0] === '--emit' && argv[1]) {
    const target = resolve(argv[1]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    console.log(`headers: wrote ${target} (${summary})`);
    return;
  }
  console.error(usage);
  process.exit(2);
}

const entry = process.argv[1];
if (entry && pathToFileURL(resolve(entry)).href === import.meta.url) main(process.argv.slice(2));
