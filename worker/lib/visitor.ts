/**
 * What the Phase 2 routes share: the database and the cookie key, or the 503 that says they are missing, and the
 * consented visitor behind a request, or the 403 that says there is none.
 */
import type { ApiContext } from './compose.ts';
import { cookieVisitor } from './consent.ts';
import { fail, isLocalHost } from './http.ts';
import { getVisitor, type MemoryDb } from './memory.ts';
import { writePoint } from './metrics.ts';

export const MEMORY_OFF = 'Memory is not connected yet.';
export const NO_CONSENT = 'Start a conversation with Emily first, so we have your consent.';

export interface Store {
  db: MemoryDb;
  key: string;
}

/** The database and the HMAC key, or a 503. */
export function store(c: ApiContext): Store | Response {
  const db = c.env.MEMORY;
  const key = c.env.VISITOR_HMAC_KEY;
  if (db && key) return { db, key };
  writePoint(c.env, c.route, '503-binding');
  return fail(503, MEMORY_OFF);
}

/** The visitor id from a valid cookie whose visitor row still exists, or a 403. */
export async function consented(c: ApiContext, s: Store): Promise<string | Response> {
  const id = await cookieVisitor(c.request, s.key);
  if (id && (await getVisitor(s.db, id))) return id;
  return fail(403, NO_CONSENT);
}

/** Secure is dropped only for wrangler dev on a local host, which serves plain http. */
export const secureCookie = (c: ApiContext): boolean => !isLocalHost(c.url.hostname);
