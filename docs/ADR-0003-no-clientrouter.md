# ADR-0003: No ClientRouter

Status: accepted, 2026-10-07.

## Context

Astro's `ClientRouter` gives same-document navigation with view transitions. To do that it injects an inline
script and sets inline styles on elements during a transition, and it changes the script lifecycle to the
`astro:*` events. Our Content-Security-Policy is `script-src 'self'` and `style-src 'self'` with no hashes, no
nonces and no `'unsafe-inline'`. Astro's own `security.csp` feature does not support the `ClientRouter` and
emits a hash per inline block, which would make the header a build artefact of every page.

The being is mounted per document and owns a WebGL context, an audio context and the tour state. krupiq's
same-document navigation produced lifecycle bugs (a hero that stayed invisible for seconds because an entrance
hook looked for markup that a rewrite had replaced), which is the kind of defect a per-document lifecycle does
not have.

## Decision

- No `ClientRouter`, no `client:*` islands, no `astro:*` lifecycle in any script.
- Cross-document transitions come from CSS alone: `@view-transition { navigation: auto }`.
- Every document mounts its own scripts: `main.ts` on every page, `being-mount.ts` only where
  `<main data-being="tour|talk">` says so, `contact.ts` on the contact page.
- The theme is applied before paint by the external `/theme-boot.js`, never by an inline script.

## Consequences

- Navigations are full page loads. They are cheap: HTML under 16 KB, CSS cached and immutable, no JavaScript on
  content pages beyond `main.ts`, fonts cached.
- The being re-mounts when a visitor returns to `/`; tour progress survives in `localStorage['em-tour']` and the
  intro flag in `sessionStorage['em-intro']`.
- The CSP stays static for the whole site, with no hash to recompute when a template changes, and
  `scripts/csp-check.mjs` can fail the build on the first inline byte.
- Shared state across pages (theme, tour progress) must go through storage, not module scope.
