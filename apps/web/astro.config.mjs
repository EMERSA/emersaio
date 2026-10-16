// @ts-check
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

const site = (process.env.PUBLIC_SITE_URL || 'https://emersa.io').replace(/\/$/, '');

/**
 * The being's shaders are GLSL in template strings tagged with a glsl comment, and a minifier leaves strings alone,
 * so every comment explaining the maths would ship. In a build this strips the GLSL comments, the indentation and the
 * blank lines from those strings (none of them interpolates), before TypeScript is compiled. `astro dev` keeps the
 * readable source, so a shader error there still points at a line someone can find.
 */
function glslComments() {
  const tagged = /\/\* glsl \*\/ `([^`]*)`/g;
  /** @param {string} body */
  const strip = (body) =>
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n');
  return {
    name: 'emersa:glsl-comments',
    apply: /** @type {const} */ ('build'),
    enforce: /** @type {const} */ ('pre'),
    /** @param {string} code @param {string} id */
    transform(code, id) {
      if (!id.endsWith('.ts') || !code.includes('/* glsl */')) return null;
      const out = code.replace(tagged, (_, body) => `\`\n${strip(body)}\n\``);
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig({
  site,
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      // The development harness is not content.
      filter: (page) => !/\/dev(\/.*)?$/.test(page.replace(/\/$/, '')),
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
    plugins: [glslComments()],
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
            groups: [
              { name: 'three', test: /node_modules[\\/]three[\\/]/ },
              // The QR encoder and its two helpers, loaded on the first focus inside the QR card (tools-boot.ts).
              { name: 'qr', test: /node_modules[\\/](?:qrcode|dijkstrajs|encode-utf8)[\\/]/ },
              // The being's kinect cloud (packages/being/src/cloud), fetched after the core for the looks that draw
              // it, in one piece: the depth files it shares with the dev harness's depth sources would otherwise
              // split off into a chunk of their own that no budget counts. Nothing the core imports is listed here.
              // The sculpture look (packages/being/src/sculpture), fetched after the core for the home page.
              { name: 'sculpture', test: /packages[\\/]being[\\/]src[\\/]sculpture[\\/]/ },
              {
                name: 'cloud',
                test: /packages[\\/]being[\\/]src[\\/](?:cloud[\\/]|data[\\/](?:KinectCloud|SurfaceFluid|fluidMath|kinectGrid|depth[\\/](?:BeingDepthSource|DepthSource|depthMath))\.ts|avatar[\\/]shaders[\\/](?:kinect|kinectGrid|fluid)\.)/,
              },
            ],
          },
        },
      },
    },
    ssr: { noExternal: ['@emersa/being'] },
  },
});
