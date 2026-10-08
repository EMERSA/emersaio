# Conventions for emersa.io

Read before writing code. These rules are enforced by the build (`scripts/csp-check.mjs`, `scripts/preflight.mjs`,
`scripts/bundle-budget.mjs`) and by review.

## Repository

- npm workspaces: `apps/web` (Astro 7 static shell), `packages/being` (`@emersa/being`, the avatar runtime),
  `worker/` (the Cloudflare Worker), `tools/` (build-time TypeScript run directly by Node 24 with type stripping:
  erasable syntax only, so no enums, namespaces or parameter properties), `scripts/` (plain `.mjs`), `tests/browser/`.
- TypeScript `~5.9` strict, ESM only, `moduleResolution: bundler`, `verbatimModuleSyntax` (use `import type`).
  Relative imports inside a package carry the `.ts` extension. The site imports the runtime as `@emersa/being`
  (source, no build step) using the subpaths in `packages/being/package.json`: `.`, `/hero-cloud`, `/tour`,
  `/brain`, `/speech`, `/audio`, `/face`, `/depth` (the kinect cloud's depth sources) and `/framing` (three-free fit maths).
- Formatting and lint: Biome (`npm run lint`). Two-space indent, single quotes, semicolons, 120 columns.
- Exact dependency pins; add a dependency only to the workspace that uses it; never add React, GSAP or a UI kit.

## Copy and content

- All copy is in `apps/web/src/data/site.ts`; legal particulars in `apps/web/src/data/legal.ts`; docs, games and
  the tour in `apps/web/src/content/`. Components never contain prose of their own.
- Plain English, no jargon, no em dashes, no unverified claims (no client logos, no ROI figures).

## HTML, CSS and security

- **Zero inline scripts and zero inline styles**: no `<script>` without `src`, no `<style>` in built HTML, no
  `style=""` attributes, no `javascript:` URLs, no `eval`. Astro component `<style>` blocks are fine (they are
  extracted to external files). Dynamic text goes through `textContent`, never `innerHTML`.
- Colours only through the tokens in `apps/web/src/styles/tokens.css`; no hard-coded hex or rgb outside that file.
  The being reads `--wire`, `--glow`, `--dot`, `--echo`, `--bg-3d` and `--bloom` through `ThemeUniforms`, plus the
  optional `--ribbon` (the ribbon) and `--rim` (the rim light and its rays), which fall back to `--glow` when a
  theme leaves them out. Translucent panels use the `.glass` utility in `global.css` rather than a `--glass`
  background and a backdrop blur declared again in every component.
- Animations use `transform` and `opacity` only; every animation respects `prefers-reduced-motion: reduce`.
- Every page works without JavaScript (content, navigation, the contact form, captions-only tour fallback).
  JavaScript enhances: `html.js` is set by `/theme-boot.js`; progressive hooks use `data-*` attributes, not ids.
- The theme is `html[data-theme="dark"|"light"]`, stored under `localStorage['em-theme']`, announced with a
  `em:theme` CustomEvent (`detail: 'dark' | 'light'`). Other storage keys: `em-tour` (tour progress, local) and
  `em-colo` (the edge location shown in the HUD, session). `/privacy` and `docs/security/dpia.md` list the same three.
- Hooks the scripts rely on: `[data-hero-canvas]`, `[data-being-stage]`, `[data-being-canvas]`, `[data-captions]`,
  `[data-hud]` with its readouts `[data-hud-depth]` and `[data-hud-points]` (blank until the cloud draws),
  `[data-tour]`, `[data-tour-start]`, `[data-tour-next]`, `[data-tour-back]`, `[data-tour-mute]`,
  `[data-tour-transcript]` (the no-script transcript, opened when no tour could be built), `[data-theme-toggle]`,
  `[data-menu]`, `[data-contact-form]`, `[data-reveal]`, `[data-marquee]` and `[data-marquee-toggle]` (the partner
  marquee and its pause control). State classes: `is-ready`,
  `is-fallback`, `is-speaking`, `is-listening`, `is-touring`, `is-open`, `is-paused` (the marquee), and for reveals
  `is-pending` (set by `main.ts` only on elements below the first screen) then `is-in`; nothing is hidden before
  `main.ts` runs. While touring, `being-mount.ts` publishes the dock's height as `--dock-h` on `<html>` (hud.css
  reads it for the page's bottom padding).
- The being is mounted by `apps/web/src/scripts/being-mount.ts` on documents whose `<main data-being="tour|talk">`
  says so. Content pages (docs, games, legal) load only `main.ts`. `apps/web/src/pages/dev/` is the development
  harness: served by `astro dev` only, removed from every build by `scripts/postbuild.mjs`.
- Every control that can start a voice clip (Start, Next, Back, Replay, Mute and their keys) calls `primeAudio()`
  from `@emersa/being/audio` first, synchronously inside the gesture: it creates and resumes the page's one shared
  AudioContext and plays the shared clip element once, the objects the runtime then plays the clips through. iOS
  refuses sound from anything a gesture has not touched. Nothing is primed under reduced motion or without a being.

## The being runtime

- `createBeing(options)` draws the figure in one of three looks (`look`): `hybrid` (wire head, point-cloud body;
  the default), `kinect` (all cloud) or `wire`. `ribbon` (default on; never in the lite tier) and `reflection`
  (default on with a fine pointer, off on touch; full tier only) add the product-shot extras; `quality` is the
  starting tier (touch starts at `balanced` at most); `echo` is deprecated and ignored. A stage under 260 px tall
  draws the wire alone, with no ribbon, floor or reflection.
- `depthSource` (or `handle.setDepthSource(source | null)`) feeds the cloud from a `DepthSource` of
  `@emersa/being/depth` instead of the being's own depth: `VideoDepthSource` or `KinectronDepthSource`. The caller
  makes and disposes it. The other new handle members are `setLook()` / `getLook()`, `kinect.setClipping(near, far)`,
  `kinect.setPointSize(px)` and `kinect.setZOffset(m)` (clipping and offset apply to sensor and video sources), and
  `stats().points` / `stats().depth`. Nothing Kinectron is bundled or loaded from a CDN; the dev harness
  `/dev/kinect` serves a local copy and never ships (`docs/runbooks/kinectron.md`, ADR-0005).

## Worker

- Every response the Worker builds carries `SECURE_HEADERS` (`worker/lib/http.ts`). `_headers` never applies to it.
- Every `/api/*` route runs through `compose()` in `worker/lib/compose.ts`: traversal guard, host check, body cap,
  same-site check (Origin + Sec-Fetch-Site), optional rate limiter, optional D1 quota, handler.
- Bindings and secrets are optional in `worker/lib/env.ts`; a missing one answers 503 with a human sentence.
- No visitor IP is ever stored. Analytics Engine receives counts only (route and kind).

## Performance

- Budgets in `scripts/bundle-budget.mjs`: pre-interaction JS on `/` ≤ 16 KB gz; three chunk ≤ 195 KB gz (warning
  from 185, and the chunk sits within 1 KB of it); `@emersa/being` ≤ 30 KB gz. Content pages ≤ 4 KB gz.
- The `<h1>` is the LCP element: canvases are `aria-hidden`, start at `opacity: 0` and fade in on `is-ready`.
- three.js is loaded with dynamic `import()` after LCP + idle on hover-capable desktops and only on tap on touch.
- Pixel ratio ≤ 1.5 on touch, ≤ 2 on desktop; bloom never runs on touch devices. The tiers (`stage/Quality.ts`):
  `full` draws the 320 x 240 cloud, the ribbon, the reflection and the rim light; `balanced` (where touch starts)
  the 160 x 120 cloud, the ribbon and the rim; `lite` the small cloud alone; `poster` nothing.

## Tests

- `npm test` runs `node --test` over `worker/**/*.test.ts`, `packages/being/test/**/*.test.ts`, `tools/**/*.test.ts`.
- Browser checks live in `tests/browser/*.mjs` and use `playwright-core` with the installed Microsoft Edge
  (`channel: 'msedge'`, headless, `--use-angle=swiftshader`). `gpu-look.mjs` (D3D11, screenshots to `out/gpu`)
  and `pixels.mjs` (the stage box within 2 levels of the page colour, both themes) run on the real GPU: use them
  after any shader change, because a GLSL error shows only when the program compiles in a browser.
