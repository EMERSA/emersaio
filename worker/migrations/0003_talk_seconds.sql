-- Free talk time (worker/routes/talk.ts). quota.talk_seconds is the voice time charged to the visitor today, in
-- seconds (FREE_TALK_SECONDS_PER_DAY in worker/lib/memory.ts): a session charges its minutes when the Convai token
-- is minted and revoke refunds what was not used. session.charged_seconds is what that refund is computed from.
ALTER TABLE quota ADD COLUMN talk_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session ADD COLUMN charged_seconds INTEGER NOT NULL DEFAULT 0;
