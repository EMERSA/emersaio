/**
 * POST /api/contact: the form on /contact, with or without scripts.
 *
 * Answers JSON when asked for it (the form script) and otherwise redirects to /contact/sent or /contact/error, so
 * the page works with scripts disabled: contactReplies below turns every answer in the chain into one of the two.
 * Cheap bot checks and no captcha: a hidden field people never see, the time taken to fill the form in, the body
 * cap and the limiter in the chain, and a daily cap in D1 behind them. The checks that catch a bot return a normal
 * success, so it learns nothing. The cap is the one check a sender cannot pass by choice, so nothing is sent
 * without it: no database, or one that cannot answer, is a 503 like a missing token. The method and the sending
 * site are checked before this runs.
 */
import type { ApiContext, Middleware } from '../lib/compose.ts';
import { emailAdapter } from '../lib/email/index.ts';
import { fail, json, type Reply, redirect, siteOrigin, wantsJson } from '../lib/http.ts';
import { writePoint } from '../lib/metrics.ts';
import { CONTACT_SENDS, dayKey, reserve, type Slot, secondsUntilTomorrow } from '../lib/quota.ts';
import { multiLine, oneLine } from '../lib/text.ts';

/** The largest submission worth reading. Real ones are a few hundred bytes. */
export const MAX_FORM_BYTES = 64 * 1024;
/** Nobody fills five fields in under this. */
export const MIN_FILL_MS = 2500;
/** Where messages go unless CONTACT_TO says otherwise. */
export const DEFAULT_TO = '4d@emersa.io';

/** The topics the form offers, with the label the inbox sees. The site's own labels live in apps/web/src/data. */
export const TOPICS = {
  emily: 'Emily Wilson demo',
  krupiq: 'Krupiq',
  partnership: 'Partnership',
  other: 'Something else',
} as const;
export type Topic = keyof typeof TOPICS;

const LIMITS = { name: 80, email: 160, company: 120, message: 1200 } as const;

export const NOT_CONNECTED = 'The form is not connected yet, email sales@emersa.io and we will pick it up from there.';
export const NOT_DELIVERED = 'We could not deliver that just now. Please email sales@emersa.io and we will pick it up.';

const isTopic = (value: string): value is Topic => Object.hasOwn(TOPICS, value);

/** Deliberately loose: the only real test of an address is sending to it. */
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(value);

export interface Submission {
  name: string;
  email: string;
  company: string;
  topic: Topic;
  message: string;
}

export type Checked = { ok: true; submission: Submission } | { ok: false; error: string };

/** The fields as a submission, or the first thing wrong with them as a sentence for the person. */
export function check(fields: Readonly<Record<string, string>>): Checked {
  const name = oneLine(fields.name);
  const email = oneLine(fields.email);
  const company = oneLine(fields.company);
  const topic = oneLine(fields.topic, 40).toLowerCase();
  const message = multiLine(fields.message);

  if (!name) return { ok: false, error: 'Please tell us your name.' };
  if (name.length > LIMITS.name) return { ok: false, error: `Please keep your name to ${LIMITS.name} characters.` };
  if (!email || email.length > LIMITS.email || !looksLikeEmail(email)) {
    return { ok: false, error: 'That does not look like an email address.' };
  }
  if (company.length > LIMITS.company) {
    return { ok: false, error: `Please keep the company name to ${LIMITS.company} characters.` };
  }
  if (!isTopic(topic)) return { ok: false, error: 'Please choose a topic.' };
  if (!message) return { ok: false, error: 'Please write a message.' };
  if (message.length > LIMITS.message) {
    return { ok: false, error: `Please keep your message to ${LIMITS.message} characters.` };
  }
  return { ok: true, submission: { name, email, company, topic, message } };
}

/** Plain text for the inbox: what the person typed, labelled, and when it arrived. Nothing about their connection. */
const mailText = (s: Submission, received: string): string =>
  [
    'New message from the emersa.io contact form.',
    '',
    `Name: ${s.name}`,
    `Email: ${s.email}`,
    `Company: ${s.company || 'not given'}`,
    `Topic: ${TOPICS[s.topic]}`,
    `Received: ${received}`,
    '',
    s.message,
    '',
  ].join('\n');

export const contact = async (c: ApiContext): Promise<Response> => {
  const fields = c.fields;
  const bot = (kind: string): Response => {
    writePoint(c.env, c.route, `bot-${kind}`);
    return json({ ok: true } satisfies Reply);
  };

  // A field that is hidden from people and from screen readers. Anything in it is automated.
  if (oneLine(fields.website, 200)) return bot('honeypot');

  // The page writes the time it was shown into `started`. Under MIN_FILL_MS is a script. A negative elapsed time
  // is a clock ahead of ours, not a bot; without scripts the field is empty and the check does not apply.
  const started = Number(oneLine(fields.started, 20));
  if (Number.isFinite(started) && started > 0) {
    const elapsed = Date.now() - started;
    if (elapsed >= 0 && elapsed < MIN_FILL_MS) return bot('fill-time');
  }

  const checked = check(fields);
  if (!checked.ok) return fail(422, checked.error);
  const { submission } = checked;

  const mail = emailAdapter(c.env);
  if (!mail.configured) {
    // Better to say so than to accept the message and lose it.
    writePoint(c.env, c.route, '503-not-connected');
    return fail(503, NOT_CONNECTED);
  }

  // The limiter is advisory and the bot checks are the sender's to pass; the daily cap is what bounds the mail
  // that leaves, so without the database the form is not connected either.
  if (!c.env.MEMORY) {
    writePoint(c.env, c.route, '503-no-cap');
    return fail(503, NOT_CONNECTED);
  }

  let slot: Slot;
  try {
    slot = await reserve(c.env.MEMORY, CONTACT_SENDS, dayKey());
  } catch (error) {
    // A database that cannot answer (or is bound but not yet migrated) gives no cap, so nothing is sent.
    console.error('contact: could not reserve a slot', error instanceof Error ? error.message : 'unknown');
    writePoint(c.env, c.route, '503-cap-error');
    return fail(503, NOT_DELIVERED);
  }
  if (!slot.allowed) {
    writePoint(c.env, c.route, '503-cap');
    return fail(503, CONTACT_SENDS.full, { 'Retry-After': String(secondsUntilTomorrow()) });
  }

  const result = await mail.send({
    to: c.env.CONTACT_TO || DEFAULT_TO,
    replyTo: submission.email,
    subject: `Contact form: ${TOPICS[submission.topic]} from ${submission.name}`,
    text: mailText(submission, new Date().toISOString()),
    tag: 'contact',
  });
  if (!result.ok) {
    console.error(`contact: ${mail.name} did not accept the message`, result.error ?? 'no detail');
    writePoint(c.env, c.route, '502-send');
    return fail(502, NOT_DELIVERED);
  }

  writePoint(c.env, c.route, 'sent');
  return json({ ok: true } satisfies Reply);
};

/**
 * JSON for the form script (Accept: application/json), a redirect for a plain form post: success to /contact/sent,
 * anything else from the chain or the handler to /contact/error, so a visitor without scripts always lands on a page.
 */
export const contactReplies: Middleware = async (c, next) => {
  const response = await next();
  if (wantsJson(c.request)) return response;
  const sent = response.status >= 200 && response.status < 300;
  return redirect(new URL(sent ? '/contact/sent' : '/contact/error', siteOrigin(c.request, c.env)), 303);
};
