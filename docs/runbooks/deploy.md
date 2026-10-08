# Deploy

The site deploys from GitHub through Cloudflare Workers Builds. GitHub Actions (`.github/workflows/ci.yml`)
checks, tests and builds, then runs Lighthouse and the browser checks against the build; it holds no Cloudflare
token.

## Workers Builds, one-time setup

1. Cloudflare dashboard, Workers & Pages, Create, Import a repository. Authorise the GitHub App for
   `EMERSA/emersaio`, production branch `main`.
2. Project name `emersaio`. It must equal `name` in `wrangler.jsonc`.
3. Build settings: root directory `/`, build command `npm ci && npm run build`, deploy command
   `npx wrangler deploy`. Node comes from `.node-version` (24.18.0).
4. Build variables: none in Phase 1. For Phase 2 add `SITE_PHASE=2`, and `CSP_ROLLOUT=report-only` for the first
   48 hours (see the rollout section). Secrets are not build variables; see `secrets.md`.
5. Save and let the first build run. The log must end with `csp-check: PASS`, `preflight: dist looks
   deployable` and `bundle-budget: PASS` before the deploy step. A deploy that runs without a build fails with
   `assets.directory ... does not exist`, which is the mistake preflight exists to make loud.
6. The deploy creates the bindings in `wrangler.jsonc`: `ASSETS`, the rate limiters, `METRICS`, the cron. D1 is
   commented out until the database exists (below).

## Custom domain

- Worker, Settings, Domains & Routes, Add, Custom domain: `emersa.io`. Cloudflare writes the DNS record itself;
  do not add an apex `A` or `AAAA` by hand. `emersa.io` is the only custom domain of this Worker.
- `www.emersa.io` is not a Worker domain. It is a proxied `AAAA 100::` record plus a Single Redirect rule
  (`dns-records.md`). Check: `curl -sI "https://www.emersa.io/x?y"` answers `301` to `https://emersa.io/x?y`.
- SSL/TLS: "Always Use HTTPS" on, minimum TLS 1.2. Leave Cloudflare's own HSTS switch off: the header comes
  from `_headers` and a second copy would double it.
- Security: "Under Attack" mode off. Keep verified bots allowed and "Block AI bots" off; a managed challenge
  blocks search and AI crawlers, which defeats `robots.txt`, `llms.txt` and the structured data (krupiq lesson).
- WAF, one custom rate-limiting rule: URI path starts with `/api/`, 60 requests per 10 seconds per IP, block for
  10 seconds. The `ratelimits` bindings are advisory; this rule and the D1 counters are the real caps.

## D1

```bash
npx wrangler d1 create emersa-memory --location weur     # EU; the region is fixed at creation
```

Paste the printed `database_id` into `wrangler.jsonc`, uncomment the `d1_databases` block, commit, then
`npm run db:migrate`. Do this before `npx wrangler secret put POSTMARK_TOKEN`: the form counts every send in D1,
so with a token but no bound and migrated database it answers 503 (not connected) and sends nothing, the same
answer as without the token. The cron logs that it skipped until the database exists. Beta needs its own
database and `npm run db:migrate:beta` (bindings are not inherited).

## The beta environment

`npx wrangler deploy --env beta` deploys `emersaio-beta` on its `workers.dev` subdomain (or `beta.emersa.io` as
a custom domain). Bindings are not inherited by environments, so everything non-inheritable is declared again
under `env.beta` in `wrangler.jsonc`, and its secrets are set with `--env beta`. The hosted NVIDIA NIM endpoint
is allowed here and nowhere else. For automatic beta deploys, create a second Workers Builds project on the
same repository with branch `beta` and deploy command `npx wrangler deploy --env beta`.

## After every deploy

- `bash tests/browser/probe.sh https://emersa.io`: one CSP, one Permissions-Policy, immutable assets, JSON 404s.
- `curl -s https://emersa.io/.build-info.json` names the commit that is live.
- Workers, Deployments lists versions. Roll back with `npx wrangler rollback` or the dashboard's Rollback on
  the previous version; both are instant and need no build.

## HSTS preload

Only after cutover, and only once every host under emersa.io answers HTTPS (the `www` redirect included):
submit the domain at hstspreload.org. The header already carries `preload`. Preloading is slow to undo.

## Phase 2 header rollout

1. Build and deploy with `SITE_PHASE=2` and `CSP_ROLLOUT=report-only`. The home page then carries the Phase 1
   policy enforced plus the Phase 2 policy as `Content-Security-Policy-Report-Only`, `microphone=(self)` and
   `Reporting-Endpoints` pointing at `/api/csp`.
2. Watch the `emersa_metrics` dataset (Analytics Engine SQL API, kind `csp`) for 48 hours. Every report names a
   directive and a blocked host; explain each one or fix the policy in `tools/headers.ts`.
3. At zero unexplained reports, remove `CSP_ROLLOUT` and deploy again. The policy is now enforced.
