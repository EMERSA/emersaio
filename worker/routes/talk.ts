/**
 * POST /api/talk/session: Turnstile, consent, the signed visitor cookie, then a one-hour Convai token.
 * POST /api/talk/revoke: ends the visitor's open sessions; Convai has no documented revocation, so the token lapses.
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
import { contentType, fail, json, noContent } from '../lib/http.ts';
import {
  addDocument,
  bump,
  endSessions,
  MAX_SESSIONS_PER_DAY,
  MAX_TURNS_PER_DAY,
  MAX_UPLOADS_PER_DAY,
  recordConsent,
  SESSION_MINUTES,
  startSession,
  usage,
} from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import { pdfText } from '../lib/pdf.ts';
import { secondsUntilTomorrow } from '../lib/quota.ts';
import { multiLine, oneLine } from '../lib/text.ts';
import { verify } from '../lib/turnstile.ts';
import { consented, secureCookie, store } from '../lib/visitor.ts';

export const MAX_SESSION_BYTES = 4096;
export const VOICE_OFF = 'Voice is not connected yet.';
export const VOICE_BUSY = 'Voice is not answering right now. Please try again in a minute, or type instead.';
export const NOT_HUMAN = 'We could not confirm the check. Please try again.';
export const OLD_CONSENT = 'Please read the updated notice and agree again.';
export const DAY_FULL = 'That is all the talking for today. Please come back tomorrow.';

const tomorrow = (): Record<string, string> => ({ 'Retry-After': String(secondsUntilTomorrow()) });

export async function talkSession(c: ApiContext): Promise<Response> {
  const { env } = c;
  if (!env.CONVAI_API_KEY || !env.CONVAI_CHARACTER_ID || !env.TURNSTILE_SECRET) {
    writePoint(env, c.route, '503-binding');
    return fail(503, VOICE_OFF);
  }
  const s = store(c);
  if (s instanceof Response) return s;

  const version = Number(c.fields.consentVersion);
  if (!Number.isInteger(version)) return fail(422, 'Agree to the notice first.');
  if (version !== CONSENT_VERSION) return fail(422, OLD_CONSENT);
  const token = c.fields.turnstile ?? '';
  if (!(await verify(env.TURNSTILE_SECRET, token, c.request.headers.get('cf-connecting-ip')))) {
    writePoint(env, c.route, '403-turnstile');
    return fail(403, NOT_HUMAN);
  }

  const id = (await cookieVisitor(c.request, s.key)) ?? newVisitorId();
  await recordConsent(s.db, id, version);
  const cookie = { 'Set-Cookie': visitorCookie(await signVisitorId(s.key, id), secureCookie(c)) };
  if ((await bump(s.db, id, 'sessions')) > MAX_SESSIONS_PER_DAY) {
    writePoint(env, c.route, '429-cap');
    return fail(429, DAY_FULL, { ...tomorrow(), ...cookie });
  }
  const turnsLeft = Math.max(0, MAX_TURNS_PER_DAY - (await usage(s.db, id, 'turns')));
  if (turnsLeft === 0) return fail(429, DAY_FULL, { ...tomorrow(), ...cookie });

  let minted: Awaited<ReturnType<typeof connect>>;
  try {
    minted = await connect(env.CONVAI_API_KEY, Date.now(), apiBase(env));
  } catch (error) {
    const kind = error instanceof ConvaiError ? error.kind : 'unknown';
    console.error('talk: convai connect failed', kind);
    writePoint(env, c.route, `503-convai-${kind}`);
    return fail(503, kind === 'unauthorized' ? VOICE_OFF : VOICE_BUSY, cookie);
  }
  await endSessions(s.db, id);
  await startSession(s.db, id, 'convai');
  return json(
    {
      ok: true,
      provider: 'convai',
      token: minted.token,
      expiresAt: minted.expiresAt,
      characterId: env.CONVAI_CHARACTER_ID,
      endUserId: await endUserId(s.key, id),
      session: { turnsLeft, maxMinutes: SESSION_MINUTES },
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
        await endSessions(env.MEMORY, id);
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
  if ((await bump(s.db, id, 'uploads')) > MAX_UPLOADS_PER_DAY) {
    writePoint(c.env, c.route, '429-cap');
    return fail(429, 'That is all the files for today. Please come back tomorrow.', tomorrow());
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
