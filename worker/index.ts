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
import { dispatch, looksLikeTraversal, notFound, type Route } from './lib/http.ts';
import { CONTACT_SENDS } from './lib/quota.ts';
import { contact, contactReplies, MAX_FORM_BYTES } from './routes/contact.ts';
import { cspReport } from './routes/csp.ts';
import { health } from './routes/health.ts';
import { runScheduled } from './scheduled.ts';

/** Every /api/* path. The key is the path after /api/, without a trailing slash. */
const API: Readonly<Record<string, Route>> = {
  health: { GET: compose('health', [traversalGuard, hostCheck], health) },
  contact: {
    POST: compose(
      'contact',
      [
        traversalGuard,
        hostCheck,
        contactReplies,
        sameSiteOnly(),
        readBody(MAX_FORM_BYTES),
        rateLimit('CONTACT_LIMITER'),
        quota(CONTACT_SENDS),
      ],
      contact,
    ),
  },
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
