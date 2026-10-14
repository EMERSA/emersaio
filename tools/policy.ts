/**
 * The policy strings every static response and the Worker share: the Content-Security-Policy directives, the
 * Talk origins and the Permissions-Policy. Pure data with no Node imports, so tools/headers.ts (the _headers
 * generator) and worker/lib/home.ts (which answers "/" with exactly one policy) both import it and can never drift.
 */
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
 * The base policy, every path. No hash and no nonce: the site ships zero inline scripts and zero inline styles, JSON-LD is
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

/** The home page: the Talk origins added. Violations go to the Worker's /api/csp (report-uri for Firefox and Safari, report-to for Chromium). */
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
 * would trip the zero-console-errors gate on exactly the build being observed. The enforced base policy that sits
 * next to it on "/" carries the directive already.
 */
export const CSP_PHASE2_HOME_REPORT_ONLY = serialise(
  PHASE2_HOME_DIRECTIVES.filter(([name]) => name !== 'upgrade-insecure-requests'),
);

/** The named reporting group the home policy's report-to directive refers to. */
export const REPORTING_ENDPOINTS = 'csp="/api/csp"';

/**
 * krupiq's feature list. This site has no passkeys, so both publickey-credentials features are off here too; the
 * microphone is the only feature that ever opens, and only on "/" (the Speak button).
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
