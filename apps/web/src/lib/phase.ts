/**
 * The site phase, read at build time. Phase 1 is the scripted tour alone; Phase 2 adds Talk on the home page.
 * The same SITE_PHASE drives tools/headers.ts, so the markup and the CSP always agree.
 */
export const SITE_PHASE = Number(process.env.SITE_PHASE ?? 1);
export const TALK_ENABLED = SITE_PHASE >= 2;

/**
 * Cloudflare's documented always-pass Turnstile test site key, used only by `astro dev` when no key is set. A
 * production build without PUBLIC_TURNSTILE_SITEKEY gets an empty attribute and the sheet says voice is not ready.
 */
const TURNSTILE_TEST_SITEKEY = '1x00000000000000000000AA';
export const TURNSTILE_SITEKEY: string =
  import.meta.env.PUBLIC_TURNSTILE_SITEKEY || (import.meta.env.DEV ? TURNSTILE_TEST_SITEKEY : '');
