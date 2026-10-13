/**
 * Build-time settings of the Talk monitor. The person check (Cloudflare Turnstile) is optional: without a site key
 * the monitor skips it and the Worker, without its secret, mints sessions under tighter caps (worker/routes/talk.ts).
 */

/**
 * Cloudflare's documented always-pass Turnstile test site key, used only by `astro dev` when no key is set. A
 * production build without PUBLIC_TURNSTILE_SITEKEY gets an empty attribute and the check is skipped.
 */
const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';
export const TURNSTILE_SITEKEY: string =
  import.meta.env.PUBLIC_TURNSTILE_SITEKEY || (import.meta.env.DEV ? TURNSTILE_TEST_SITEKEY : '');
