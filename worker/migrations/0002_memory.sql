-- Phase 2 visitor memory (worker/lib/memory.ts). A visitor row exists only after "Start talking" (consent), keyed
-- by the 128-bit random id inside the signed em_vid cookie. No IP, user agent or email is ever stored here.
-- Every other table hangs off visitor with ON DELETE CASCADE, but D1 does not enforce foreign keys by default,
-- so deleteVisitor() and the nightly purge delete each table explicitly as well.
-- Retention: the nightly job (worker/scheduled.ts) deletes visitors idle for 12 months; "Forget me" deletes at once.
CREATE TABLE visitor (
  id              TEXT    PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  consent_version INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);
CREATE INDEX visitor_last_seen ON visitor (last_seen);

-- One row per talk session (one Convai token). turns counts the text-brain turns, for the 40-per-session cap.
CREATE TABLE session (
  id         TEXT    PRIMARY KEY,
  visitor_id TEXT    NOT NULL REFERENCES visitor (id) ON DELETE CASCADE,
  provider   TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  turns      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX session_visitor ON session (visitor_id, started_at);

CREATE TABLE turn (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id TEXT    NOT NULL REFERENCES visitor (id) ON DELETE CASCADE,
  session_id TEXT,
  role       TEXT    NOT NULL CHECK (role IN ('user', 'being')),
  text       TEXT    NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX turn_visitor ON turn (visitor_id, ts);

CREATE TABLE fact (
  visitor_id TEXT    NOT NULL REFERENCES visitor (id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  confidence REAL    NOT NULL DEFAULT 0.5,
  ts         INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, key)
);

-- Per visitor per UTC day: the authoritative caps (turns <= 200, sessions <= 20, asr_seconds <= 600, uploads <= 10).
CREATE TABLE quota (
  visitor_id  TEXT    NOT NULL REFERENCES visitor (id) ON DELETE CASCADE,
  day         TEXT    NOT NULL,
  turns       INTEGER NOT NULL DEFAULT 0,
  sessions    INTEGER NOT NULL DEFAULT 0,
  asr_seconds INTEGER NOT NULL DEFAULT 0,
  uploads     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (visitor_id, day)
) WITHOUT ROWID;

-- Text extracted from a file the visitor attached (POST /api/talk/upload). The file itself is never stored.
CREATE TABLE document (
  id         TEXT    PRIMARY KEY,
  visitor_id TEXT    NOT NULL REFERENCES visitor (id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  chars      INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX document_visitor ON document (visitor_id, ts);
