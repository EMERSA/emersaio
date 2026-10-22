-- The "10 free minutes" form (worker/routes/form.ts): one claim per visitor and one per email address, ever. The
-- address itself is not kept here, only an HMAC of it (lowercased) under the visitor secret; the message with the
-- address goes to the team's inbox. No foreign key: Forget me must not reopen the claim. The nightly job deletes
-- rows older than 12 months (worker/scheduled.ts).
CREATE TABLE reward (
  visitor_id TEXT    PRIMARY KEY,
  email_hash TEXT    NOT NULL UNIQUE,
  seconds    INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
