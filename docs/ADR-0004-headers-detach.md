# ADR-0004: One header source with Cloudflare detach lines

Status: accepted, 2026-10-07.

## Context

Cloudflare's static assets apply `_headers` by matching every rule whose path fits the request, in file order.
When two matching rules set the same header name, the values are comma-joined, not replaced. krupiq learnt this
the hard way: a per-path `Cross-Origin-Resource-Policy` produced two conflicting values, so the header was set
once, globally, as a compromise. A joined `Content-Security-Policy` is worse than a wrong one: browsers enforce
the intersection of both policies.

This site needs real per-path differences: the social card must be embeddable from other origins, and from
Phase 2 the home page alone allows the Convai, LiveKit and Turnstile origins and the microphone. Cloudflare
provides `! Header-Name` lines that detach an inherited header before a rule sets a new value, and limits the
file to 100 rules and 2,000 characters per line. `_headers` never applies to responses the Worker generates.

## Decision

- `tools/headers.ts` is the one source of truth. It emits `apps/web/dist/_headers` at build time with a
  `! Header-Name` line before every per-path value. The file is never hand-edited; `scripts/preflight.mjs`
  checks for the generator's banner.
- The same module exports `simulate(headersText, path)`, which reproduces the inherit-and-join semantics.
  `scripts/csp-check.mjs` runs it on representative paths after every build and fails on any joined CSP,
  Permissions-Policy or CORP; `tools/headers.test.ts` proves the per-path expectations, including Phase 2.
- `SITE_PHASE=2` adds the home-page block; `CSP_ROLLOUT=report-only` ships the Phase 2 policy as
  `Content-Security-Policy-Report-Only` next to the enforced Phase 1 policy for the 48 hour observation window.
- Worker responses carry their own `SECURE_HEADERS` (`worker/lib/http.ts`): `default-src 'none'`, HSTS, nosniff,
  DENY, CORP, `no-store`. That set is deliberately small and separate because the Worker cannot import a module
  that touches the file system; `tests/browser/probe.sh` checks both sets on a running Worker.

## Consequences

- Per-path overrides are safe and provable before deploy; a forgotten detach line fails the build, not the site.
- The production check is one line: `curl -sI https://emersa.io/ | grep -ic '^content-security-policy:'` is 1.
- Detach lines are a Cloudflare feature. Moving to another host means a new emitter; the simulator tests
  would show every rule that no longer composes.
- Two header sets exist (static and Worker). They are kept in step by review and by the probe, not by code.
