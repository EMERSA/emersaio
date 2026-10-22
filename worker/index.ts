// Runtime types come from worker/worker-configuration.d.ts, which "npm run check:worker" regenerates from
// wrangler.jsonc. The separate @cloudflare/workers-types package conflicts with wrangler 4, so it is not used.
/**
 * The Worker: /api/* routes, and the fall through to the static site for everything else.
 *
 * wrangler.jsonc's run_worker_first sends only /api/* here first; pages and assets are served asset-first with
 * their _headers and reach this code only when no asset matches, in which case ASSETS answers with the 404 page.
 * Every route is a chain from lib/compose.ts in front of a handler in routes/, so each API answer has passed the
 * same guards; the router answers 404 and 405 before any chain runs, and an unknown /api/* path never falls
 * through to the assets.
 */
import { compose, hostCheck, quota, rateLimit, readBody, sameSiteOnly, traversalGuard } from './lib/compose.ts';
import type { Env } from './lib/env.ts';
import { HOME_PATHS, home } from './lib/home.ts';
import { dispatch, looksLikeTraversal, notFound, type Route } from './lib/http.ts';
import { TALK_SESSIONS } from './lib/quota.ts';
import { brain, MAX_BRAIN_BYTES } from './routes/brain.ts';
import { cspReport } from './routes/csp.ts';
import { formMinutes, MAX_FORM_BYTES } from './routes/form.ts';
import { health } from './routes/health.ts';
import { MAX_TURN_BYTES, memoryDelete, memoryGet, memoryTurn } from './routes/memory.ts';
import { payCheckout, payStatus, payWebhook } from './routes/pay.ts';
import { MAX_SESSION_BYTES, talkAllowance, talkRevoke, talkSession, talkUpload } from './routes/talk.ts';
import { runScheduled } from './scheduled.ts';

/** Every /api/* path. The key is the path after /api/, without a trailing slash. */
const API: Readonly<Record<string, Route>> = {
  health: { GET: compose('health', [traversalGuard, hostCheck], health) },
  // No readBody: the handler reads its own two content types under its own cap. Headerless posts are allowed
  // because browser reports carry fewer headers than a form; a report from elsewhere costs one counted point,
  // whatever its body holds (routes/csp.ts writes at most one per request).
  csp: {
    POST: compose(
      'csp',
      [traversalGuard, hostCheck, sameSiteOnly({ allowHeaderless: true }), rateLimit('CSP_LIMITER')],
      cspReport,
    ),
  },
  // Phase 2. Visitor caps (sessions, turns, talk time, uploads) are per visitor, so the handlers take them from D1
  // once the cookie is verified. The one sitewide counter is TALK_SESSIONS: quota() is its cheap read and the
  // handler takes the atomic slot once Convai has answered.
  'talk/session': {
    POST: compose(
      'talk-session',
      [
        traversalGuard,
        hostCheck,
        sameSiteOnly(),
        readBody(MAX_SESSION_BYTES),
        rateLimit('TALK_LIMITER'),
        quota(TALK_SESSIONS),
      ],
      talkSession,
    ),
  },
  'talk/allowance': {
    GET: compose('talk-allowance', [traversalGuard, hostCheck, rateLimit('MEMORY_LIMITER')], talkAllowance),
  },
  'talk/revoke': {
    POST: compose('talk-revoke', [traversalGuard, hostCheck, sameSiteOnly(), rateLimit('MEMORY_LIMITER')], talkRevoke),
  },
  // No readBody: multipart, read by the handler under its own 2 MB cap.
  'talk/upload': {
    POST: compose('talk-upload', [traversalGuard, hostCheck, sameSiteOnly(), rateLimit('UPLOAD_LIMITER')], talkUpload),
  },
  // Paid talk time (routes/pay.ts). The webhook comes from Stripe, not the page: no same-site check, its own
  // signature instead, and it reads its own raw body.
  // The "10 free minutes" form (routes/form.ts): mails the team, then adds the minutes.
  'form/minutes': {
    POST: compose(
      'form-minutes',
      [traversalGuard, hostCheck, sameSiteOnly(), readBody(MAX_FORM_BYTES), rateLimit('UPLOAD_LIMITER')],
      formMinutes,
    ),
  },
  'pay/checkout': {
    POST: compose('pay-checkout', [traversalGuard, hostCheck, sameSiteOnly(), rateLimit('TALK_LIMITER')], payCheckout),
  },
  'pay/status': {
    GET: compose('pay-status', [traversalGuard, hostCheck, rateLimit('MEMORY_LIMITER')], payStatus),
  },
  'pay/webhook': {
    POST: compose('pay-webhook', [traversalGuard, hostCheck], payWebhook),
  },
  brain: {
    POST: compose(
      'brain',
      [traversalGuard, hostCheck, sameSiteOnly(), readBody(MAX_BRAIN_BYTES), rateLimit('BRAIN_LIMITER')],
      brain,
    ),
  },
  memory: {
    GET: compose('memory', [traversalGuard, hostCheck, rateLimit('MEMORY_LIMITER')], memoryGet),
    DELETE: compose('memory', [traversalGuard, hostCheck, sameSiteOnly(), rateLimit('MEMORY_LIMITER')], memoryDelete),
  },
  'memory/turns': {
    POST: compose(
      'memory-turns',
      [traversalGuard, hostCheck, sameSiteOnly(), readBody(MAX_TURN_BYTES), rateLimit('MEMORY_LIMITER')],
      memoryTurn,
    ),
  },
};

/** Own keys only: a path named "constructor" or "__proto__" must not reach the table's prototype. */
const lookup = (path: string): Route | undefined => (Object.hasOwn(API, path) ? API[path] : undefined);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (looksLikeTraversal(url.pathname)) return notFound();
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice('/api/'.length).replace(/\/$/, '');
      return dispatch(lookup(path), request, env, ctx);
    }
    // The home page carries the Talk policy; lib/home.ts makes sure it is the only one (run_worker_first in
    // wrangler.jsonc sends these paths here).
    if (HOME_PATHS.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
      return home(request, env.ASSETS);
    }
    return env.ASSETS.fetch(request);
  },

  /** The nightly job (worker/scheduled.ts). Only counts are logged. */
  async scheduled(controller, env) {
    const report = await runScheduled(env, controller.scheduledTime);
    console.log(
      JSON.stringify({ scheduled: controller.cron, at: new Date(controller.scheduledTime).toISOString(), ...report }),
    );
  },
} satisfies ExportedHandler<Env>;
