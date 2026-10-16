/**
 * What the Worker is given: bindings from wrangler.jsonc, secrets from `wrangler secret put` (or .dev.vars in
 * wrangler dev; see .dev.vars.example) and public vars. Runtime types come from worker-configuration.d.ts, which
 * `npm run check:worker` regenerates; secrets are not in that file, so they are declared here.
 *
 * Only ASSETS and the vars are guaranteed. Every other binding and every secret is optional: a route that needs a
 * missing one answers 503 with a human sentence (never 500), and a guard in the chain that needs a missing one is
 * skipped. Talk, the brain and memory count MEMORY and VISITOR_HMAC_KEY as things they need (lib/visitor.ts).
 *
 * TURNSTILE_SECRET is optional on purpose: without it POST /api/talk/session skips the person check, counts the
 * session as "unguarded" and runs on the tighter unguarded caps (lib/memory.ts capsFor: 10 sessions and 60 turns
 * a visitor a day instead of 20 and 200). The sitewide TALK_SESSIONS counter (lib/quota.ts) and the free
 * talk-time budget apply either way.
 */
export interface Env {
  /** The static site in apps/web/dist; every non-API request falls through to it. */
  ASSETS: Fetcher;
  /**
   * D1 "emersa-memory": the Talk memory (visitors, sessions, turns, facts, documents, per-visitor caps) and the
   * sitewide daily counters. Bound and migrated (worker/migrations); without it Talk answers 503 and the nightly
   * job skips.
   */
  MEMORY?: D1Database;
  /** Analytics Engine: counts by route and kind, never a visitor address (lib/metrics.ts). */
  METRICS?: AnalyticsEngineDataset;
  /** Advisory per-connection limiters (wrangler.jsonc "ratelimits"); each fails open when absent or unavailable. */
  CSP_LIMITER?: RateLimit;
  /** POST /api/talk/session: 10 per minute per connection. */
  TALK_LIMITER?: RateLimit;
  /** POST /api/brain: 30 per minute. */
  BRAIN_LIMITER?: RateLimit;
  /** /api/memory and POST /api/talk/revoke: 60 per minute. */
  MEMORY_LIMITER?: RateLimit;
  /** POST /api/talk/upload: 5 per minute. */
  UPLOAD_LIMITER?: RateLimit;

  /** Phase 2: keys the signed visitor id (lib/consent.ts). */
  VISITOR_HMAC_KEY?: string;
  /**
   * Phase 2: Turnstile secret for POST /api/talk/session (lib/turnstile.ts). Optional: unset, the route mints
   * without the check, counts the session as "unguarded" and applies the unguarded caps (see above).
   */
  TURNSTILE_SECRET?: string;
  /** Phase 2: Convai API key; mints the one-hour token the browser holds (lib/convai.ts). Never sent to the browser. */
  CONVAI_API_KEY?: string;
  /** Dev/test only: origin of a mock Convai (tests/browser/talk-flow.mjs). Ignored when ENV is production. */
  CONVAI_API_BASE?: string;
  /** Stripe secret key (sk_test_... or sk_live_...): opens Checkout and reads it back (routes/pay.ts). */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (whsec_...) for POST /api/pay/webhook. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Phase 2, dev and beta only: the hosted NIM key behind POST /api/brain. */
  NVIDIA_API_KEY?: string;

  /** "production" on emersa.io, "beta" on the preview Worker; wrangler dev runs with whichever it was started as. */
  ENV: string;
  NIM_BASE_URL: string;
  NIM_MODEL: string;
  CONVAI_CHARACTER_ID: string;
  TURNSTILE_SITEKEY: string;
  PUBLIC_BRAIN: string;
}
