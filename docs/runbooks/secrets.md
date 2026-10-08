# Secrets

Where every credential lives, how it gets there and how often it changes. No secret is ever in a file in this
repository: `scripts/preflight.mjs` fails the build when a key shape or a secret-named `var` appears in
`wrangler.jsonc` or anything credential-shaped reaches `dist/`, and `.gitignore` covers `.dev.vars` and `.env*`.

## Names

| Secret | Phase | Read by | Notes |
| --- | --- | --- | --- |
| `POSTMARK_TOKEN` | 1 | `worker/lib/email/postmark.ts` | Server API token of the Postmark server for emersa.io, transactional stream. Sender `noreply@emersa.io`, delivery to `4d@emersa.io`. |
| `VISITOR_HMAC_KEY` | 2 | `worker/lib/consent.ts` | 32 random bytes as hex. Signs the `em_vid` cookie and derives the Convai `endUserId`. Rotating it signs every visitor out; they consent again. |
| `TURNSTILE_SECRET` | 2 | `worker/lib/turnstile.ts` | Pair of the public `TURNSTILE_SITEKEY` var, which the site build also needs as `PUBLIC_TURNSTILE_SITEKEY`. Local dev uses Cloudflare's test pair: site key `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always passes). |
| `CONVAI_API_KEY` | 2 | `worker/routes/talk.ts` | Mints the one-hour session tokens. Never reaches the browser. |
| `NVIDIA_API_KEY` | beta only | `worker/lib/providers/nim.ts` | The hosted NIM endpoint is licensed for prototyping. Production points `NIM_BASE_URL` at a self-hosted NIM. |
| `AZURE_SPEECH_KEY` | optional | `worker/lib/providers/azure.ts` | Speech S0 resource in `uksouth`, for live TTS on the NIM path. |

`POSTMARK_FROM` (default `Emersa Labs <noreply@emersa.io>`, read by `worker/lib/email/postmark.ts`) and
`CONTACT_TO` (default `4d@emersa.io`, read by `worker/routes/contact.ts`) are optional overrides, not credentials,
and production does not need them. If one is ever changed, set it with `wrangler secret put` like the names above;
`worker/lib/env.ts` and `.dev.vars.example` list both.

Public settings are `vars` in `wrangler.jsonc` (`ENV`, `NIM_BASE_URL`, `NIM_MODEL`,
`CONVAI_CHARACTER_ID`, `TURNSTILE_SITEKEY`, `PUBLIC_BRAIN`). A deploy replaces vars set in the dashboard; secrets
survive deploys. A missing secret makes its route answer 503 with a sentence (`worker/lib/env.ts`), never 500,
so the site stays up when a key is late. `POSTMARK_TOKEN` alone does not connect the form: the D1 binding `MEMORY`
must exist and be migrated first (deploy.md, D1), or the form keeps answering 503 with the token set.

## Setting one

```bash
npx wrangler secret put POSTMARK_TOKEN              # production Worker "emersaio"
npx wrangler secret put NVIDIA_API_KEY --env beta   # the beta Worker has its own copies
npx wrangler secret list
```

Secrets are per Worker and per environment, so `env.beta` needs every secret it uses set again. Locally, put
`NAME=value` lines in `.dev.vars` (gitignored) for `wrangler dev`, and in `.dev.vars.beta` for `--env beta`.

Generate `VISITOR_HMAC_KEY` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

## Secrets Store

Cloudflare's account-level Secrets Store holds a secret once and binds it to several Workers
(`secrets_store_secrets` in `wrangler.jsonc`, read with `await env.NAME.get()`). Use it when the same Postmark
or Convai key must serve more than one Worker, for example krupiq's. Until then per-Worker secrets are simpler,
and they are the only form this Worker reads: `worker/lib/env.ts` declares every secret as a plain string. A
`secrets_store_secrets` binding arrives as an object with an asynchronous `get()`, so a `POSTMARK_TOKEN` bound that
way would make the contact form count as connected while every send fails with 502. Before any name is bound
through the Store, two things must change:

1. Port krupiq's `worker/lib/secrets.ts` (`resolveSecrets`) and call it once at the top of `fetch` and `scheduled`
   in `worker/index.ts`, so routes see strings and a `get()` that throws becomes undefined, which makes the route
   answer 503 with its not-connected sentence rather than 500 or 502. No per-route resolver in `postmark.ts` or
   `contact.ts`.
2. Let `scripts/preflight.mjs` accept the 32-hex `store_id` values: its "Convai or Azure key (32 hex)" rule fails
   the build on one anywhere in `wrangler.jsonc`.

## Who can set them

The Cloudflare account owner (`4d@emersa.io`) and members with the Workers admin role. Turn on multi-factor
authentication for that account before the first secret goes in: the plan's reconnaissance found it off.
GitHub holds no Cloudflare token; Workers Builds deploys from the Cloudflare side (deploy.md).

## Rotation cadence

| Secret | Cadence | Also rotate when |
| --- | --- | --- |
| `POSTMARK_TOKEN` | 12 months | it shows in a build log, a HAR or a screenshot; someone with dashboard access leaves |
| `VISITOR_HMAC_KEY` | 24 months, announced in the Talk sheet | any suspicion of a leak |
| `TURNSTILE_SECRET` | 12 months | the widget is recreated |
| `CONVAI_API_KEY` | 6 months | before Phase 2 goes live: a Convai key sits in MAIGUI's git history (plan, Appendix B) |
| `NVIDIA_API_KEY` | 90 days | a prototype session was shared |
| `AZURE_SPEECH_KEY` | 12 months, swapping key 1 and key 2 | a leak of either key |

The procedure for each is in `rotate-keys.md`.

## Never

- a secret as a `var`, in `wrangler.jsonc`, in a workflow file or in `.env.example`;
- a secret echoed by a build step (a krupiq build log once printed a storage key);
- a provider key in the browser (MAIGUI shipped a Convai key that way); the browser only ever holds the
  one-hour Convai token minted by `/api/talk/session`.
