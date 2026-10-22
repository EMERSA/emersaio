/**
 * The "10 free minutes" form: the team is mailed, the minutes are added once per visitor and once per address, a
 * failed send adds nothing, and the form is offered only to a visitor who has talked and not yet claimed it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EmailSender } from '../lib/env.ts';
import { creditSeconds } from '../lib/memory.ts';
import { asD1 } from '../test/d1.ts';
import { body, call, post, SAME_SITE } from '../test/harness.ts';
import { talkEnv, visitor } from '../test/talk.ts';
import { FORM_INVALID, FORM_TALK_FIRST, FORM_TO, FORM_USED } from './form.ts';

const FORM = 'https://emersa.io/api/form/minutes';
const ALLOWANCE = 'https://emersa.io/api/talk/allowance';

function mailbox(fail = false) {
  const sent: Parameters<EmailSender['send']>[0][] = [];
  const EMAIL: EmailSender = {
    send: async (message) => {
      if (fail) throw Object.assign(new Error('nope'), { code: 'E_SENDER_NOT_VERIFIED' });
      sent.push(message);
      return { messageId: `m${sent.length}` };
    },
  };
  return { EMAIL, sent };
}

const fields = (over: Record<string, string> = {}) =>
  JSON.stringify({
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    organisation: 'Analytical Ltd',
    role: 'investor',
    message: 'Compliance for a fund.',
    agree: 'yes',
    ...over,
  });
const send = (env: Parameters<typeof call>[2], b: string, cookie?: string) =>
  call(FORM, post(b, { ...SAME_SITE, ...(cookie ? { cookie } : {}) }, 'application/json'), env);

test('the form mails the team with a reply-to, then adds 10 minutes, once', async () => {
  const box = mailbox();
  const { env, db } = talkEnv({ guarded: false, EMAIL: box.EMAIL });
  const v = await visitor(db);
  const ok = await send(env, fields(), v.cookie);
  assert.equal(ok.status, 200);
  assert.deepEqual(await body(ok), { ok: true, minutes: 10 });
  assert.equal(await creditSeconds(asD1(db), v.id), 600);
  assert.equal(box.sent.length, 1);
  const mail = box.sent[0];
  assert.equal(mail?.to, FORM_TO);
  assert.deepEqual(mail?.replyTo, { email: 'ada@example.com', name: 'Ada Lovelace' });
  assert.match(mail?.subject ?? '', /Ada Lovelace \(An investor\)/);
  assert.match(mail?.text ?? '', /Compliance for a fund\./);
  // No row keeps the address itself.
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM reward WHERE email_hash LIKE '%@%'").get()?.n, 0);

  const again = await send(env, fields(), v.cookie);
  assert.equal(again.status, 409);
  assert.equal((await body(again)).error, FORM_USED);
  // The same address from another browser is the same person.
  const w = await visitor(db, 'e'.repeat(32));
  assert.equal((await send(env, fields({ email: 'ADA@example.com' }), w.cookie)).status, 409);
  assert.equal(await creditSeconds(asD1(db), w.id), 0);
  assert.equal(box.sent.length, 1);
});

test('a failed send adds nothing and can be tried again', async () => {
  const { env, db } = talkEnv({ guarded: false, EMAIL: mailbox(true).EMAIL });
  const v = await visitor(db);
  assert.equal((await send(env, fields(), v.cookie)).status, 502);
  assert.equal(await creditSeconds(asD1(db), v.id), 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM reward').get()?.n, 0);
});

test('refused: without the binding, before any conversation, or with a field missing', async () => {
  const off = talkEnv({ guarded: false });
  const v0 = await visitor(off.db);
  assert.equal((await send(off.env, fields(), v0.cookie)).status, 503);

  const { env, db } = talkEnv({ guarded: false, EMAIL: mailbox().EMAIL });
  const stranger = await send(env, fields());
  assert.equal(stranger.status, 403);
  assert.equal((await body(stranger)).error, FORM_TALK_FIRST);
  const v = await visitor(db);
  for (const bad of [{ email: 'not-an-email' }, { role: 'spy' }, { agree: '' }, { name: '' }]) {
    const r = await send(env, fields(bad), v.cookie);
    assert.equal(r.status, 422, JSON.stringify(bad));
    assert.equal((await body(r)).error, FORM_INVALID);
  }
});

test('the allowance offers the form until it is claimed', async () => {
  const box = mailbox();
  const { env, db } = talkEnv({ guarded: false, EMAIL: box.EMAIL });
  assert.equal((await body(await call(ALLOWANCE, { headers: {} }, env))).earn, false, 'not before a conversation');
  const v = await visitor(db);
  assert.equal((await body(await call(ALLOWANCE, { headers: { cookie: v.cookie } }, env))).earn, true);
  await send(env, fields(), v.cookie);
  assert.equal((await body(await call(ALLOWANCE, { headers: { cookie: v.cookie } }, env))).earn, false);
});
