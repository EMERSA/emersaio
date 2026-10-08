/**
 * The nightly job (wrangler.jsonc "triggers", 03:00 UTC): counters older than two days go, and what remains is
 * logged as totals. Both tasks are idempotent, so a run that repeats or comes late does the same work once.
 * Without the database it logs that it skipped. Visitors idle for 12 months go
 * with every row of theirs (lib/memory.ts purgeIdle), and per-visitor quota rows older than yesterday.
 */
import type { Env } from './lib/env.ts';
import { purgeIdle, purgeQuota } from './lib/memory.ts';
import { type CounterTotal, counterTotals, purgeCounters } from './lib/quota.ts';

/** Yesterday is still useful when the cap is argued about; the day before is not. */
export const KEEP_DAYS = 2;

export interface Report {
  skipped?: string;
  purged?: number | string;
  visitors?: number | string;
  quota?: number | string;
  totals?: CounterTotal[] | string;
}

const failed = (error: unknown): string =>
  `failed: ${error instanceof Error ? error.message : 'unknown'}`.slice(0, 200);

/** Everything the run does; one failing task does not stop the other. Only counts come back, never a row. */
export async function runScheduled(env: Pick<Env, 'MEMORY'>, nowMs: number): Promise<Report> {
  const db = env.MEMORY;
  if (!db) return { skipped: 'no database' };
  const report: Report = {};
  try {
    report.purged = await purgeCounters(db, nowMs, KEEP_DAYS);
  } catch (error) {
    report.purged = failed(error);
  }
  try {
    report.visitors = await purgeIdle(db, nowMs);
  } catch (error) {
    report.visitors = failed(error);
  }
  try {
    report.quota = await purgeQuota(db, nowMs);
  } catch (error) {
    report.quota = failed(error);
  }
  try {
    report.totals = await counterTotals(db);
  } catch (error) {
    report.totals = failed(error);
  }
  return report;
}
