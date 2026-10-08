/**
 * POST /api/contact through the whole chain: the same-site check, the caps, the bot checks, validation, the
 * missing-token and missing-database answers, delivery to a mocked Postmark, the no-script redirects, the limiter,
 * the daily cap and a database that cannot answer.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DEFAULT_FROM, POSTMARK_API } from '../lib/email/postmark.ts';
import { CONTACT_SENDS, dayKey } from '../lib/quota.ts';
import { asD1, seedCounter, TestD1, testDatabase } from '../test/d1.ts';
import {
  body,
  brokenLimiter,
  call,
  fakeEnv,
  form,
  good,
  JSON_ACCEPT,
  kinds,
  limiter,
  metrics,
  mockFetch,
  noFetch,
  post,
  SAME_SITE,
} from '../test/harness.ts';
import { DEFAULT_TO, MIN_FILL_MS, NOT_CONNECTED, NOT_DELIVERED } from './contact.ts';

const CONTACT = 'https://emersa.io/api/contact';
const HEADERS = { ...JSON_ACCEPT, ...SAME_SITE };

interface Mail {
  From: string;
  To: string;
  ReplyTo?: string;
  Subject: string;
  TextBody: string;
  Tag?: string;
  MessageStream: string;
}

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

/** A Postmark that keeps what it was sent and answers as the real one does. */
function postmarkInbox(status = 200): { mail: Mail[]; tokens: string[] } {
  const mail: Mail[] = [];
  const tokens: string[] = [];
  restore = mockFetch(async (url, init) => {
    assert.equal(url, POSTMARK_API);
    assert.equal(init.method, 'POST');
    tokens.push(String(new Headers(init.headers).get('x-postmark-server-token')));
    mail.push(JSON.parse(String(init.body)) as Mail);
    const reply =
      status === 200
        ? { To: 'x', SubmittedAt: 'now', MessageID: 'm-1', ErrorCode: 0, Message: 'OK' }
        : { ErrorCode: 300, Message: 'Invalid email request' };
    return new Response(JSON.stringify(reply), { status });
  });
  return { mail, tokens };
}

/** A token and a migrated database, which is what delivery needs. Each call gets its own empty database. */
const connected = (overrides: Parameters<typeof fakeEnv>[0] = {}) =>
  fakeEnv({ POSTMARK_TOKEN: 'pm-test', MEMORY: asD1(testDatabase()), ...overrides });

const send = (fields: Record<string, string>, headers: Record<string, string> = HEADERS, env = connected()) =>
  call(CONTACT, post(form(fields), headers), env);

test('cross-site posts are refused before the body is read; same-site ones reach the handler', async () => {
  restore = noFetch();
  const refused: Array<Record<string, string>> = [
    {},
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { origin: 'https://emersa.io.evil.example' },
    { origin: 'http://emersa.io' },
    { origin: 'https://emersa.io', 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost:4321' },
  ];
  for (const headers of refused) {
    const response = await send(good, { ...JSON_ACCEPT, ...headers }, fakeEnv());
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  // 503 means the request reached the handler: no token is configured in these.
  const passes: Array<[string, Record<string, string>]> = [
    ['https://emersa.io', { origin: 'https://emersa.io', 'sec-fetch-site': 'same-origin' }],
    ['https://emersa.io', { origin: 'https://emersa.io' }],
    ['https://emersa.io', { origin: 'https://emersa.io', 'sec-fetch-site': 'none' }],
    ['http://localhost:8850', { origin: 'http://localhost:4321' }],
    ['http://127.0.0.1:8850', { origin: 'http://127.0.0.1:8850', 'sec-fetch-site': 'same-origin' }],
  ];
  for (const [host, headers] of passes) {
    const response = await call(`${host}/api/contact`, post(form(good), { ...JSON_ACCEPT, ...headers }), fakeEnv());
    assert.equal(response.status, 503, `${host} ${JSON.stringify(headers)}`);
  }
});

test('the body: 411 without a length, 413 above the cap, 415 for other types, 400 for bad JSON', async () => {
  restore = noFetch();
  const noLength = await call(CONTACT, { method: 'POST', body: form(good), headers: HEADERS });
  assert.equal(noLength.status, 411);
  const huge = await call(CONTACT, post('x', { ...HEADERS, 'content-length': String(65 * 1024) }));
  assert.equal(huge.status, 413);
  assert.equal((await call(CONTACT, post('x', HEADERS, 'text/plain'))).status, 415);
  assert.equal((await call(CONTACT, post('{', HEADERS, 'application/json'))).status, 400);
});

test('the honeypot and the fill time answer success, send nothing and are counted', async () => {
  const m = metrics();
  const env = connected({ METRICS: m.binding });
  const { mail } = postmarkInbox();
  assert.equal((await send({ ...good, website: 'http://spam.example' }, HEADERS, env)).status, 200);
  assert.equal((await send({ ...good, started: String(Date.now()) }, HEADERS, env)).status, 200);
  assert.equal((await send({ ...good, started: String(Date.now() - MIN_FILL_MS + 500) }, HEADERS, env)).status, 200);
  assert.equal(mail.length, 0, 'bots are answered with success and nothing is delivered');
  assert.deepEqual(kinds(m), ['bot-honeypot', 'bot-fill-time', 'bot-fill-time']);

  // A clock ahead of ours is not a bot, and a form without scripts sends no time at all.
  assert.equal((await send({ ...good, started: String(Date.now() + 5000) }, HEADERS, env)).status, 200);
  assert.equal((await send({ ...good, started: '' }, HEADERS, env)).status, 200);
  assert.equal(mail.length, 2);
});

test('validation answers 422 with a sentence and sends nothing', async () => {
  restore = noFetch();
  const cases: Array<[Record<string, string>, string]> = [
    [{ ...good, name: '' }, 'name'],
    [{ ...good, name: 'x'.repeat(81) }, 'name'],
    [{ ...good, email: 'not-an-address' }, 'email'],
    [{ ...good, email: `${'a'.repeat(150)}@example.com` }, 'email'],
    [{ ...good, company: 'c'.repeat(121) }, 'company'],
    [{ ...good, topic: 'sales' }, 'topic'],
    [{ ...good, topic: '' }, 'topic'],
    [{ ...good, message: '   ' }, 'message'],
    [{ ...good, message: 'm'.repeat(1201) }, 'message'],
  ];
  for (const [fields, about] of cases) {
    const response = await send(fields);
    assert.equal(response.status, 422, about);
    const reply = await body(response);
    assert.equal(reply.ok, false);
    assert.ok(reply.error?.toLowerCase().includes(about), `${about}: ${reply.error}`);
  }
});

test('without POSTMARK_TOKEN the form says it is not connected, and counts it', async () => {
  restore = noFetch();
  const m = metrics();
  const response = await send(good, HEADERS, fakeEnv({ METRICS: m.binding }));
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), { ok: false, error: NOT_CONNECTED });
  assert.ok(NOT_CONNECTED.includes('email sales@emersa.io'));
  assert.deepEqual(kinds(m), ['503-not-connected']);
});

test('with a token but no database the form is not connected either: 503, counted, nothing sent', async () => {
  restore = noFetch();
  const m = metrics();
  const response = await send(good, HEADERS, fakeEnv({ POSTMARK_TOKEN: 'pm-test', METRICS: m.binding }));
  assert.equal(response.status, 503);
  assert.deepEqual(await body(response), { ok: false, error: NOT_CONNECTED });
  assert.deepEqual(kinds(m), ['503-no-cap']);
});

test('a good submission reaches Postmark as plain text with Reply-To the sender and the tag "contact"', async () => {
  const m = metrics();
  const { mail, tokens } = postmarkInbox();
  const response = await send(
    { ...good, message: 'Line one.\r\nLine two.\u0007' },
    HEADERS,
    connected({ METRICS: m.binding }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true });
  assert.deepEqual(tokens, ['pm-test']);
  assert.equal(mail.length, 1);
  const [sent] = mail;
  assert.equal(sent?.From, DEFAULT_FROM);
  assert.equal(sent?.To, DEFAULT_TO);
  assert.equal(sent?.ReplyTo, 'ada@example.com');
  assert.equal(sent?.Tag, 'contact');
  assert.equal(sent?.MessageStream, 'outbound');
  assert.equal(sent?.Subject, 'Contact form: Emily Wilson demo from Ada Lovelace');
  assert.ok(sent?.TextBody.includes('Company: Analytical Engines'));
  assert.ok(sent?.TextBody.includes('Line one.\nLine two.'), 'newlines survive, other control characters do not');
  assert.ok(!sent?.TextBody.includes('\u0007'));
  assert.ok(!('HtmlBody' in (sent ?? {})));
  assert.deepEqual(kinds(m), ['sent']);
});

test('CONTACT_TO and POSTMARK_FROM override the defaults; the company is optional', async () => {
  const { mail } = postmarkInbox();
  const env = connected({ CONTACT_TO: 'inbox@example.com', POSTMARK_FROM: 'Site <site@example.com>' });
  assert.equal((await send({ ...good, company: '' }, HEADERS, env)).status, 200);
  assert.equal(mail[0]?.To, 'inbox@example.com');
  assert.equal(mail[0]?.From, 'Site <site@example.com>');
  assert.ok(mail[0]?.TextBody.includes('Company: not given'));
});

test('a JSON body works the same, numbers included', async () => {
  const { mail } = postmarkInbox();
  const payload = JSON.stringify({ ...good, started: 1, topic: 'krupiq' });
  const response = await call(CONTACT, post(payload, HEADERS, 'application/json'), connected());
  assert.equal(response.status, 200);
  assert.equal(mail[0]?.Subject, 'Contact form: Krupiq from Ada Lovelace');
});

test('Postmark refusing the message is a 502 that names the inbox, and is counted', async () => {
  const m = metrics();
  postmarkInbox(422);
  const response = await send(good, HEADERS, connected({ METRICS: m.binding }));
  assert.equal(response.status, 502);
  assert.deepEqual(await body(response), { ok: false, error: NOT_DELIVERED });
  assert.deepEqual(kinds(m), ['502-send']);
});

test('without scripts every answer is a redirect to a page, pinned to the real host', async () => {
  postmarkInbox();
  const sent = await send(good, SAME_SITE);
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('Location'), 'https://emersa.io/contact/sent');
  assert.equal(await sent.text(), '');

  for (const [label, response] of [
    ['validation', await send({ ...good, email: 'nope' }, SAME_SITE)],
    ['no token', await send(good, SAME_SITE, fakeEnv())],
    ['no database', await send(good, SAME_SITE, fakeEnv({ POSTMARK_TOKEN: 'pm-test' }))],
    ['cross-site', await send(good, { origin: 'https://evil.example' })],
    ['no length', await call(CONTACT, { method: 'POST', body: form(good), headers: SAME_SITE }, connected())],
  ] as const) {
    assert.equal(response.status, 303, label);
    assert.equal(response.headers.get('Location'), 'https://emersa.io/contact/error', label);
  }

  const local = await call(
    'http://localhost:8850/api/contact',
    post(form(good), { origin: 'http://localhost:4321' }),
    connected(),
  );
  assert.equal(local.headers.get('Location'), 'http://localhost:8850/contact/sent');

  const beta = 'https://emersaio-beta.example.workers.dev';
  const onBeta = await call(`${beta}/api/contact`, post(form(good), { origin: beta }), connected({ ENV: 'beta' }));
  assert.equal(onBeta.headers.get('Location'), `${beta}/contact/sent`);
});

test('the limiter: 429 with Retry-After when it says no; a failing limiter lets the message through', async () => {
  const m = metrics();
  const { mail } = postmarkInbox();
  const tooMany = await send(good, HEADERS, connected({ METRICS: m.binding, CONTACT_LIMITER: limiter(false) }));
  assert.equal(tooMany.status, 429);
  assert.equal(tooMany.headers.get('Retry-After'), '60');
  assert.deepEqual(kinds(m), ['429']);
  assert.equal(mail.length, 0);

  assert.equal((await send(good, HEADERS, connected({ CONTACT_LIMITER: brokenLimiter }))).status, 200);
  assert.equal(mail.length, 1);
});

test('the daily cap: the last slot goes to one request, the next is a 503 naming the inbox, counted', async () => {
  const m = metrics();
  const { mail } = postmarkInbox();
  const db = testDatabase();
  const env = connected({ METRICS: m.binding, MEMORY: asD1(db) });
  const counted = (): number => (db.sqlite.prepare('SELECT n FROM counters').get() as { n: number }).n;
  seedCounter(db, CONTACT_SENDS, dayKey(), CONTACT_SENDS.cap - 1);

  // A bot caught in the handler takes no slot: only a message about to be sent moves the count.
  assert.equal((await send({ ...good, website: 'spam' }, HEADERS, env)).status, 200);
  assert.equal(counted(), CONTACT_SENDS.cap - 1);

  assert.equal((await send(good, HEADERS, env)).status, 200);
  const full = await send(good, HEADERS, env);
  assert.equal(full.status, 503);
  const reply = await body(full);
  assert.ok(reply.error?.includes('Please write to sales@emersa.io'), reply.error);
  assert.ok(Number(full.headers.get('Retry-After')) >= 1);
  assert.equal(mail.length, 1, 'the refused message was not sent');
  assert.equal(counted(), CONTACT_SENDS.cap, 'the chain refused before a slot was taken');

  // Once full, the cheap check in the chain answers before the handler, so nothing more is counted or sent.
  // Two requests racing past that check are settled by reserve(), which quota.test.ts covers.
  assert.equal((await send(good, HEADERS, env)).status, 503);
  assert.equal((await send({ ...good, website: 'spam' }, HEADERS, env)).status, 503);
  assert.equal(counted(), CONTACT_SENDS.cap);
  assert.equal(mail.length, 1);
  assert.deepEqual(kinds(m), ['bot-honeypot', 'sent', '503-cap', '503-cap', '503-cap']);
  db.close();
});

test('a database that cannot answer fails closed: 503 naming the inbox, counted, nothing sent', async () => {
  restore = noFetch();
  const m = metrics();
  const broken = testDatabase();
  broken.break();
  const fault = await send(good, HEADERS, connected({ METRICS: m.binding, MEMORY: asD1(broken) }));
  assert.equal(fault.status, 503);
  assert.deepEqual(await body(fault), { ok: false, error: NOT_DELIVERED });
  broken.close();

  // Bound but not migrated: there is no counters table to take a slot from.
  const unmigrated = new TestD1();
  const noTable = await send(good, HEADERS, connected({ METRICS: m.binding, MEMORY: asD1(unmigrated) }));
  assert.equal(noTable.status, 503);
  assert.deepEqual(await body(noTable), { ok: false, error: NOT_DELIVERED });
  unmigrated.close();
  assert.deepEqual(kinds(m), ['503-cap-error', '503-cap-error']);
});
