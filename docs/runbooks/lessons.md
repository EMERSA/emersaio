# Lessons carried over from krupiq

The essentials of krupiq's run-around report (`nemotron.md`), kept because every one of them cost a day there
and applies to this repository as it stands.

## Two AI tools on one tree

A second tool committed to krupiq concurrently under the same author name. It deleted documentation (restored
from history), published invented content (a pricing page with a price, "mathematically proven" claims),
flipped the theme twice, and once pointed the site's own URL at the portal host. Rules that follow:

- Check `git log` and `git status` before assuming the tree is what you left.
- Never run two tools on the same files at the same time; split by directory (this repository's engineers each
  own a path, listed in their briefs).
- Copy lives in one file (`apps/web/src/data/site.ts`). Anything a tool invents elsewhere is a defect.

## Astro's dev and preview servers daemonise

`astro dev` and `astro preview` keep running after the terminal closes. Stop them with `astro dev stop` and
`astro preview stop` run in `apps/web` (`npm exec -w apps/web -- astro dev stop`, or `--root apps/web` from the
repository root): the lock files live in `apps/web/.astro/`, so from the root the command answers "No dev server
is running" and the old one keeps serving a build from an hour ago. The same goes for
`wrangler dev`: a running instance keeps a stale asset manifest and answers 404 for new files; restart it after
every rebuild, with a fresh `--persist-to` directory if the local rate limiter starts answering "internal error".

## Hashed assets against fixed names

Files imported through Astro get a hashed URL under `/_astro/` and a one-year immutable cache, so a replaced
file is a new URL and old copies cannot linger. Files served from `public/` under a fixed name stay in browser
caches after they change: krupiq's partner logos were replaced and visitors still saw the old ones for days.
Here: everything that changes with a deploy is either hashed or short-cached by `tools/headers.ts`
(`/theme-boot.js` one hour, `/tour/*` five minutes). Put nothing else in `public/` without a cache rule.

## `_headers` appends, it does not replace

Cloudflare applies every matching `_headers` rule and comma-joins duplicate header names. krupiq set
`Cross-Origin-Resource-Policy` globally because a per-path override produced two values. This repository emits
`! Header-Name` detach lines from one TypeScript source and simulates the result in the build (ADR-0004).
Two related facts: `_headers` is read from the root of the assets directory only (a copy in a subfolder is
served as a public file and never applied), and it never applies to responses the Worker generates, which is
why every Worker response carries `SECURE_HEADERS` of its own.

## Inline scripts and the CSP

krupiq allowed one inline script by hash and the hash drifted twice; a page script Astro inlined was silently
blocked and the form fell back to full-page posts. Here there are zero inline scripts and zero inline styles,
`scripts/csp-check.mjs` fails the build on the first one, and page behaviour is loaded from `main.ts` by a
`data-*` hook rather than from a `<script>` in the page.

## Builds that run without a build

A deploy command without a build command fails with `assets.directory ... does not exist`, and a failed build
leaves the previous version serving, which looks exactly like a site that is three days behind. `preflight.mjs`
fails on a missing or empty `dist`, and the deploy script builds first. Watch the Workers Builds log, not the site.

## A static page cannot read a query string

`Astro.url.searchParams` is empty at build time. Result pages are real pages (`/contact/sent`,
`/contact/error`) the Worker redirects to; anything that varies by query is read in the browser with a
server-rendered default underneath.

## Secrets in artefacts

A krupiq release archive published a raw build directory with live storage credentials for four days, and a
build log printed a key. `preflight.mjs` scans `dist/` and `wrangler.jsonc` for key shapes, release files do not
exist here, and no build step echoes a variable. Rotate anything that was ever printed; deleting a copy does
not invalidate a key.

## Mail domains

Neither krupiq.com nor emersa.io had SPF or DMARC, so anyone could send mail that appeared to come from the
address published for vulnerability reports. `dns-records.md` has the records; tighten DMARC only after
reading the reports, because a domain that really sends mail loses mail when it is locked blind.

## Learned here, from the kinect cloud and the stage (2026-10-07)

### Shader names clash where no type checker looks

A GLSL program is a string to `tsc` and Biome. three prefixes every `ShaderMaterial` with declarations of its
own (`modelMatrix`, `viewMatrix`, `projectionMatrix`, `cameraPosition`, the `position`, `normal` and `uv`
attributes), `#include <packing>` adds functions, and GLSL ES 3.00 reserves words such as `sample`, `filter`,
`input` and `output`. Declaring one of those again, or naming a variable after a reserved word, fails only when
the program compiles in a browser: the figure is simply missing and the console holds a WebGL shader error.
Hence the kinect shader reads its texel into `depthSample`, never `sample`, the JavaScript twins in
`depthMath.ts` keep the other names in step, and every shader edit is followed by `tests/browser/gpu-look.mjs`,
which records console errors on a real GPU.

### Density comes from the depth image, not from the GLB

The guide figure is decimated to fit its budget (body 7,998 triangles and 4,088 vertices, head 3,498 and 1,825),
which is right for the wire and hopeless for a cloud made of its vertices: nothing like a Kinect scan, and a
denser GLB would break the 600 KB asset budget and the wire's density compensation. Reading the depth buffer
instead gives a regular grid (320 x 240 cells in the full tier) that owes nothing to the mesh, costs one small
depth pass, and still follows morphs and bones because that pass draws the real skinned meshes. The point of the
technique is that any depth image works; the mesh only has to be there to be seen.

### A premultiplied composite lifts the light theme

On the cream theme the canvas is transparent and the materials blend normally, so the composer's render target
holds premultiplied colour. The stock `OutputPass` encodes it as if it were straight, and every translucent
stroke drifted towards white on the page: a stage box lighter than the page around it, which
`tests/browser/pixels.mjs` measures (it fails when the box differs from the page by more than 2 levels).
`StraightOutputPass` (`stage/postprocessing.ts`) divides the alpha out before the sRGB transfer and multiplies
it back, in straight mode only: the dark theme's additive output is summed light with no coverage to undo, and
un-premultiplying it dims the halos about fourfold.
