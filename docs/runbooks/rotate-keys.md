# Rotating keys

Every rotation follows the same shape: create the new credential, set it with `wrangler secret put`, confirm the
route works, then revoke the old one. Setting a secret takes effect on the next request without a deploy, so the
window with two valid credentials is the window with zero downtime. Record the date in the table at the end.

## Postmark (`POSTMARK_TOKEN`)

1. Postmark, Servers, emersa.io, API Tokens: create a new server token.
2. `npx wrangler secret put POSTMARK_TOKEN` and paste it.
3. Send a test through the live form (or `node tests/browser/form-test.mjs` against `wrangler dev` with the new
   token in `.dev.vars`) and confirm the mail arrives at `4d@emersa.io`.
4. Delete the old token in Postmark.

## Visitor cookie key (`VISITOR_HMAC_KEY`, Phase 2)

Rotation invalidates every `em_vid` cookie: visitors lose the link to their memory until they consent again,
and the Convai `endUserId` derived from the key changes too, which orphans the memories Convai holds for the
old ids. Treat it as a planned event:

1. Add a line to the Talk sheet's notice ("memory was reset on <date>") in `site.ts`.
2. Generate a new key: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
3. `npx wrangler secret put VISITOR_HMAC_KEY`.
4. Let the orphaned D1 rows age out: wait for the 03:00 UTC run of `worker/scheduled.ts` (Phase 2 adds the
   retention purge there; today the job only purges counters), or run that purge statement yourself with
   `npx wrangler d1 execute emersa-memory --remote --command "<the DELETE from scheduled.ts>"`, or `--file` with a
   copy kept next to `worker/migrations/`. No wrangler command fires a production cron. To run the job locally,
   start `npx wrangler dev --port 8850 --test-scheduled` and request `/__scheduled?cron=0+3+*+*+*`; the asset
   layer answers that path with the 404 page unless `/__scheduled` is added to `assets.run_worker_first` in
   `wrangler.jsonc` for the session (do not commit that). `node --test worker/scheduled.test.ts` covers the logic.
5. Call Convai's delete-memories for the old ids if a list of them exists in D1 (`visitor` table).

## Turnstile (`TURNSTILE_SECRET`)

1. Cloudflare, Turnstile, the emersa.io widget: rotate the secret key (the site key stays the same).
2. `npx wrangler secret put TURNSTILE_SECRET`.
3. Open `/` and start a Talk session; the session route must answer 200, not 403.

## Convai (`CONVAI_API_KEY`)

1. Convai dashboard, API key: regenerate. Session tokens already minted stay valid for their remaining hour.
2. `npx wrangler secret put CONVAI_API_KEY`.
3. Start a Talk session end to end (token, `connect()`, first audio).
4. Before Phase 2 goes live: rotate once regardless of age, because a Convai key is present in MAIGUI's git
   history (plan, Appendix B).

## NVIDIA (`NVIDIA_API_KEY`, beta only)

1. build.nvidia.com, API keys: generate a new key, revoke the old one after step 2.
2. `npx wrangler secret put NVIDIA_API_KEY --env beta`; confirm `POST /api/brain` streams on the beta Worker.

## Azure Speech (`AZURE_SPEECH_KEY`, optional)

Azure gives every resource two keys so one can rotate while the other serves.

1. Regenerate key 2 in the portal; set it: `npx wrangler secret put AZURE_SPEECH_KEY`.
2. Confirm `POST /api/tts` answers audio. Regenerate key 1 so the retired value is dead.

## Cloudflare itself

- There is no Cloudflare API token anywhere in the repository or in GitHub. If one is ever created for a
  laptop (`wrangler login` uses OAuth instead), scope it to this account and the Workers permissions only.
- Enable multi-factor authentication on the account owner and on every member.
- Outstanding from the sibling repositories (plan, Appendix B): a GitHub token in MAIGUI's `.git/config`, a
  DigitalOcean token in cybercat backups, a storage key printed in a krupiq build log. None of them is used by
  this site, all of them should be revoked.

## Log

| Date | Secret | Done by | Note |
| --- | --- | --- | --- |
| | | | |
