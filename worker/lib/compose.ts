/**
 * The middleware chain in front of every /api/* handler. compose() turns a list of middlewares and a handler into
 * one Handler for the route table in worker/index.ts; each middleware either answers itself or calls next().
 *
 * The order index.ts uses is the plan's: traversal guard, host check, same-site check, body cap, advisory limiter,
 * D1 quota, handler. The same-site check sits before the body is read because it needs only headers; refusing a
 * cross-site post before reading its body is cheaper and gives it nothing.
 */
import type { Env } from './env.ts';
import {
  fail,
  type Handler,
  isLocalHost,
  looksLikeTraversal,
  notFound,
  readFields,
  SITE_HOST,
  siteOf,
} from './http.ts';
import { writePoint } from './metrics.ts';
import { type Counter, count, dayKey, secondsUntilTomorrow } from './quota.ts';

export interface ApiContext {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly url: URL;
  /** Short route name for metrics ("contact", "csp"): from the route table, never from the visitor. */
  readonly route: string;
  /** Flat string fields of the body, filled by readBody(); empty before it runs. */
  fields: Readonly<Record<string, string>>;
}

export type Next = () => Promise<Response>;
export type Middleware = (c: ApiContext, next: Next) => Promise<Response>;
export type RouteHandler = (c: ApiContext) => Response | Promise<Response>;

export const compose =
  (route: string, middlewares: readonly Middleware[], handler: RouteHandler): Handler =>
  (request, env, ctx) => {
    const c: ApiContext = { request, env, ctx, url: new URL(request.url), route, fields: {} };
    const run = async (index: number): Promise<Response> => {
      const middleware = middlewares[index];
      return middleware ? middleware(c, () => run(index + 1)) : handler(c);
    };
    return run(0);
  };

/** Encoded climbs are refused here as well as in index.ts, so a chain is safe wherever it is mounted. */
export const traversalGuard: Middleware = async (c, next) => (looksLikeTraversal(c.url.pathname) ? notFound() : next());

/**
 * In production only the real host (and wrangler dev's local hosts) is served by the API; a request that reached
 * the Worker under any other name gets the same 404 an unknown route gets. Beta runs on a workers.dev address
 * this file cannot know, so there the check is off.
 */
export const hostCheck: Middleware = async (c, next) => {
  if (c.env.ENV === 'production' && c.url.hostname !== SITE_HOST && !isLocalHost(c.url.hostname)) return notFound();
  return next();
};

/** Read the body into c.fields, or answer 411, 413, 415 or 400 without reading it. */
export const readBody =
  (maxBytes: number): Middleware =>
  async (c, next) => {
    const fields = await readFields(c.request, maxBytes);
    if (fields instanceof Response) return fields;
    c.fields = fields;
    return next();
  };

export interface SameSiteOptions {
  /**
   * Let a state-changing request through when neither Origin nor Sec-Fetch-Site was sent. Off by default: a
   * browser form always sends both, so a headerless POST is a script. On for the CSP endpoint, whose reports some
   * browsers send with fewer headers than a form, and where a stray report costs one counted point.
   */
  allowHeaderless?: boolean;
}

/**
 * Cross-site requests are refused before anything is read. Reads (GET, HEAD) change nothing and pass; for every
 * other method the sending site must be ours, as the browser reports it in Origin and Sec-Fetch-Site.
 */
export const sameSiteOnly =
  (options: SameSiteOptions = {}): Middleware =>
  async (c, next) => {
    if (c.request.method === 'GET' || c.request.method === 'HEAD') return next();
    const site = siteOf(c.request);
    if (site === 'same' || (site === 'unknown' && options.allowHeaderless)) return next();
    writePoint(c.env, c.route, '403');
    return fail(403, 'Requests from other sites are not accepted.');
  };

export type LimiterName = 'CONTACT_LIMITER' | 'CSP_LIMITER';

/**
 * The Cloudflare rate limiter named in wrangler.jsonc, when bound. It is advisory (per location, eventually
 * consistent), so it fails open: unavailable means "allow", and the daily cap in D1, which the handler enforces,
 * remains the authoritative layer. Every 429 is counted.
 */
export const rateLimit =
  (name: LimiterName): Middleware =>
  async (c, next) => {
    const limiter = c.env[name];
    if (!limiter) return next();
    let allowed = true;
    try {
      const key = c.request.headers.get('cf-connecting-ip') ?? 'unknown';
      allowed = (await limiter.limit({ key })).success;
    } catch (error) {
      console.error(`${c.route}: limiter unavailable`, error instanceof Error ? error.message : 'unknown');
    }
    if (allowed) return next();
    writePoint(c.env, c.route, '429');
    return fail(429, 'Too many requests from your connection. Please wait a minute and try again.', {
      'Retry-After': '60',
    });
  };

/**
 * The daily cap in D1, when the database is bound. This is the cheap read, so a full day is answered before the
 * handler runs; the handler takes its slot with reserve(), the atomic check, which decides. A database error
 * passes the request on, and the handler says what a database that cannot answer means for its route (the
 * contact form sends nothing without its cap).
 */
export const quota =
  (counter: Counter): Middleware =>
  async (c, next) => {
    const db = c.env.MEMORY;
    if (!db) return next();
    try {
      if ((await count(db, counter, dayKey())) >= counter.cap) {
        writePoint(c.env, c.route, '503-cap');
        return fail(503, counter.full, { 'Retry-After': String(secondsUntilTomorrow()) });
      }
    } catch (error) {
      console.error(`${c.route}: quota check failed`, error instanceof Error ? error.message : 'unknown');
    }
    return next();
  };
