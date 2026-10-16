/**
 * /api/talk/session, /api/talk/revoke and /api/talk/upload through the whole chain.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { CONSENT_VERSION, verifyVisitorId } from '../lib/consent.ts';
import {
  bump,
  FREE_TALK_SECONDS_PER_DAY,
  listDocuments,
  MAX_SESSIONS_PER_DAY,
  openSession,
  UNGUARDED_SESSIONS_PER_DAY,
  usage,
} from '../lib/memory.ts';
import { count, dayKey, TALK_SESSIONS } from '../lib/quota.ts';
import { asD1, seedCounter } from '../test/d1.ts';
import { assertSecure, body, call, kinds, limiter, metrics, post, SAME_SITE } from '../test/harness.ts';
import { HMAC, seen, talkEnv, upstreams, visitor } from '../test/talk.ts';
import { MINUTES_UP, OLD_CONSENT, UNREADABLE_PDF, VOICE_BUSY, VOICE_OFF } from './talk.ts';

const SESSION = 'https://emersa.io/api/talk/session';
const UPLOAD = 'https://emersa.io/api/talk/upload';
const REVOKE = 'https://emersa.io/api/talk/revoke';
const good = JSON.stringify({ turnstile: 'tok', consentVersion: CONSENT_VERSION });
const jsonPost = (b: string, h: Record<string, string> = {}) => post(b, { ...SAME_SITE, ...h }, 'application/json');

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

test('a session: Turnstile, consent row, signed cookie with its attributes, and the Convai token', async () => {
  const { env, db } = talkEnv();
  restore = upstreams();
  const response = await call(SESSION, jsonPost(good), env);
  assert.equal(response.status, 200);
  assertSecure(response, 'session');
  const reply = await body(response);
  assert.equal(reply.ok, true);
  assert.equal(reply.provider, 'convai');
  assert.equal(reply.token, 'tok-1');
  assert.equal(reply.characterId, 'char-1');
  assert.match(String(reply.endUserId), /^[0-9a-f]{32}$/);
  assert.deepEqual(reply.session, { turnsLeft: 200, maxMinutes: 5, secondsLeft: 300 });
  assert.ok(Date.parse(String(reply.expiresAt)) > Date.now());

  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(
    cookie,
    /^em_vid=[0-9a-f]{32}\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=Lax; Path=\/api; Max-Age=34164000$/,
  );
  const id = await verifyVisitorId(HMAC, cookie.slice(7, cookie.indexOf(';')));
  assert.ok(id);
  assert.notEqual(reply.endUserId, id, 'Convai never sees the cookie id');
  const row = db.sqlite.prepare('SELECT consent_version FROM visitor WHERE id = ?').get(id);
  assert.equal(row?.consent_version, CONSENT_VERSION);
  assert.ok(await openSession(asD1(db), id ?? ''));
  assert.deepEqual(seen, [
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    'https://api.convai.com/user/connect',
  ]);
});

test('an existing cookie keeps its id; on localhost the cookie drops Secure only', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams();
  const response = await call(
    'http://localhost:8850/api/talk/session',
    jsonPost(good, { cookie: v.cookie, origin: 'http://localhost:8850' }),
    env,
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.ok(cookie.startsWith(`${v.cookie};`));
  assert.ok(!cookie.includes('Secure'));
  assert.match(cookie, /HttpOnly; SameSite=Lax; Path=\/api; Max-Age=34164000/);
});

test('a forged cookie is ignored and a new id minted', async () => {
  const { env } = talkEnv();
  restore = upstreams();
  const forged = `em_vid=${'d'.repeat(32)}.${'A'.repeat(43)}`;
  const response = await call(SESSION, jsonPost(good, { cookie: forged }), env);
  assert.equal(response.status, 200);
  assert.ok(!(response.headers.get('set-cookie') ?? '').startsWith(`em_vid=${'d'.repeat(32)}`));
});

test('session refusals: 403 cross-site and failed Turnstile, 405, 411, 413, 422, 429, 503', async () => {
  const { env, db } = talkEnv();
  restore = upstreams({ turnstile: false });
  assert.equal(
    (await call(SESSION, post(good, { origin: 'https://evil.example' }, 'application/json'), env)).status,
    403,
  );
  const failed = await call(SESSION, jsonPost(good), env);
  assert.equal(failed.status, 403);
  assert.equal(failed.headers.get('set-cookie'), null, 'no cookie without a pass');
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM visitor').get()?.n, 0);
  restore();
  restore = upstreams();

  assert.equal((await call(SESSION, { method: 'GET' }, env)).status, 405);
  assert.equal((await call(SESSION, { method: 'POST', headers: { ...SAME_SITE } }, env)).status, 411);
  assert.equal((await call(SESSION, jsonPost(JSON.stringify({ turnstile: 'x'.repeat(5000) })), env)).status, 413);
  assert.equal((await call(SESSION, jsonPost(JSON.stringify({ turnstile: 't' })), env)).status, 422);
  assert.equal((await call(SESSION, jsonPost(JSON.stringify({ turnstile: 't', consentVersion: 0 })), env)).status, 422);
  assert.equal((await call(SESSION, jsonPost(good), { ...env, TALK_LIMITER: limiter(false) })).status, 429);

  const off = await call(SESSION, jsonPost(good), { ...env, CONVAI_API_KEY: undefined });
  assert.equal(off.status, 503);
  assert.equal((await body(off)).error, VOICE_OFF);
  assert.equal((await call(SESSION, jsonPost(good), { ...env, CONVAI_CHARACTER_ID: '' })).status, 503);
  assert.equal((await call(SESSION, jsonPost(good), { ...env, MEMORY: undefined })).status, 503);
});

test('the daily session cap answers 429 with Retry-After', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  for (let i = 0; i < MAX_SESSIONS_PER_DAY; i++) await bump(asD1(db), v.id, 'sessions');
  restore = upstreams();
  const response = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
});

test('without TURNSTILE_SECRET: no siteverify call, the session is counted unguarded, and the 4th is refused', async () => {
  const m = metrics();
  const { env, db } = talkEnv({ guarded: false, METRICS: m.binding });
  const v = await visitor(db);
  restore = upstreams();
  const first = await call(
    SESSION,
    jsonPost(JSON.stringify({ consentVersion: CONSENT_VERSION }), { cookie: v.cookie }),
    env,
  );
  assert.equal(first.status, 200);
  assert.deepEqual(seen, ['https://api.convai.com/user/connect']);
  assert.ok(kinds(m).includes('unguarded'));
  assert.equal(UNGUARDED_SESSIONS_PER_DAY, 10);
  for (let i = 1; i < UNGUARDED_SESSIONS_PER_DAY; i++) {
    assert.equal((await call(SESSION, jsonPost(good, { cookie: v.cookie }), env)).status, 200, `session ${i + 1}`);
  }
  const over = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(over.status, 429);
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // The guarded deployment keeps its wider cap for the same visitor.
  const guarded = talkEnv();
  const g = await visitor(guarded.db);
  for (let i = 0; i < UNGUARDED_SESSIONS_PER_DAY; i++) await bump(asD1(guarded.db), g.id, 'sessions');
  assert.equal((await call(SESSION, jsonPost(good, { cookie: g.cookie }), guarded.env)).status, 200);
});

test('talk time: a used-up day answers 429 with reason "minutes"; a partial day shortens the session', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams();
  await bump(asD1(db), v.id, 'talk_seconds', FREE_TALK_SECONDS_PER_DAY);
  const up = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(up.status, 429);
  assert.ok(Number(up.headers.get('retry-after')) > 0);
  assert.deepEqual(await body(up), { ok: false, error: MINUTES_UP, reason: 'minutes' });
  assert.equal(seen.length, 1, 'Turnstile only: no Convai token is minted for a used-up day');

  const w = await visitor(db, 'e'.repeat(32));
  await bump(asD1(db), w.id, 'talk_seconds', 240);
  const short = await call(SESSION, jsonPost(good, { cookie: w.cookie }), env);
  assert.equal(short.status, 200);
  assert.deepEqual((await body(short)).session, { turnsLeft: 200, maxMinutes: 1, secondsLeft: 60 });
  assert.equal(await usage(asD1(db), w.id, 'talk_seconds'), 300, 'the minute is charged when the token is minted');
  const row = db.sqlite.prepare('SELECT charged_seconds FROM session WHERE visitor_id = ?').get(w.id);
  assert.equal(row?.charged_seconds, 60);
});

test('revoke refunds the charged time the session did not use, never below zero', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams();
  assert.equal((await call(SESSION, jsonPost(good, { cookie: v.cookie }), env)).status, 200);
  assert.equal(await usage(asD1(db), v.id, 'talk_seconds'), 300);
  // The session ran for 100 seconds of its five minutes.
  db.sqlite.prepare('UPDATE session SET started_at = started_at - 100000 WHERE visitor_id = ?').run(v.id);
  assert.equal((await call(REVOKE, { method: 'POST', headers: { ...SAME_SITE, cookie: v.cookie } }, env)).status, 204);
  const used = await usage(asD1(db), v.id, 'talk_seconds');
  assert.ok(used >= 100 && used <= 102, `used ${used}`);
  // A session that overran its charge refunds nothing and the counter stays where it was.
  assert.equal((await call(SESSION, jsonPost(good, { cookie: v.cookie }), env)).status, 200);
  const charged = await usage(asD1(db), v.id, 'talk_seconds');
  db.sqlite
    .prepare('UPDATE session SET started_at = started_at - 900000 WHERE visitor_id = ? AND ended_at IS NULL')
    .run(v.id);
  await call(REVOKE, { method: 'POST', headers: { ...SAME_SITE, cookie: v.cookie } }, env);
  assert.equal(await usage(asD1(db), v.id, 'talk_seconds'), charged);
});

test('an abandoned session counts only to its last line plus the grace, so a closed tab keeps the day', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams();
  assert.equal((await call(SESSION, jsonPost(good, { cookie: v.cookie }), env)).status, 200);
  // Started two hours ago, one line 30 seconds in, then the tab was closed without a revoke.
  const started = Date.now() - 7_200_000;
  db.sqlite.prepare('UPDATE session SET started_at = ? WHERE visitor_id = ?').run(started, v.id);
  db.sqlite
    .prepare("INSERT INTO turn (visitor_id, session_id, role, text, ts) VALUES (?, NULL, 'user', 'hello', ?)")
    .run(v.id, started + 30_000);
  // The next start settles it at 30 s + the 60 s grace: 90 s used, and a fresh five minutes minus that is offered.
  const next = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(next.status, 200);
  assert.equal((await body(next)).session.secondsLeft, 300 - 90);
});

test('the sitewide TALK_SESSIONS cap: the handler takes the last slot, then the chain answers 503', async () => {
  const m = metrics();
  const { env, db } = talkEnv({ METRICS: m.binding });
  restore = upstreams();
  seedCounter(db, TALK_SESSIONS, dayKey(), TALK_SESSIONS.cap - 1);
  assert.equal((await call(SESSION, jsonPost(good), env)).status, 200, 'the last slot is taken by the handler');
  const full = await call(SESSION, jsonPost(good), env);
  assert.equal(full.status, 503);
  assert.equal((await body(full)).error, TALK_SESSIONS.full);
  assert.ok(Number(full.headers.get('retry-after')) > 0);
  assert.equal(kinds(m).filter((k) => k === '503-cap').length, 1);
  assert.deepEqual(
    seen,
    ['https://challenges.cloudflare.com/turnstile/v0/siteverify', 'https://api.convai.com/user/connect'],
    'a full day is refused by the cheap read in the chain, before Turnstile or Convai is asked',
  );
});

test('Convai refusing the key or timing out answers 503 with a sentence', async () => {
  const { env } = talkEnv();
  restore = upstreams({ convai: () => new Response('no', { status: 401 }) });
  const refused = await call(SESSION, jsonPost(good), env);
  assert.equal(refused.status, 503);
  assert.equal((await body(refused)).error, VOICE_OFF);
  restore();
  restore = upstreams({
    convai: () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
  });
  const slow = await call(SESSION, jsonPost(good), env);
  assert.equal(slow.status, 503);
  assert.equal((await body(slow)).error, VOICE_BUSY);
});

test('revoke answers 204 and ends the open session', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  restore = upstreams();
  await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  const response = await call(REVOKE, { method: 'POST', headers: { ...SAME_SITE, cookie: v.cookie } }, env);
  assert.equal(response.status, 204);
  assertSecure(response, 'revoke');
  assert.equal(await openSession(asD1(db), v.id), null);
  assert.equal((await call(REVOKE, { method: 'POST', headers: { origin: 'https://evil.example' } }, env)).status, 403);
  assert.equal(
    (await call(REVOKE, { method: 'POST', headers: { ...SAME_SITE } }, talkEnv({ MEMORY: undefined }).env)).status,
    204,
  );
});

const multipart = (name: string, content: string): Request => {
  const data = new FormData();
  data.set('file', new File([content], name));
  const probe = new Request(UPLOAD, { method: 'POST', body: data });
  return probe;
};

async function upload(name: string, content: string, env: ReturnType<typeof talkEnv>['env'], cookie: string) {
  const probe = multipart(name, content);
  const bytes = await probe.arrayBuffer();
  return call(
    UPLOAD,
    {
      method: 'POST',
      body: bytes,
      headers: {
        ...SAME_SITE,
        cookie,
        'content-type': probe.headers.get('content-type') ?? '',
        'content-length': String(bytes.byteLength),
      },
    },
    env,
  );
}

/** A one-page PDF whose content stream shows `text` (uncompressed). */
export function tinyPdf(text: string): string {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  return `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n4 0 obj << /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n%%EOF`;
}

test('upload: text, markdown and a text PDF become documents; the file is not kept', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  const txt = await upload('notes.txt', 'Our team runs a museum and wants a guide.', env, v.cookie);
  assert.equal(txt.status, 200);
  const reply = await body(txt);
  assert.equal(reply.name, 'notes.txt');
  assert.equal(reply.chars, 41);
  assert.equal((await upload('readme.md', '# Title\n\nSome words here.', env, v.cookie)).status, 200);
  const pdf = await upload(
    'brief.pdf',
    tinyPdf('A brief about a synthetic being for our museum lobby.'),
    env,
    v.cookie,
  );
  assert.equal(pdf.status, 200);
  const docs = await listDocuments(asD1(db), v.id);
  assert.deepEqual(
    docs.map((d) => d.name),
    ['notes.txt', 'readme.md', 'brief.pdf'],
  );
  const stored = db.sqlite.prepare('SELECT text FROM document WHERE name = ?').get('brief.pdf');
  assert.equal(stored?.text, 'A brief about a synthetic being for our museum lobby.');
});

test('upload refusals: 403 without consent, 411, 413, 415, 422 for an unreadable PDF, 429', async () => {
  const { env, db } = talkEnv();
  const v = await visitor(db);
  assert.equal((await upload('a.txt', 'hello there', env, '')).status, 403);
  assert.equal((await call(UPLOAD, { method: 'POST', headers: { ...SAME_SITE } }, env)).status, 411);
  assert.equal(
    (
      await call(
        UPLOAD,
        {
          method: 'POST',
          body: 'x',
          headers: {
            ...SAME_SITE,
            'content-length': String(3 * 1024 * 1024),
            'content-type': 'multipart/form-data; boundary=x',
          },
        },
        env,
      )
    ).status,
    413,
  );
  assert.equal((await upload('a.exe', 'MZ', env, v.cookie)).status, 415);
  // A request without a file this route reads costs no slot; parsing a file is the work, so it takes the slot
  // whether or not the file turns out readable.
  assert.equal(await usage(asD1(db), v.id, 'uploads'), 0);
  const bad = await upload('scan.pdf', '%PDF-1.4\nnothing readable', env, v.cookie);
  assert.equal(bad.status, 422);
  assert.equal((await body(bad)).error, UNREADABLE_PDF);
  assert.equal(await usage(asD1(db), v.id, 'uploads'), 1);
  // A visitor who agreed to an older notice is asked again before anything else is taken.
  db.sqlite.prepare('UPDATE visitor SET consent_version = 0 WHERE id = ?').run(v.id);
  const stale = await upload('a.txt', 'hello there', env, v.cookie);
  assert.equal(stale.status, 403);
  assert.equal((await body(stale)).error, OLD_CONSENT);
  db.sqlite.prepare('UPDATE visitor SET consent_version = ? WHERE id = ?').run(CONSENT_VERSION, v.id);
  assert.equal((await upload('a.txt', 'hello', { ...env, UPLOAD_LIMITER: limiter(false) }, v.cookie)).status, 429);
  for (let i = 0; i < 10; i++) await bump(asD1(db), v.id, 'uploads');
  assert.equal((await upload('a.txt', 'hello', env, v.cookie)).status, 429);
  assert.equal((await upload('a.txt', 'hello', { ...env, MEMORY: undefined }, v.cookie)).status, 503);
});

test('a refused mint leaves nothing behind: no visitor row, no session counted, the sitewide slot given back', async () => {
  const { env, db } = talkEnv();
  restore = upstreams({ convai: () => new Response('busy', { status: 503 }) });
  const refused = await call(SESSION, jsonPost(good), env);
  assert.equal(refused.status, 503);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM visitor').get()?.n, 0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
  assert.equal(await count(asD1(db), TALK_SESSIONS, dayKey()), 0);
  restore();
  // Dropping the cookie and trying again creates nothing either.
  restore = upstreams({ convai: () => new Response('busy', { status: 503 }) });
  await call(SESSION, jsonPost(good), env);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM visitor').get()?.n, 0);
  restore();
  // A granted session writes the visitor, counts the session and keeps the slot.
  restore = upstreams();
  const granted = await call(SESSION, jsonPost(good), env);
  assert.equal(granted.status, 200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM visitor').get()?.n, 1);
  assert.equal(db.sqlite.prepare('SELECT sessions FROM quota').get()?.sessions, 1);
  assert.equal(await count(asD1(db), TALK_SESSIONS, dayKey()), 1);
});
