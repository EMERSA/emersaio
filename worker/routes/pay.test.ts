/**
 * Paid talk time: Checkout, the signed webhook, the return page, and Talk spending and refunding bought minutes.
 * Stripe is mocked at fetch; the database is the in-memory D1 with every migration applied.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { creditSeconds } from '../lib/memory.ts';
import { PACK, signWebhook, verifyWebhook } from '../lib/stripe.ts';
import { asD1 } from '../test/d1.ts';
import { body, call, post, SAME_SITE } from '../test/harness.ts';
import { talkEnv, upstreams, visitor } from '../test/talk.ts';
import { FIRST_DAY_CONVERSATIONS } from './talk.ts';

const CHECKOUT = 'https://emersa.io/api/pay/checkout';
const WEBHOOK = 'https://emersa.io/api/pay/webhook';
const STATUS = 'https://emersa.io/api/pay/status';
const SESSION = 'https://emersa.io/api/talk/session';
const REVOKE = 'https://emersa.io/api/talk/revoke';
const WHSEC = 'whsec_test_secret';
const good = JSON.stringify({ turnstile: 'ok', consentVersion: 3 });
const jsonPost = (b: string, h: Record<string, string> = {}) => post(b, { ...SAME_SITE, ...h }, 'application/json');

let restore = (): void => {};
afterEach(() => {
  restore();
  restore = () => {};
});

const payEnv = () => talkEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: WHSEC });

const completed = (visitorId: string, id = 'cs_test_abc', status = 'paid') =>
  JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id,
        payment_status: status,
        amount_total: 500,
        currency: 'gbp',
        client_reference_id: visitorId,
        metadata: { visitor: visitorId, seconds: '3600' },
      },
    },
  });

const deliver = async (env: ReturnType<typeof payEnv>['env'], payload: string, header?: string) =>
  call(
    WEBHOOK,
    {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': header ?? (await signWebhook(WHSEC, payload, Math.floor(Date.now() / 1000))),
      },
    },
    env,
  );

test('the webhook signature: right secret and fresh only', async () => {
  const now = Date.now();
  const header = await signWebhook(WHSEC, 'body', Math.floor(now / 1000));
  assert.ok(await verifyWebhook(WHSEC, 'body', header, now));
  assert.ok(!(await verifyWebhook(WHSEC, 'other body', header, now)), 'the body is signed');
  assert.ok(!(await verifyWebhook('whsec_wrong', 'body', header, now)), 'the secret is checked');
  assert.ok(!(await verifyWebhook(WHSEC, 'body', header, now + 600_000)), 'a replay ten minutes later is refused');
  assert.ok(!(await verifyWebhook(WHSEC, 'body', null, now)));
});

test('a paid Checkout credits 60 minutes once, however often Stripe delivers it', async () => {
  const { env, db } = payEnv();
  const v = await visitor(db);
  const payload = completed(v.id);
  assert.equal((await deliver(env, payload)).status, 200);
  assert.equal((await deliver(env, payload)).status, 200);
  assert.equal(await creditSeconds(asD1(db), v.id), PACK.seconds);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM payment').get()?.n, 1);
  // A forged or unpaid event credits nothing.
  assert.equal((await deliver(env, completed(v.id, 'cs_test_forged'), 't=1,v1=00')).status, 400);
  assert.equal((await deliver(env, completed(v.id, 'cs_test_unpaid', 'unpaid'))).status, 200);
  assert.equal(await creditSeconds(asD1(db), v.id), PACK.seconds);
});

test('checkout: off without the key; with it, a Stripe page for this visitor and the pack', async () => {
  const off = talkEnv();
  const v0 = await visitor(off.db);
  assert.equal((await call(CHECKOUT, jsonPost('{}', { cookie: v0.cookie }), off.env)).status, 503);

  const { env, db } = payEnv();
  const v = await visitor(db);
  let sent = '';
  restore = upstreams({
    other: async (url, init) => {
      assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
      sent = String(init?.body ?? '');
      return Response.json({ id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
    },
  });
  const response = await call(CHECKOUT, jsonPost('{}', { cookie: v.cookie }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { ok: true, url: 'https://checkout.stripe.com/c/pay/cs_test_new' });
  const fields = new URLSearchParams(sent);
  assert.equal(fields.get('client_reference_id'), v.id);
  assert.equal(fields.get('line_items[0][price_data][unit_amount]'), '500');
  assert.equal(fields.get('line_items[0][price_data][currency]'), 'gbp');
  assert.match(fields.get('success_url') ?? '', /\?paid=\{CHECKOUT_SESSION_ID\}/);
  // No cookie, no consent: no checkout.
  assert.equal((await call(CHECKOUT, jsonPost('{}'), env)).status, 403);
});

test('the return page confirms only the buyer’s own Checkout, and reports the balance', async () => {
  const { env, db } = payEnv();
  const v = await visitor(db);
  const other = await visitor(db, 'd'.repeat(32));
  restore = upstreams({
    other: async (url) => {
      const id = url.split('/').pop() ?? '';
      return Response.json({
        id,
        payment_status: 'paid',
        amount_total: 500,
        currency: 'gbp',
        client_reference_id: id === 'cs_test_mine' ? v.id : other.id,
        metadata: { seconds: '3600' },
      });
    },
  });
  const mine = await call(`${STATUS}?id=cs_test_mine`, { headers: { cookie: v.cookie } }, env);
  assert.deepEqual(await body(mine), { ok: true, seconds: 3600, added: true });
  const theirs = await call(`${STATUS}?id=cs_test_theirs`, { headers: { cookie: v.cookie } }, env);
  assert.deepEqual(await body(theirs), { ok: true, seconds: 3600, added: false });
  assert.equal(await creditSeconds(asD1(db), other.id), 0);
});

test('Talk: the free conversations first, then bought minutes; a paid session refunds to credit', async () => {
  const { env, db } = payEnv();
  const v = await visitor(db);
  restore = upstreams();
  for (let n = 0; n < FIRST_DAY_CONVERSATIONS; n++) {
    assert.equal((await call(SESSION, jsonPost(good, { cookie: v.cookie }), env)).status, 200);
  }
  const refused = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(refused.status, 429);
  assert.equal((await body(refused)).buy, true, 'the refusal offers the Buy button');

  await deliver(env, completed(v.id));
  const paid = await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  assert.equal(paid.status, 200);
  const b = await body(paid);
  assert.equal(b.session.maxMinutes, 20);
  assert.deepEqual(b.allowance, { paid: true, minutesLeft: 40 });
  assert.equal(await creditSeconds(asD1(db), v.id), 2400);
  // Ended after 100 seconds: the other 1100 go back to the bought minutes.
  db.sqlite.prepare('UPDATE session SET started_at = started_at - 100000 WHERE visitor_id = ? AND paid = 1').run(v.id);
  await call(REVOKE, { method: 'POST', headers: { ...SAME_SITE, cookie: v.cookie } }, env);
  const left = await creditSeconds(asD1(db), v.id);
  assert.ok(left >= 3498 && left <= 3500, `left ${left}`);
});

test('the allowance as Talk opens: three left for someone new, the refusal and Buy once they are used', async () => {
  const { env, db } = payEnv();
  const ALLOWANCE = 'https://emersa.io/api/talk/allowance';
  const fresh = await body(await call(ALLOWANCE, { headers: {} }, env));
  assert.deepEqual(
    { left: fresh.left, of: fresh.of, buy: fresh.buy, message: fresh.message },
    { left: 3, of: 3, buy: true, message: '' },
  );
  const v = await visitor(db);
  restore = upstreams();
  for (let n = 0; n < FIRST_DAY_CONVERSATIONS; n++) await call(SESSION, jsonPost(good, { cookie: v.cookie }), env);
  const out = await body(await call(ALLOWANCE, { headers: { cookie: v.cookie } }, env));
  assert.equal(out.left, 0);
  assert.match(out.message, /buy 60 minutes for £5/);
  await deliver(env, completed(v.id));
  const paid = await body(await call(ALLOWANCE, { headers: { cookie: v.cookie } }, env));
  assert.equal(paid.creditMinutes, 60);
  assert.equal(paid.message, '', 'bought minutes mean Start stays');
});
