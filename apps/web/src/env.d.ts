interface ImportMetaEnv {
  /** Origin of the site (defaults to https://emersa.io). */
  readonly PUBLIC_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
