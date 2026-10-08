interface ImportMetaEnv {
  /** Origin of the site (defaults to https://emersa.io). */
  readonly PUBLIC_SITE_URL?: string;
  /** Cloudflare Turnstile site key for the Talk sheet (Phase 2). Public by design; the secret stays in the Worker. */
  readonly PUBLIC_TURNSTILE_SITEKEY?: string;
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
