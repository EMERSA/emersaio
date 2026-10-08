-- Daily counters: the authoritative caps behind the advisory rate limiters (worker/lib/quota.ts).
-- One row per (scope, key, day); day is the UTC date as YYYY-MM-DD, so a string comparison orders it.
-- The nightly job (worker/scheduled.ts) deletes rows older than two days. Nothing here identifies a visitor.
--
-- Applied with "npm run db:migrate" once the database exists and is bound as MEMORY in wrangler.jsonc.
-- Edit this file freely until then; afterwards add 0002 and onwards instead.
CREATE TABLE counters (
  scope TEXT    NOT NULL,
  key   TEXT    NOT NULL,
  day   TEXT    NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  PRIMARY KEY (scope, key, day)
) WITHOUT ROWID;

CREATE INDEX counters_day ON counters (day);
