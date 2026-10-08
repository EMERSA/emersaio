# ADR-0001: Being-first architecture

Status: accepted, 2026-10-07.

## Context

The product is the being: Emily Wilson as a talking, listening, remembering avatar. The marketing site is one
host for it. The same runtime has to render on `/demo/emily` and in any future demo, with a different persona
and tour script and no other change. The metaverse an earlier plan called Phase 3 is out of scope for this site.

The design panel compared three shapes: a site-first Astro project with an avatar component inside it, an
app-first single-page application, and a being-first runtime package with thin shells around it. The site also
has a hard budget: 16 KB of JavaScript before any interaction and the `<h1>` as the LCP element, while the being
itself is roughly 200 KB of three.js plus 30 KB of its own code plus a 250 to 600 KB model.

## Decision

- `packages/being` (`@emersa/being`) is a framework-agnostic TypeScript runtime on three.js. Its public
  contracts live in `src/types.ts` (`BeingHandle`, `Brain`, `SpeechIn`, `SpeechOut`, `TourScript`, `Persona`).
  It knows nothing about Astro, and about the DOM only through the canvas it is given.
- `apps/web` is a thin Astro static shell. It imports the runtime as source through the package's subpaths (no
  build step), mounts it per document from `src/scripts/being-mount.ts` when `<main data-being>` says so, and
  ships zero JavaScript on content pages beyond `main.ts`.
- `worker/` is the only server-side code: an edge middleware for `/api/*`. It never renders a page.
- Copy, legal particulars, docs and the tour are data (`site.ts`, `legal.ts`, `src/content/`), never code.

## Consequences

- The same GLB and runtime render on the home page and on `/demo/emily`; a persona is one object (`persona.ts`).
- The shell can be rebuilt or replaced without touching the being, and the being is unit-testable without a
  browser (FaceDriver blending, TokenMeter, the tour state machine, guardrails).
- Budgets are enforceable per layer: the shell's pre-interaction scripts, the being chunk and the three.js
  chunk are measured separately by `scripts/bundle-budget.mjs`.
- Two packages must stay in step: the runtime's peer dependency on three must match the site's exact pin.
- Provider adapters (Convai, NIM) live inside the runtime, so their SDK bytes must be kept out of the shell's
  load path: subpath imports only, loaded on a tap, never from `main.ts`.
