/**
 * Daily counters in D1: the authoritative caps behind the advisory rate limiters. One row per (scope, key, day),
 * created by worker/migrations/0001_counters.sql. The increment is a single UPSERT that returns the new value, so
 * two requests racing for the last slot cannot both win it. Days are UTC dates, so every edge counts the same day.
 */
export interface Counter {
  scope: string;
  key: string;
  /** Most events allowed per UTC day. */
  cap: number;
  /** What to tell a person once the cap is reached. */
  full: string;
}

/** The contact form: at most this many messages a day leave the Worker, whoever sends them. */
export const CONTACT_SENDS: Counter = {
  scope: 'contact',
  key: 'sends',
  cap: 40,
  full: 'The form is full for today. Please write to sales@emersa.io and we will pick it up from there.',
};

/** The part of D1 these helpers use, so a test can stand in with a small in-memory database. */
export type CounterDb = Pick<D1Database, 'prepare'>;

const DAY_MS = 86_400_000;

/** The UTC date as YYYY-MM-DD; string order is date order. */
export const dayKey = (nowMs = Date.now()): string => new Date(nowMs).toISOString().slice(0, 10);

/** For Retry-After on a daily cap: whole seconds until the next UTC midnight, at least one. */
export const secondsUntilTomorrow = (nowMs = Date.now()): number =>
  Math.max(1, Math.ceil((DAY_MS - (nowMs % DAY_MS)) / 1000));

/** Today's value, zero when nothing has been counted. */
export async function count(db: CounterDb, counter: Counter, day: string): Promise<number> {
  const n = await db
    .prepare('SELECT n FROM counters WHERE scope = ? AND key = ? AND day = ?')
    .bind(counter.scope, counter.key, day)
    .first<number>('n');
  return typeof n === 'number' ? n : 0;
}

/** Add one and return the new value, atomically. */
export async function increment(db: CounterDb, counter: Counter, day: string): Promise<number> {
  const n = await db
    .prepare(
      'INSERT INTO counters (scope, key, day, n) VALUES (?, ?, ?, 1) ON CONFLICT (scope, key, day) DO UPDATE SET n = n + 1 RETURNING n',
    )
    .bind(counter.scope, counter.key, day)
    .first<number>('n');
  if (typeof n !== 'number') throw new Error('counters: the increment returned no value');
  return n;
}

/** What reserve() answers: whether the slot this request took is within the cap, and the day's count after it. */
export interface Slot {
  allowed: boolean;
  n: number;
}

/**
 * Take one slot under the cap. The count rises even when refused, so the day's attempts stay visible; what decides
 * is whether the slot this request took is within the cap.
 */
export async function reserve(db: CounterDb, counter: Counter, day: string): Promise<Slot> {
  const n = await increment(db, counter, day);
  return { allowed: n <= counter.cap, n };
}

/** Keep the latest `keepDays` days (today counts as one) and delete the rest; returns how many rows went. */
export async function purgeCounters(db: CounterDb, nowMs: number, keepDays: number): Promise<number> {
  const cutoff = dayKey(nowMs - (keepDays - 1) * DAY_MS);
  const result = await db.prepare('DELETE FROM counters WHERE day < ?').bind(cutoff).run();
  return result.meta.changes;
}

export interface CounterTotal {
  scope: string;
  key: string;
  days: number;
  total: number;
}

/** What is left, summed per counter, for the nightly log line. */
export async function counterTotals(db: CounterDb): Promise<CounterTotal[]> {
  const { results } = await db
    .prepare(
      'SELECT scope, key, count(*) AS days, sum(n) AS total FROM counters GROUP BY scope, key ORDER BY scope, key',
    )
    .all<CounterTotal>();
  return results;
}
