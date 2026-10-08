/**
 * GET /api/memory: what Emily remembers about this browser's visitor (facts, the last 50 turns, documents).
 * DELETE /api/memory: "Forget me": every row, the cookie, and Convai's memories for the end user (best effort).
 * POST /api/memory/turns: append one turn; every sixth turn distils facts from the visitor's own words.
 */
import type { ApiContext } from '../lib/compose.ts';
import { CONSENT_VERSION, clearVisitorCookie, cookieVisitor, endUserId } from '../lib/consent.ts';
import { apiBase, deleteMemories } from '../lib/convai.ts';
import { DISTILL_EVERY, distill } from '../lib/distill.ts';
import { fail, json, SECURE_HEADERS } from '../lib/http.ts';
import {
  addTurn,
  bump,
  deleteVisitor,
  getVisitor,
  listDocuments,
  listFacts,
  MAX_TURN_CHARS,
  MAX_TURNS_PER_DAY,
  type MemoryDb,
  openSession,
  recentTurns,
  saveFacts,
  touch,
  turnCount,
} from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import { secondsUntilTomorrow } from '../lib/quota.ts';
import { multiLine } from '../lib/text.ts';
import { consented, secureCookie, store } from '../lib/visitor.ts';

export const MAX_TURN_BYTES = 8192;

export async function memoryGet(c: ApiContext): Promise<Response> {
  const s = store(c);
  if (s instanceof Response) return s;
  const id = await cookieVisitor(c.request, s.key);
  const visitor = id ? await getVisitor(s.db, id) : null;
  if (!id || !visitor) return json({ ok: true, remembered: false, facts: [], turns: [], documents: [] });
  const [facts, turns, documents] = await Promise.all([
    listFacts(s.db, id),
    recentTurns(s.db, id),
    listDocuments(s.db, id),
  ]);
  return json({
    ok: true,
    remembered: true,
    consentCurrent: visitor.consent_version === CONSENT_VERSION,
    since: new Date(visitor.created_at).toISOString(),
    facts: facts.map(({ key, value }) => ({ key, value })),
    turns,
    documents: documents.map(({ id: docId, name, chars, ts }) => ({ id: docId, name, chars, ts })),
  });
}

export async function memoryDelete(c: ApiContext): Promise<Response> {
  const headers = { ...SECURE_HEADERS, 'Set-Cookie': clearVisitorCookie(secureCookie(c)) };
  const { env } = c;
  const key = env.VISITOR_HMAC_KEY;
  const id = key ? await cookieVisitor(c.request, key) : null;
  if (id && key) {
    if (env.MEMORY) await deleteVisitor(env.MEMORY, id);
    if (env.CONVAI_API_KEY) {
      const apiKey = env.CONVAI_API_KEY;
      const user = await endUserId(key, id);
      c.ctx.waitUntil(
        deleteMemories(apiKey, user, apiBase(env)).then((done) => {
          if (!done) writePoint(env, c.route, 'convai-forget-failed');
        }),
      );
    }
  }
  return new Response(null, { status: 204, headers });
}

/** Facts from the visitor's own recent words. Best effort: a failure is logged. */
export async function distillFor(db: MemoryDb, visitorId: string): Promise<void> {
  try {
    const turns = await recentTurns(db, visitorId, 30);
    await saveFacts(db, visitorId, distill(turns.filter((t) => t.role === 'user').map((t) => t.text)));
  } catch (error) {
    console.error('memory: distillation failed', error instanceof Error ? error.message : 'unknown');
  }
}

export async function memoryTurn(c: ApiContext): Promise<Response> {
  const s = store(c);
  if (s instanceof Response) return s;
  const role = c.fields.role;
  if (role !== 'user' && role !== 'being') return fail(422, 'A turn is from "user" or "being".');
  const text = multiLine(c.fields.text, MAX_TURN_CHARS + 1);
  if (!text) return fail(422, 'A turn needs text.');
  if (text.length > MAX_TURN_CHARS) return fail(413, 'That turn is too long.');
  const id = await consented(c, s);
  if (id instanceof Response) return id;
  if ((await bump(s.db, id, 'turns')) > MAX_TURNS_PER_DAY) {
    writePoint(c.env, c.route, '429-cap');
    return fail(429, 'That is all the talking for today. Please come back tomorrow.', {
      'Retry-After': String(secondsUntilTomorrow()),
    });
  }
  const session = await openSession(s.db, id);
  await addTurn(s.db, id, session?.id ?? null, role, text);
  await touch(s.db, id);
  if ((await turnCount(s.db, id)) % DISTILL_EVERY === 0) c.ctx.waitUntil(distillFor(s.db, id));
  return new Response(null, { status: 204, headers: { ...SECURE_HEADERS } });
}
