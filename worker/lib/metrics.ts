/**
 * Counts to Analytics Engine: one point per event, carrying the route and what happened, nothing about the visitor.
 * Invocation logs are off (wrangler.jsonc), so this is the only record of 429s, 503s and CSP reports.
 */
import type { Env } from './env.ts';

/** Analytics Engine allows 5 KB of blobs per point; nothing here needs more than a short label. */
const MAX_BLOB = 256;

const clip = (value: string): string => value.slice(0, MAX_BLOB);

/**
 * Write one point when the dataset is bound: blobs [route, kind] (and an optional third detail), the route as the
 * index, a count of 1. Best effort: a full buffer or a bad point must never fail the request.
 */
export function writePoint(env: Pick<Env, 'METRICS'>, route: string, kind: string, detail?: string): void {
  const metrics = env.METRICS;
  if (!metrics) return;
  const blobs = detail === undefined ? [clip(route), clip(kind)] : [clip(route), clip(kind), clip(detail)];
  try {
    metrics.writeDataPoint({ indexes: [clip(route)], blobs, doubles: [1] });
  } catch (error) {
    console.error('metrics: point dropped', error instanceof Error ? error.message : 'unknown');
  }
}
