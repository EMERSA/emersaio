// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

const site = (process.env.PUBLIC_SITE_URL || 'https://emersa.io').replace(/\/$/, '');

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      // Result pages of the contact form and the development harness are not content.
      filter: (page) => !/\/(contact\/(sent|error)|dev(\/.*)?)$/.test(page.replace(/\/$/, '')),
    }),
  ],
  markdown: {
    shikiConfig: { themes: { dark: 'github-dark-default', light: 'github-light-default' } },
  },
  build: {
    // /docs.html instead of /docs/index.html, so Cloudflare serves /docs without a redirect.
    format: 'file',
    // Styles stay in external files so the Content-Security-Policy keeps style-src 'self' (no inline styles).
    inlineStylesheets: 'never',
    assets: '_astro',
  },
  vite: {
    build: {
      // Never inline small assets as data: URIs.
      assetsInlineLimit: 0,
      // Astro 7 builds with Vite 8 on rolldown, whose chunking is codeSplitting groups (manualChunks is Rollup's
      // and advancedChunks the deprecated name). three.js and its addons (GLTFLoader, the meshopt decoder, the
      // bloom passes' bases) go into one chunk of their own, apart from @emersa/being, so scripts/bundle-budget.mjs
      // can hold each to its own budget.
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
          },
        },
      },
    },
    ssr: { noExternal: ['@emersa/being'] },
  },
});
