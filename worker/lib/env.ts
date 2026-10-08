/**
 * What the Worker is given: bindings from wrangler.jsonc, secrets from `wrangler secret put` (or .dev.vars in
 * wrangler dev; see .dev.vars.example) and public vars. Runtime types come from worker-configuration.d.ts, which
 * `npm run check:worker` regenerates; secrets are not in that file, so they are declared here.
 *
 * Only ASSETS and the vars are guaranteed. Every other binding and every secret is optional: a route that needs a
 * missing one answers 503 with a human sentence (never 500), and a guard in the chain that needs a missing one is
 * skipped. The contact form counts MEMORY as something it needs: without the daily cap it answers 503 rather than
 * send (routes/contact.ts).
 */
export interface Env {
  /** The static site in apps/web/dist; every non-API request falls through to it. */
  ASSETS: Fetcher;
  /**
   * D1 "emersa-memory": daily counters now, visitor memory in Phase 2. Bound once the database exists and is
   * migrated; until then the contact form answers 503 (its daily cap lives here) and the nightly job skips.
   */
  MEMORY?: D1Database;
  /** Analytics Engine: counts by route and kind, never a visitor address (lib/metrics.ts). */
  METRICS?: AnalyticsEngineDataset;
  /** Advisory per-connection limiters (wrangler.jsonc "ratelimits"); each fails open when absent or unavailable. */
  CONTACT_LIMITER?: RateLimit;
  CSP_LIMITER?: RateLimit;
  /** POST /api/talk/session: 10 per minute per connection. */
  TALK_LIMITER?: RateLimit;
  /** POST /api/brain: 30 per minute. */
  BRAIN_LIMITER?: RateLimit;
  /** /api/memory and POST /api/talk/revoke: 60 per minute. */
  MEMORY_LIMITER?: RateLimit;
  /** POST /api/talk/upload: 5 per minute. */
  UPLOAD_LIMITER?: RateLimit;

  /** Postmark server token. Without it the contact form answers 503 and names sales@emersa.io instead. */
  POSTMARK_TOKEN?: string;
  /** Verified sender; "Emersa Labs <noreply@emersa.io>" when unset. */
  POSTMARK_FROM?: string;
  /** Where contact messages are delivered; 4d@emersa.io when unset. */
  CONTACT_TO?: string;
  /** Phase 2: keys the signed visitor id (lib/consent.ts). */
  VISITOR_HMAC_KEY?: string;
  /** Phase 2: Turnstile secret for POST /api/talk/session (lib/turnstile.ts). */
  TURNSTILE_SECRET?: string;
  /** Phase 2: Convai API key; mints the one-hour token the browser holds (lib/convai.ts). Never sent to the browser. */
  CONVAI_API_KEY?: string;
  /** Dev/test only: origin of a mock Convai (tests/browser/talk-flow.mjs). Ignored when ENV is production. */
  CONVAI_API_BASE?: string;
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
