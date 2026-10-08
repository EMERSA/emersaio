/**
 * Visitor memory in D1 (worker/migrations/0002_memory.sql): the visitor and their consent, sessions, turns, facts,
 * attached documents and the per-visitor daily caps. Times are epoch milliseconds; days are UTC YYYY-MM-DD.
 */
import { dayKey } from './quota.ts';

export type MemoryDb = Pick<D1Database, 'prepare' | 'batch'>;

export const MAX_SESSIONS_PER_DAY = 20;
export const MAX_TURNS_PER_DAY = 200;
export const MAX_UPLOADS_PER_DAY = 10;
export const MAX_TURNS_PER_SESSION = 40;
export const SESSION_MINUTES = 20;
export const RECENT_TURNS = 50;
export const MAX_TURN_CHARS = 2000;
/** Visitors idle this long are purged by the nightly job. */
export const RETENTION_MS = 365 * 86_400_000;

export const newId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Create the visitor or refresh it, recording the consent version they agreed to. */
export async function recordConsent(db: MemoryDb, id: string, version: number, nowMs = Date.now()): Promise<void> {
  await db
    .prepare(
      'INSERT INTO visitor (id, created_at, consent_version, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET consent_version = excluded.consent_version, last_seen = excluded.last_seen',
    )
    .bind(id, nowMs, version, nowMs)
    .run();
}

export interface VisitorRow {
  id: string;
  created_at: number;
  consent_version: number;
  last_seen: number;
}

export const getVisitor = (db: MemoryDb, id: string): Promise<VisitorRow | null> =>
  db
    .prepare('SELECT id, created_at, consent_version, last_seen FROM visitor WHERE id = ?')
    .bind(id)
    .first<VisitorRow>();

export async function touch(db: MemoryDb, id: string, nowMs = Date.now()): Promise<void> {
  await db.prepare('UPDATE visitor SET last_seen = ? WHERE id = ?').bind(nowMs, id).run();
}

export type QuotaField = 'turns' | 'sessions' | 'uploads' | 'asr_seconds';

/** Add `by` to today's field and return the new value, atomically. The field is one of four fixed names. */
export async function bump(db: MemoryDb, id: string, field: QuotaField, by = 1, nowMs = Date.now()): Promise<number> {
  const n = await db
    .prepare(
      `INSERT INTO quota (visitor_id, day, ${field}) VALUES (?, ?, ?) ON CONFLICT (visitor_id, day) DO UPDATE SET ${field} = ${field} + excluded.${field} RETURNING ${field} AS n`,
    )
    .bind(id, dayKey(nowMs), by)
    .first<number>('n');
  if (typeof n !== 'number') throw new Error('quota: the increment returned no value');
  return n;
}

export async function usage(db: MemoryDb, id: string, field: QuotaField, nowMs = Date.now()): Promise<number> {
  const n = await db
    .prepare(`SELECT ${field} AS n FROM quota WHERE visitor_id = ? AND day = ?`)
    .bind(id, dayKey(nowMs))
    .first<number>('n');
  return typeof n === 'number' ? n : 0;
}

export async function startSession(
  db: MemoryDb,
  visitorId: string,
  provider: string,
  nowMs = Date.now(),
): Promise<string> {
  const id = newId();
  await db
    .prepare('INSERT INTO session (id, visitor_id, provider, started_at) VALUES (?, ?, ?, ?)')
    .bind(id, visitorId, provider, nowMs)
    .run();
  return id;
}

export interface SessionRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  turns: number;
}

/** The visitor's newest session that has not ended. */
export const openSession = (db: MemoryDb, visitorId: string): Promise<SessionRow | null> =>
  db
    .prepare(
      'SELECT id, started_at, ended_at, turns FROM session WHERE visitor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    )
    .bind(visitorId)
    .first<SessionRow>();

export async function endSessions(db: MemoryDb, visitorId: string, nowMs = Date.now()): Promise<number> {
  const r = await db
    .prepare('UPDATE session SET ended_at = ? WHERE visitor_id = ? AND ended_at IS NULL')
    .bind(nowMs, visitorId)
    .run();
  return r.meta.changes;
}

/** One more brain turn in the session; returns the new count. */
export async function sessionTurn(db: MemoryDb, sessionId: string): Promise<number> {
  const n = await db
    .prepare('UPDATE session SET turns = turns + 1 WHERE id = ? RETURNING turns')
    .bind(sessionId)
    .first<number>('turns');
  return typeof n === 'number' ? n : 0;
}

export type Role = 'user' | 'being';

export interface TurnRow {
  role: Role;
  text: string;
  ts: number;
}

export async function addTurn(
  db: MemoryDb,
  visitorId: string,
  sessionId: string | null,
  role: Role,
  text: string,
  nowMs = Date.now(),
): Promise<void> {
  await db
    .prepare('INSERT INTO turn (visitor_id, session_id, role, text, ts) VALUES (?, ?, ?, ?, ?)')
    .bind(visitorId, sessionId, role, text.slice(0, MAX_TURN_CHARS), nowMs)
    .run();
}

/** The last `limit` turns, oldest first. */
export async function recentTurns(db: MemoryDb, visitorId: string, limit = RECENT_TURNS): Promise<TurnRow[]> {
  const { results } = await db
    .prepare('SELECT role, text, ts FROM turn WHERE visitor_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
    .bind(visitorId, limit)
    .all<TurnRow>();
  return results.reverse();
}

export const turnCount = async (db: MemoryDb, visitorId: string): Promise<number> =>
  (await db.prepare('SELECT count(*) AS n FROM turn WHERE visitor_id = ?').bind(visitorId).first<number>('n')) ?? 0;

export interface FactRow {
  key: string;
  value: string;
  confidence: number;
  ts: number;
}

export async function saveFacts(
  db: MemoryDb,
  visitorId: string,
  facts: readonly Omit<FactRow, 'ts'>[],
  nowMs = Date.now(),
): Promise<void> {
  if (facts.length === 0) return;
  await db.batch(
    facts.map((f) =>
      db
        .prepare(
          'INSERT INTO fact (visitor_id, key, value, confidence, ts) VALUES (?, ?, ?, ?, ?) ON CONFLICT (visitor_id, key) DO UPDATE SET value = excluded.value, confidence = excluded.confidence, ts = excluded.ts',
        )
        .bind(visitorId, f.key, f.value, f.confidence, nowMs),
    ),
  );
}

export async function listFacts(db: MemoryDb, visitorId: string): Promise<FactRow[]> {
  const { results } = await db
    .prepare('SELECT key, value, confidence, ts FROM fact WHERE visitor_id = ? ORDER BY key')
    .bind(visitorId)
    .all<FactRow>();
  return results;
}

export interface DocumentSummary {
  id: string;
  name: string;
  chars: number;
  ts: number;
}

export async function addDocument(
  db: MemoryDb,
  visitorId: string,
  name: string,
  text: string,
  nowMs = Date.now(),
): Promise<{ id: string; name: string; chars: number }> {
  const id = newId();
  await db
    .prepare('INSERT INTO document (id, visitor_id, name, chars, text, ts) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, visitorId, name, text.length, text, nowMs)
    .run();
  return { id, name, chars: text.length };
}

export async function listDocuments(db: MemoryDb, visitorId: string): Promise<DocumentSummary[]> {
  const { results } = await db
    .prepare('SELECT id, name, chars, ts FROM document WHERE visitor_id = ? ORDER BY ts')
    .bind(visitorId)
    .all<DocumentSummary>();
  return results;
}

/** The newest documents' text, for the brain's context, at most `maxChars` in all. */
export async function documentContext(db: MemoryDb, visitorId: string, maxChars = 6000): Promise<string> {
  const { results } = await db
    .prepare('SELECT name, text FROM document WHERE visitor_id = ? ORDER BY ts DESC LIMIT 3')
    .bind(visitorId)
    .all<{ name: string; text: string }>();
  let out = '';
  for (const d of results) {
    const room = maxChars - out.length;
    if (room <= 0) break;
    out += `Document "${d.name}":\n${d.text.slice(0, room)}\n\n`;
  }
  return out.trim();
}

const TABLES = ['document', 'quota', 'fact', 'turn', 'session'] as const;

/** Every row of one visitor, in one transaction. */
export async function deleteVisitor(db: MemoryDb, visitorId: string): Promise<void> {
  await db.batch([
    ...TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE visitor_id = ?`).bind(visitorId)),
    db.prepare('DELETE FROM visitor WHERE id = ?').bind(visitorId),
  ]);
}

/** The retention purge: visitors idle longer than RETENTION_MS and everything of theirs. Returns visitors removed. */
export async function purgeIdle(db: MemoryDb, nowMs: number): Promise<number> {
  const cutoff = nowMs - RETENTION_MS;
  const idle = 'SELECT id FROM visitor WHERE last_seen < ?';
  const results = await db.batch([
    ...TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE visitor_id IN (${idle})`).bind(cutoff)),
    db.prepare('DELETE FROM visitor WHERE last_seen < ?').bind(cutoff),
  ]);
  return results.at(-1)?.meta.changes ?? 0;
}

/** Quota rows older than yesterday serve no cap. */
export async function purgeQuota(db: MemoryDb, nowMs: number): Promise<number> {
  const r = await db
    .prepare('DELETE FROM quota WHERE day < ?')
    .bind(dayKey(nowMs - 86_400_000))
    .run();
  return r.meta.changes;
}
