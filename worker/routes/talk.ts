/**
 * POST /api/talk/session: consent, the signed visitor cookie, Turnstile when TURNSTILE_SECRET is set, the free
 * talk-time budget, then a one-hour Convai token under the sitewide daily cap.
 * POST /api/talk/revoke: ends the visitor's open sessions and refunds the talk time they did not use; Convai has
 * no documented revocation, so the token lapses.
 * POST /api/talk/upload: one PDF, .txt or .md file (2 MB at most) as plain text for Emily's context. The file
 * itself is never stored or forwarded; only its extracted text (20,000 characters at most) is kept.
 */
import type { ApiContext } from '../lib/compose.ts';
import {
  CONSENT_VERSION,
  cookieVisitor,
  endUserId,
  newVisitorId,
  signVisitorId,
  visitorCookie,
} from '../lib/consent.ts';
import { apiBase, ConvaiError, connect, revoke } from '../lib/convai.ts';
import { contentType, fail, json, noContent, SITE_HOST } from '../lib/http.ts';
import {
  addCredit,
  addDocument,
  bump,
  capsFor,
  creditSeconds,
  endSessions,
  getVisitor,
  lastActivity,
  MAX_UPLOADS_PER_DAY,
  type MemoryDb,
  recordConsent,
  refund,
  SESSION_MINUTES,
  startSession,
  unusedSeconds,
  usage,
} from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import { anonymousNetwork, networkKey, type RequestOrigin } from '../lib/network.ts';
import { pdfText } from '../lib/pdf.ts';
import { type Counter, dayKey, release, reserve, secondsUntilTomorrow, TALK_SESSIONS } from '../lib/quota.ts';
import { multiLine, oneLine } from '../lib/text.ts';
import { verify } from '../lib/turnstile.ts';
import { consented, OLD_CONSENT, secureCookie, store } from '../lib/visitor.ts';
import { formOn, rewarded } from './form.ts';

export const MAX_SESSION_BYTES = 4096;
export const VOICE_OFF = 'Voice is not connected yet.';
export const VOICE_BUSY = 'Voice is not answering right now. Please try again in a minute, or type instead.';
export const NOT_HUMAN = 'We could not confirm the check. Please try again.';
export { OLD_CONSENT };
export const DAY_FULL = 'That is all the talking for today. Please come back tomorrow.';
export const MINUTES_UP = 'That is your free five minutes for today. Please come back tomorrow.';

/** The free allowance: three conversations on a visitor's first day (a slip of the finger costs nothing), then one a day. */
export const FIRST_DAY_CONVERSATIONS = 3;
export const DAILY_CONVERSATIONS = 1;
/** Each free conversation lasts up to this long. */
export const FREE_SESSION_MINUTES = 5;
/** Free conversations from one network a day, whoever they are: an office or a home shares one address. */
export const TALK_PER_NETWORK: Counter = {
  scope: 'talk-net',
  key: '',
  cap: 12,
  full: 'Your network has used today’s free conversations with Emily. Please try again tomorrow, or write to 4d@emersa.io.',
};
const QR = ' Our QR code generator is free to use any time.';
/** The refusal once the free conversations are used: what is left, and how to go on now (Buy when it is on). */
export const allowanceDone = (firstDay: boolean, buy: boolean): string =>
  (firstDay
    ? 'That is your three free conversations for today. From tomorrow you get one a day.'
    : 'That is your free conversation for today; you get another tomorrow.') +
  (buy
    ? ' To keep talking now, buy 60 minutes for £5 below, or write to 4d@emersa.io.'
    : ' To keep talking now, write to 4d@emersa.io; buying minutes is coming soon.') +
  QR;
export const FIRST_DAY_DONE = allowanceDone(true, false);
export const DAILY_DONE = allowanceDone(false, false);
export const VPN_REFUSED =
  'Free conversations are not available through a VPN, proxy or Tor. Turn it off and try again, or write to 4d@emersa.io.';
export const UPLOADS_FULL = 'That is all the files for today. Please come back tomorrow.';

const tomorrow = (): Record<string, string> => ({ 'Retry-After': String(secondsUntilTomorrow()) });

/** An abandoned session counts as used until its last line plus this, not until it is found. */
export const ABANDONED_GRACE_MS = 60_000;

/**
 * End the visitor's open sessions and give back the talk time they were charged but did not use. Revoke (the
 * visitor ended it) counts up to now. A session found still open when the next one starts was abandoned (a closed
 * tab, a reload, a locked phone): it counts up to its last recorded line plus ABANDONED_GRACE_MS, so leaving the
 * page does not cost the rest of the day's minutes.
 */
async function settle(db: MemoryDb, id: string, nowMs = Date.now(), abandoned = false): Promise<number> {
  const ended = await endSessions(db, id, nowMs);
  let back = 0;
  for (const session of ended) {
    let until = nowMs;
    if (abandoned) {
      const last = (await lastActivity(db, id, session.started_at)) ?? session.started_at;
      until = Math.min(nowMs, last + ABANDONED_GRACE_MS);
    }
    const unused = unusedSeconds(session, until);
    // A paid session's unused time goes back to the visitor's bought minutes, a free one's to the day.
    if (session.paid) {
      if (unused > 0) await addCredit(db, id, unused);
    } else {
      back += unused;
    }
  }
  if (back > 0) await refund(db, id, 'talk_seconds', back, nowMs);
  return back;
}

/**
 * GET /api/talk/allowance: what the visitor has left today, read when Talk opens so a visitor with nothing left is
 * told (and offered Buy) before pressing Start, not after. Writes nothing; a visitor without a cookie is new.
 */
export async function talkAllowance(c: ApiContext): Promise<Response> {
  const s = store(c);
  if (s instanceof Response) return s;
  const known = await cookieVisitor(c.request, s.key);
  const row = known ? await getVisitor(s.db, known) : null;
  const firstDay = !row || dayKey(row.created_at) === dayKey();
  const of = firstDay ? FIRST_DAY_CONVERSATIONS : DAILY_CONVERSATIONS;
  const used = known ? await usage(s.db, known, 'sessions') : 0;
  const creditMinutes = known ? Math.floor((await creditSeconds(s.db, known)) / 60) : 0;
  const buy = Boolean(c.env.STRIPE_SECRET_KEY);
  const out = used >= of && creditMinutes < 1;
  // The form is offered once a visitor has talked and has not claimed it yet (routes/form.ts).
  const earn = formOn(c.env) && Boolean(row) && !(known && (await rewarded(s.db, known)));
  return json({
    ok: true,
    earn,
    firstDay,
    of,
    used,
    left: Math.max(0, of - used),
    creditMinutes,
    buy,
    message: out ? allowanceDone(firstDay, buy) : '',
  });
}

export async function talkSession(c: ApiContext): Promise<Response> {
  const { env } = c;
  if (!env.CONVAI_API_KEY || !env.CONVAI_CHARACTER_ID) {
    writePoint(env, c.route, '503-binding');
    return fail(503, VOICE_OFF);
  }
  const s = store(c);
  if (s instanceof Response) return s;

  const version = Number(c.fields.consentVersion);
  if (!Number.isInteger(version)) return fail(422, 'Agree to the notice first.');
  if (version !== CONSENT_VERSION) return fail(422, OLD_CONSENT);
  // Turnstile is optional (lib/env.ts). With the secret the pass is checked as before; without it the session
  // is counted as unguarded and the visitor runs on the tighter caps from capsFor().
  const guarded = Boolean(env.TURNSTILE_SECRET);
  if (env.TURNSTILE_SECRET) {
    const token = c.fields.turnstile ?? '';
    // Production names its host so a pass solved on another site's page is refused; dev and beta pass nothing.
    const host = env.ENV === 'production' ? SITE_HOST : undefined;
    if (!(await verify(env.TURNSTILE_SECRET, token, c.request.headers.get('cf-connecting-ip'), host))) {
      writePoint(env, c.route, '403-turnstile');
      return fail(403, NOT_HUMAN);
    }
  } else {
    writePoint(env, c.route, 'unguarded');
  }
  const caps = capsFor(env);

  // Nothing is written for the visitor until a session is granted: a request refused by a cap, by the sitewide
  // brake or by the voice service leaves no row behind, so dropping the cookie and retrying creates nothing.
  const known = await cookieVisitor(c.request, s.key);
  const id = known ?? newVisitorId();
  const cookie = { 'Set-Cookie': visitorCookie(await signVisitorId(s.key, id), secureCookie(c)) };
  if ((await usage(s.db, id, 'sessions')) >= caps.sessions) {
    writePoint(env, c.route, '429-cap');
    return fail(429, DAY_FULL, { ...tomorrow(), ...cookie });
  }
  const turnsLeft = Math.max(0, caps.turns - (await usage(s.db, id, 'turns')));
  if (turnsLeft === 0) return fail(429, DAY_FULL, { ...tomorrow(), ...cookie });

  // A session the visitor left open (a closed tab, a refresh) is settled first, so its unused time is theirs again.
  if (known) await settle(s.db, id, Date.now(), true);
  // The free allowance: three conversations on the visitor's first day, then one a day.
  const row = known ? await getVisitor(s.db, id) : null;
  const firstDay = !row || dayKey(row.created_at) === dayKey();
  const allowed = firstDay ? FIRST_DAY_CONVERSATIONS : DAILY_CONVERSATIONS;
  const had = await usage(s.db, id, 'sessions');
  // Free conversations first; then bought minutes, if the visitor has any (routes/pay.ts).
  const credit = had >= allowed && known ? await creditSeconds(s.db, id) : 0;
  const paid = had >= allowed && credit >= 60;
  if (had >= allowed && !paid) {
    writePoint(env, c.route, '429-allowance');
    return json(
      {
        ok: false,
        error: allowanceDone(firstDay, Boolean(env.STRIPE_SECRET_KEY)),
        reason: 'allowance',
        buy: Boolean(env.STRIPE_SECRET_KEY),
      },
      429,
      { ...tomorrow(), ...cookie },
    );
  }
  if (!paid && anonymousNetwork(c.request.cf as RequestOrigin | undefined)) {
    writePoint(env, c.route, '429-vpn');
    return json({ ok: false, error: VPN_REFUSED, reason: 'vpn' }, 429, cookie);
  }
  // Future: a paywall attaches here.
  const maxMinutes = paid
    ? Math.min(SESSION_MINUTES, Math.floor(credit / 60))
    : Math.min(SESSION_MINUTES, FREE_SESSION_MINUTES);

  // The sitewide brake first: the atomic slot under TALK_SESSIONS is taken before the voice service is asked for
  // anything that costs money (the quota() middleware did the cheap read). A mint the service then refuses gives
  // the slot back.
  const day = dayKey();
  if (!(await reserve(s.db, TALK_SESSIONS, day)).allowed) {
    writePoint(env, c.route, '503-cap');
    return fail(503, TALK_SESSIONS.full, { ...tomorrow(), ...cookie });
  }
  // Then the network's share: free conversations from one address a day (the address is kept only as an HMAC).
  const ip = c.request.headers.get('cf-connecting-ip');
  const network: Counter | null = ip && !paid ? { ...TALK_PER_NETWORK, key: await networkKey(s.key, ip) } : null;
  if (network && !(await reserve(s.db, network, day)).allowed) {
    await release(s.db, TALK_SESSIONS, day);
    writePoint(env, c.route, '429-network');
    return json({ ok: false, error: TALK_PER_NETWORK.full, reason: 'network' }, 429, { ...tomorrow(), ...cookie });
  }
  let minted: Awaited<ReturnType<typeof connect>>;
  try {
    minted = await connect(env.CONVAI_API_KEY, Date.now(), apiBase(env));
  } catch (error) {
    await release(s.db, TALK_SESSIONS, day);
    if (network) await release(s.db, network, day);
    const kind = error instanceof ConvaiError ? error.kind : 'unknown';
    console.error('talk: convai connect failed', kind);
    writePoint(env, c.route, `503-convai-${kind}`);
    return fail(503, kind === 'unauthorized' ? VOICE_OFF : VOICE_BUSY, cookie);
  }
  // Granted: now the visitor exists, with their consent, the session counted and the time charged.
  await recordConsent(s.db, id, version);
  const charged = maxMinutes * 60;
  if (paid) {
    await addCredit(s.db, id, -charged);
  } else {
    await bump(s.db, id, 'sessions');
    await bump(s.db, id, 'talk_seconds', charged);
  }
  await startSession(s.db, id, 'convai', Date.now(), charged, paid);
  writePoint(env, c.route, guarded ? 'guarded' : 'unguarded-session');
  return json(
    {
      ok: true,
      provider: 'convai',
      token: minted.token,
      expiresAt: minted.expiresAt,
      characterId: env.CONVAI_CHARACTER_ID,
      endUserId: await endUserId(s.key, id),
      session: { turnsLeft, maxMinutes, secondsLeft: maxMinutes * 60 },
      allowance: paid
        ? { paid: true, minutesLeft: Math.floor((credit - charged) / 60) }
        : { used: had + 1, of: allowed, firstDay },
    },
    200,
    cookie,
  );
}

export async function talkRevoke(c: ApiContext): Promise<Response> {
  const { env } = c;
  if (env.CONVAI_API_KEY) await revoke(env.CONVAI_API_KEY);
  if (env.MEMORY && env.VISITOR_HMAC_KEY) {
    const id = await cookieVisitor(c.request, env.VISITOR_HMAC_KEY);
    if (id) {
      try {
        await settle(env.MEMORY, id);
      } catch (error) {
        console.error('talk: could not end sessions', error instanceof Error ? error.message : 'unknown');
      }
    }
  }
  return noContent();
}

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The multipart envelope around the file: boundaries, part headers and the file name. */
export const MAX_UPLOAD_BYTES = MAX_FILE_BYTES + 16 * 1024;
export const MAX_DOCUMENT_CHARS = 20_000;
export const UNREADABLE_PDF = 'Could not read that PDF';

const KINDS = /\.(pdf|txt|md)$/i;

export async function talkUpload(c: ApiContext): Promise<Response> {
  const length = Number(c.request.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0) return fail(411, 'That request had no length.');
  if (length > MAX_UPLOAD_BYTES) return fail(413, 'That file is larger than 2 MB.');
  if (contentType(c.request) !== 'multipart/form-data') return fail(415, 'Send the file as a form upload.');
  const s = store(c);
  if (s instanceof Response) return s;
  const id = await consented(c, s);
  if (id instanceof Response) return id;
  // The cheap read first, so a full day is refused before the body is parsed; the atomic bump below takes the
  // slot only once the upload is a file this route reads, so a bad request costs the visitor nothing.
  if ((await usage(s.db, id, 'uploads')) >= MAX_UPLOADS_PER_DAY) {
    writePoint(c.env, c.route, '429-cap');
    return fail(429, UPLOADS_FULL, tomorrow());
  }

  let file: unknown;
  try {
    file = (await c.request.formData()).get('file');
  } catch {
    return fail(400, 'We could not read that upload.');
  }
  if (!(file instanceof File)) return fail(422, 'Attach one file.');
  if (file.size > MAX_FILE_BYTES) return fail(413, 'That file is larger than 2 MB.');
  const kind = KINDS.exec(file.name)?.[1]?.toLowerCase();
  if (!kind) return fail(415, 'Attach a PDF, .txt or .md file.');
  if ((await bump(s.db, id, 'uploads')) > MAX_UPLOADS_PER_DAY) {
    writePoint(c.env, c.route, '429-cap');
    return fail(429, UPLOADS_FULL, tomorrow());
  }
  const name = oneLine(file.name, 120);
  const bytes = new Uint8Array(await file.arrayBuffer());

  let text: string | null;
  if (kind === 'pdf') {
    text = await pdfText(bytes, MAX_DOCUMENT_CHARS);
    if (text === null) return fail(422, UNREADABLE_PDF);
  } else {
    text = new TextDecoder().decode(bytes);
  }
  text = multiLine(text, MAX_DOCUMENT_CHARS);
  if (!text) return fail(422, 'That file has no text in it.');
  const saved = await addDocument(s.db, id, name, text);
  return json({ ok: true, ...saved });
}
