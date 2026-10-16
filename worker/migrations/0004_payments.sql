-- Paid talk time (worker/routes/pay.ts). credit is a visitor's bought seconds, spent by paid sessions and given back
-- in part when one ends early, like the free time. payment records each Stripe Checkout once (its id is the Checkout
-- Session id), so a webhook delivered twice, or a webhook and the return page both confirming, credit once. It keeps
-- no card or contact details (Stripe holds those) and has no foreign key: Forget me deletes the visitor and their
-- credit, while the record of the sale stays for the accounts.
CREATE TABLE credit (
  visitor_id TEXT    PRIMARY KEY REFERENCES visitor (id) ON DELETE CASCADE,
  seconds    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE payment (
  id         TEXT    PRIMARY KEY,
  visitor_id TEXT    NOT NULL,
  seconds    INTEGER NOT NULL,
  amount     INTEGER NOT NULL,
  currency   TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

-- 1 when the session was paid for from credit: its unused time goes back to credit, not to the free day.
ALTER TABLE session ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;
