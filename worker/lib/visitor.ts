/**
 * What the Phase 2 routes share: the database and the cookie key, or the 503 that says they are missing, and the
 * consented visitor behind a request, or the 403 that says there is none.
 */
import type { ApiContext } from './compose.ts';
import { CONSENT_VERSION, cookieVisitor } from './consent.ts';
import { fail, isLocalHost } from './http.ts';
import { getVisitor, type MemoryDb } from './memory.ts';
import { writePoint } from './metrics.ts';

export const MEMORY_OFF = 'Memory is not connected yet.';
export const NO_CONSENT = 'Start a conversation with Emily first, so we have your consent.';
export const OLD_CONSENT = 'Please read the updated notice and agree again.';

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

/**
 * The visitor id from a valid cookie whose visitor row still exists and agreed to the current notice, or a 403.
 * The routes that collect anything (turns, uploads, the brain) go through here; reading and deleting memory do
 * not, so a visitor can always see and remove their data, whatever notice they agreed to.
 */
export async function consented(c: ApiContext, s: Store): Promise<string | Response> {
  const id = await cookieVisitor(c.request, s.key);
  const row = id ? await getVisitor(s.db, id) : null;
  if (!id || !row) return fail(403, NO_CONSENT);
  if (row.consent_version !== CONSENT_VERSION) return fail(403, OLD_CONSENT);
  return id;
}

/** Secure is dropped only for wrangler dev on a local host, which serves plain http. */
export const secureCookie = (c: ApiContext): boolean => !isLocalHost(c.url.hostname);
