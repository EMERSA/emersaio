/**
 * POST /api/form/minutes: "Get 10 free minutes". A visitor who has used their free conversations tells us who they
 * are (name, email, organisation, what they are, what interests them); the details go to the team at 4d@emersa.io
 * through Cloudflare Email Sending (the EMAIL binding), and only once that mail is accepted are 10 minutes added to
 * the visitor's bought minutes (lib/memory.ts addCredit).
 *
 * One claim per visitor and one per email address, ever (the reward table keeps an HMAC of the address, never the
 * address); three a day per network; none through Tor or a VPN; the person check when Turnstile is on. Without the
 * EMAIL binding the route answers 503 and Talk does not offer the form.
 */
import type { ApiContext } from '../lib/compose.ts';
import { cookieVisitor } from '../lib/consent.ts';
import { fail, json, SITE_HOST } from '../lib/http.ts';
import { addCredit, getVisitor } from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import { anonymousNetwork, networkKey, type RequestOrigin } from '../lib/network.ts';
import { type Counter, dayKey, release, reserve } from '../lib/quota.ts';
import { oneLine } from '../lib/text.ts';
import { verify } from '../lib/turnstile.ts';
import { store } from '../lib/visitor.ts';

export const MAX_FORM_BYTES = 4096;
/** What the form gives: ten minutes, spent like bought ones. */
export const FORM_SECONDS = 600;
export const FORM_TO = '4d@emersa.io';
export const FORM_FROM = 'emily@emersa.io';
export const ROLES: Readonly<Record<string, string>> = {
  customer: 'A potential customer',
  investor: 'An investor',
  partner: 'A partner',
  other: 'Something else',
};

export const FORM_OFF = 'This form is not switched on yet. Please write to 4d@emersa.io.';
export const FORM_TALK_FIRST = 'Start a conversation with Emily first; the form is for when your free ones are used.';
export const FORM_USED =
  'You have already had your 10 free minutes. To keep talking, buy minutes or write to 4d@emersa.io.';
export const FORM_INVALID = 'Please give your name, a valid email address, what you are, and tick the box.';
export const FORM_NOT_SENT = 'Your details could not be sent just now. Please try again in a minute.';
export const FORM_NETWORK =
  'Your network has used today’s free-minute forms. Please try again tomorrow, or write to 4d@emersa.io.';
export const FORM_VPN = 'The form is not available through a VPN, proxy or Tor. Turn it off and try again.';

export const FORM_PER_NETWORK: Counter = { scope: 'form-net', key: '', cap: 3, full: FORM_NETWORK };

const EMAIL = /^[^\s@<>()"',;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const encoder = new TextEncoder();

/** HMAC-SHA-256 of the lowercased address under the visitor secret, as hex: the same address always matches. */
export async function emailKey(secret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`email:${email.toLowerCase()}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The form runs when it is switched on (FORM_MINUTES "on") and the email binding is there. */
export const formOn = (env: { EMAIL?: unknown; FORM_MINUTES?: string }): boolean =>
  env.FORM_MINUTES === 'on' && Boolean(env.EMAIL);

/** Whether this visitor has already claimed the form's minutes. */
export async function rewarded(db: D1Database | Pick<D1Database, 'prepare'>, visitorId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS y FROM reward WHERE visitor_id = ?').bind(visitorId).first<number>('y');
  return row === 1;
}

export async function formMinutes(c: ApiContext): Promise<Response> {
  const { env } = c;
  if (!formOn(env)) return fail(503, FORM_OFF);
  const mail = env.EMAIL as NonNullable<typeof env.EMAIL>;
  const s = store(c);
  if (s instanceof Response) return s;
  const id = await cookieVisitor(c.request, s.key);
  if (!id || !(await getVisitor(s.db, id))) return fail(403, FORM_TALK_FIRST);

  const name = oneLine(c.fields.name ?? '', 100);
  const email = (c.fields.email ?? '').trim();
  const organisation = oneLine(c.fields.organisation ?? '', 120);
  const role = c.fields.role ?? '';
  const message = (c.fields.message ?? '').trim().slice(0, 1000);
  if (!name || !EMAIL.test(email) || !(role in ROLES) || c.fields.agree !== 'yes') return fail(422, FORM_INVALID);

  if (env.TURNSTILE_SECRET) {
    const host = env.ENV === 'production' ? SITE_HOST : undefined;
    const ip = c.request.headers.get('cf-connecting-ip');
    if (!(await verify(env.TURNSTILE_SECRET, c.fields.turnstile ?? '', ip, host))) {
      return fail(403, 'We could not confirm the check. Please try again.');
    }
  }
  if (anonymousNetwork(c.request.cf as RequestOrigin | undefined)) return fail(429, FORM_VPN);
  if (await rewarded(s.db, id)) return fail(409, FORM_USED);
  const hash = await emailKey(s.key, email);
  const taken = await s.db.prepare('SELECT 1 AS y FROM reward WHERE email_hash = ?').bind(hash).first<number>('y');
  if (taken === 1) return fail(409, FORM_USED);

  const day = dayKey();
  const ip = c.request.headers.get('cf-connecting-ip');
  const network: Counter | null = ip ? { ...FORM_PER_NETWORK, key: await networkKey(s.key, ip) } : null;
  if (network && !(await reserve(s.db, network, day)).allowed) {
    writePoint(env, c.route, '429-network');
    return fail(429, FORM_NETWORK);
  }

  const lines = [
    `Name: ${name}`,
    `Email: ${email}`,
    `Organisation: ${organisation || '-'}`,
    `They are: ${ROLES[role]}`,
    '',
    'What interests them:',
    message || '-',
    '',
    `Sent from the Talk form on emersa.io on ${new Date().toUTCString()}. They were given ${FORM_SECONDS / 60} minutes with Emily. Reply to this email to answer them.`,
  ];
  try {
    await mail.send({
      from: { email: FORM_FROM, name: 'Emily at emersa.io' },
      to: FORM_TO,
      replyTo: { email, name },
      subject: `10 minutes with Emily: ${name} (${ROLES[role]})`,
      text: lines.join('\n'),
    });
  } catch (error) {
    if (network) await release(s.db, network, day);
    console.error('form: email failed', (error as { code?: string })?.code ?? 'unknown');
    writePoint(env, c.route, '502-email');
    return fail(502, FORM_NOT_SENT);
  }
  // Recorded before the credit, so a second request racing this one cannot claim twice.
  const claimed = await s.db
    .prepare(
      'INSERT INTO reward (visitor_id, email_hash, seconds, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING visitor_id',
    )
    .bind(id, hash, FORM_SECONDS, Date.now())
    .first<string>('visitor_id');
  if (typeof claimed !== 'string') return fail(409, FORM_USED);
  const seconds = await addCredit(s.db, id, FORM_SECONDS);
  writePoint(env, c.route, 'rewarded');
  return json({ ok: true, minutes: Math.floor(seconds / 60) });
}

/** The nightly job: claims older than 12 months go. */
export async function purgeRewards(db: Pick<D1Database, 'prepare'>, nowMs: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM reward WHERE created_at < ?')
    .bind(nowMs - 365 * 86_400_000)
    .run();
  return result.meta.changes;
}
