# emersa.io

The Emersa Labs website: an Astro static shell, the `@emersa/being` avatar runtime (Emily Wilson as a wire head
of glowing triangles over a Kinect-style point-cloud body, who guides, speaks and, from Phase 2, listens and
remembers), and one Cloudflare Worker as the edge middleware for `/api/*`. One npm-workspaces monorepo, all
TypeScript, deployed by Cloudflare Workers Builds from GitHub.

Read `docs/CONVENTIONS.md` before writing code. The build enforces most of it.

## Features

- The being: a skinned, morphing figure drawn as a wire head and a Kinect-style point-cloud body (`hybrid`, or
  `kinect` and `wire`), with a glossy ribbon, a floor reflection and a rim light behind it; recoloured by the
  theme tokens, stepped down a quality ladder when frames drop, still under reduced motion.
- The scripted tour: nine stops with baked voice clips, lip-sync and captions, resumable from `?tour=`.
- Every page works without JavaScript; the contact form posts through the Worker (Postmark) with bot checks.
- Dark navy by default, creamy white in light mode, an orange accent; one token file drives the page and the
  3D scene alike.
- A strict static CSP with zero inline scripts or styles, exact byte budgets and Lighthouse gates on every build.

## Quick commands

```bash
npm ci                      # Node 24 (.node-version), exact pins
npm run dev                 # astro dev for apps/web (stop it with "npm exec -w apps/web -- astro dev stop")
npm run dev:worker          # wrangler dev on 8850: the site through the Worker, _headers applied
npm run check               # astro check, tsc for worker and tools, biome ci
npm test                    # node --test: worker, packages/being, tools (the _headers simulator)
npm run build               # astro build, then _headers, csp-check, preflight, bundle-budget
npm run headers             # regenerate apps/web/dist/_headers alone (SITE_PHASE=2 for the Talk block)
node scripts/og.mjs         # render apps/web/public/og.png with the installed Edge (manual)
npx lhci autorun            # Lighthouse CI against dist (mobile, slow 4G, budgets)
```

Browser checks (headless Microsoft Edge through `playwright-core`, no browser download), after a build:

```bash
node tests/browser/metrics.mjs          # errors, CSP, LCP = h1, no early /api, overflow, theme, menu without JS
node tests/browser/a11y.mjs             # axe with color-contrast, both themes
node tests/browser/tour-smoke.mjs       # the scripted tour starts, captions move, Next, Escape, ?tour= resume
node tests/browser/gpu-look.mjs         # real GPU (D3D11 Edge): errors, renderer string, every page in both themes
node tests/browser/pixels.mjs           # real GPU: the stage box within 2 levels of the page colour, both themes
node tests/browser/form-test.mjs 8850   # the contact form against wrangler dev (JS on and off, bot checks, CSP reports)
bash tests/browser/probe.sh 8850        # headers, traversal, 404s, methods, body caps against wrangler dev
```

`metrics`, `a11y` and `tour-smoke` serve `apps/web/dist` themselves unless given `--base <url>` or a port.
`form-test.mjs` and `probe.sh` test the Worker, so they need one running (`npm run dev:worker`, then pass `8850`):
the static server answers 405 to every POST. Screenshots land in `tests/browser/out/`. Lighthouse needs Chrome or
Edge: set `CHROME_PATH` to `msedge.exe` on a machine without Chrome.

## Layout

```text
apps/web/        Astro 7 shell: pages, components, styles (tokens.css), content, scripts, public/
packages/being/  @emersa/being: stage, avatar, face, data (cloud, depth sources, ribbon, floor), brain, speech, tour
worker/          the Worker: index.ts, lib/, routes/, migrations/ (D1), scheduled.ts
tools/           build-time TypeScript run by Node directly: headers.ts (+ test), avatar/ pipeline
scripts/         plain .mjs build steps: postbuild, csp-check, preflight, bundle-budget, og
tests/browser/   playwright-core checks, a static server that applies _headers, probe.sh
docs/            CONVENTIONS, ADRs, runbooks, security/dpia.md
wrangler.jsonc   the Worker: assets, bindings, env.beta;  lighthouserc.json + budgets.json: the CI gates
```

## Phases

1. **Site and scripted guide** (now): every page works without JavaScript; Emily gives a nine-stop tour with
   baked voice clips and captions; contact form through the Worker and Postmark; strict static CSP with zero
   inline scripts or styles. Launchable at milestone M1 with a captions-only tour.
2. **Play**: one tap, consent, microphone, Turnstile, a one-hour Convai token minted by the Worker, live
   conversation with lip-sync, memory in D1 (EU) with "What you remember about me" and "Forget me".
   `SITE_PHASE=2` turns on the home-page header block; the new origins run 48 hours as Report-Only first.
3. **Beings elsewhere**: the runtime on `/demo/emily` and in any future demo. The metaverse is out of scope for
   this site.

## The Kinect cloud

The body is a point cloud made the way three's `webgl_video_kinect` example makes one: a grid of points reads a
depth texture and lands along the camera rays. By default the depth is the being's own (`BeingDepthSource`), so
the cloud sits on the figure and follows her face and bones. The same cloud takes a grey depth video
(`VideoDepthSource`) or a live Kinect through a Kinectron server (`KinectronDepthSource`), all from
`@emersa/being/depth`; `handle.setLook('kinect' | 'hybrid' | 'wire')` switches the look and `handle.kinect` tunes
clipping, point size and z offset. The development harness at `/dev/kinect` (under `npm run dev` only; the build
removes it) loads a local copy of the MIT Kinectron client from `apps/web/public/dev/`, never from a CDN. Why and
how: `docs/ADR-0005-kinect-cloud.md` and `docs/runbooks/kinectron.md`.

## Headers, budgets and gates

- `tools/headers.ts` is the one source of every static response header and emits `_headers` with Cloudflare
  detach lines (ADR-0004). `scripts/csp-check.mjs` simulates the result after every build.
- Budgets (plan 4.6): 16 KB gz of JavaScript before any interaction on `/`, 4 KB on content pages, three.js
  chunk 195 KB, `@emersa/being` 30 KB. `budgets.json` carries the page-level numbers for both
  `scripts/bundle-budget.mjs` (exact gzip body sizes) and Lighthouse CI; `lighthouserc.json` repeats them as
  `resource-summary` assertions in an `assertMatrix` for `/` and `/docs`, with a per-request header allowance on
  the script gate because Lighthouse measures transfer size, since Lighthouse 12 dropped its budgets setting.
- Gates: Lighthouse mobile 95 / 100 / 100 / 100, zero CSP violations, zero console errors, `<h1>` as the LCP.

## Documents

- Decisions: `docs/ADR-0001-being-first.md`, `ADR-0002-webgl-glsl-not-webgpu.md`, `ADR-0003-no-clientrouter.md`,
  `ADR-0004-headers-detach.md`, `ADR-0005-kinect-cloud.md`.
- Runbooks: `docs/runbooks/secrets.md`, `deploy.md`, `rotate-keys.md`, `dns-records.md`, `partner-permissions.md`,
  `inputs-needed.md`, `lessons.md`, `kinectron.md`.
- Privacy: `docs/security/dpia.md`; the policy itself is `/privacy` on the site.
