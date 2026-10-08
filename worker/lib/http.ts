/**
 * Responses the Worker builds itself, and the request checks every API route shares.
 *
 * Everything built here carries SECURE_HEADERS. The _headers file next to the static site applies to assets only,
 * never to a response the Worker generates, so the Worker sets its own on every answer it makes.
 */
import type { Env } from './env.ts';
import { writePoint } from './metrics.ts';

export const SITE_HOST = 'emersa.io';
export const SITE_ORIGIN = `https://${SITE_HOST}`;

/** Hosts wrangler dev answers on. They keep their own origin for redirects and may post from any local origin. */
export const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export const isLocalHost = (hostname: string): boolean => LOCAL_HOSTS.has(hostname);

/** On every response the Worker builds. Cache-Control is no-store; the one route that may cache overrides it. */
export const SECURE_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/** The shape every JSON answer shares, so the form script and the tests read one thing. */
export interface Reply {
  ok: boolean;
  error?: string;
}

export const json = (body: unknown, status = 200, extra: Readonly<Record<string, string>> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURE_HEADERS, ...extra },
  });

/** A refusal with a sentence a person can act on. */
export const fail = (status: number, error: string, extra?: Readonly<Record<string, string>>): Response =>
  json({ ok: false, error } satisfies Reply, status, extra);

export const noContent = (): Response => new Response(null, { status: 204, headers: { ...SECURE_HEADERS } });

export const redirect = (to: URL, status: 301 | 303 = 303): Response =>
  new Response(null, { status, headers: { Location: to.toString(), ...SECURE_HEADERS } });

export const notFound = (): Response => fail(404, 'Not found.');

export const wantsJson = (request: Request): boolean =>
  (request.headers.get('accept') ?? '').includes('application/json');

/** The media type alone, lower case, without parameters. */
export const contentType = (request: Request): string => {
  const [first = ''] = (request.headers.get('content-type') ?? '').split(';');
  return first.trim().toLowerCase();
};

/**
 * Where redirects point. In production the real host, never a Host header a client chose; on beta and in wrangler
 * dev the request's own origin, because those run on addresses this file cannot know.
 */
export function siteOrigin(request: Request, env: Pick<Env, 'ENV'>): string {
  const incoming = new URL(request.url);
  if (env.ENV !== 'production' || isLocalHost(incoming.hostname)) return incoming.origin;
  return SITE_ORIGIN;
}

/**
 * Paths that try to climb. The URL parser already collapses a literal "..", but encoded forms survive it.
 * Nothing served is private, so this closes a class of request rather than a leak.
 */
export const looksLikeTraversal = (pathname: string): boolean =>
  pathname.includes('..') ||
  pathname.includes('\\') ||
  pathname.includes(String.fromCharCode(0)) ||
  /%2e%2e|%2f|%5c|%00/i.test(pathname);

/** Only names a form or a JSON client would send; anything else (prototype names included) is dropped. */
const FIELD_NAME = /^[a-z][a-z0-9_-]{0,31}$/i;
const MAX_FIELDS = 32;

/**
 * A small request body as flat string fields, from JSON (numbers and booleans become strings) or a form. The length
 * must be declared and within `maxBytes`, so nothing large is read; anything unreadable is a 400. Returns the
 * Response to send back when the body is refused.
 */
export async function readFields(request: Request, maxBytes: number): Promise<Record<string, string> | Response> {
  const length = Number(request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return fail(411, 'That request had no length.');
  if (length > maxBytes) return fail(413, 'That request is too large.');
  const type = contentType(request);
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
    return fail(415, 'Send JSON or a form.');
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail(400, 'We could not read that request.');
  }
  if (text.length > maxBytes) return fail(413, 'That request is too large.');

  const fields: Record<string, string> = {};
  let taken = 0;
  const keep = (name: string, value: string): void => {
    if (taken >= MAX_FIELDS || !FIELD_NAME.test(name)) return;
    fields[name] = value;
    taken += 1;
  };

  if (type === 'application/json') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return fail(400, 'We could not read that request.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'Send a JSON object.');
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') keep(name, String(item));
    }
  } else {
    for (const [name, item] of new URLSearchParams(text)) keep(name, item);
  }
  return fields;
}

export type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/** The handlers for one path. GET also answers HEAD. DELETE arrives with Phase 2's memory route. */
export interface Route {
  GET?: Handler;
  POST?: Handler;
  DELETE?: Handler;
}

const allowed = (route: Route): string =>
  [...(route.GET ? ['GET', 'HEAD'] : []), ...(route.POST ? ['POST'] : []), ...(route.DELETE ? ['DELETE'] : [])].join(
    ', ',
  );

/**
 * Whether an Origin may send a state-changing request: the real site, the request's own origin (a victim's browser
 * never sends a forged Host, so this is not an opening), and, only when the request itself is to a local host, any
 * local origin, for wrangler dev and the browser tests.
 */
function originAllowed(origin: string, request: Request): boolean {
  const incoming = new URL(request.url);
  if (origin === SITE_ORIGIN || origin === incoming.origin) return true;
  if (!isLocalHost(incoming.hostname)) return false;
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Where a request came from, as far as its headers say. Browsers name the sending site in Origin and
 * Sec-Fetch-Site, and a page elsewhere can make a visitor's browser send a POST here, so either header naming
 * another site is "other" ("null" included). "unknown" means neither header was sent: a script, not a browser.
 */
export function siteOf(request: Request): 'same' | 'other' | 'unknown' {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return 'other';
  const origin = request.headers.get('origin');
  if (origin !== null) return originAllowed(origin, request) ? 'same' : 'other';
  return site === null ? 'unknown' : 'same';
}

/** The response with any security header it lacks added, for answers a handler built some other way. */
export function secured(response: Response): Response {
  const missing = Object.entries(SECURE_HEADERS).filter(([name]) => !response.headers.has(name));
  if (missing.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of missing) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Run the handler for the request's method: 404 without a route, 405 with Allow for a method the route lacks.
 * HEAD runs GET without a body. A handler that throws answers a JSON 500 that still carries the headers above,
 * because the platform's own error page carries none of them.
 */
export async function dispatch(
  route: Route | undefined,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!route) return notFound();
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  // Only the three names: a method called "constructor" must not reach the object's prototype.
  const handler = method === 'GET' || method === 'POST' || method === 'DELETE' ? route[method] : undefined;
  if (!handler) return fail(405, `Use ${allowed(route)}.`, { Allow: allowed(route) });
  let response: Response;
  try {
    response = secured(await handler(request, env, ctx));
  } catch (error) {
    console.error('api: unhandled error', error instanceof Error ? error.message : 'unknown');
    writePoint(env, new URL(request.url).pathname, '500');
    response = fail(500, 'Something went wrong on our side. Please try again in a minute.');
  }
  return request.method === 'HEAD'
    ? new Response(null, { status: response.status, headers: response.headers })
    : response;
}
