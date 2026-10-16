/**
 * Paid talk time through Stripe Checkout.
 *
 *   POST /api/pay/checkout  the visitor (with consent, known by the signed cookie) gets a Checkout url for the pack.
 *   POST /api/pay/webhook   Stripe says a Checkout completed: verified by signature, then credited once.
 *   GET  /api/pay/status    the visitor's return (?id=cs_...): the Checkout is read back from Stripe and credited
 *                           if the webhook has not arrived yet; answers the balance.
 *
 * Crediting is idempotent (lib/memory.ts recordPayment: one row per Checkout id), so the webhook and the return can
 * both confirm the same payment. Without STRIPE_SECRET_KEY every route answers 503 and Talk offers no Buy button.
 */
import type { ApiContext } from '../lib/compose.ts';
import { fail, json, siteOrigin } from '../lib/http.ts';
import { addCredit, creditSeconds, recordPayment } from '../lib/memory.ts';
import { writePoint } from '../lib/metrics.ts';
import {
  type CheckoutSession,
  createCheckout,
  PACK,
  retrieveCheckout,
  StripeError,
  verifyWebhook,
} from '../lib/stripe.ts';
import { consented, store } from '../lib/visitor.ts';

export const PAY_OFF = 'Buying minutes is not switched on yet. Please write to 4d@emersa.io.';
export const PAY_FAILED = 'The payment page could not be opened. Please try again in a minute.';
/** The webhook body is a single event; Stripe's are a few kilobytes. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

/** Credit a paid Checkout once; true when this call is the one that credited it. */
async function credit(c: ApiContext, session: CheckoutSession): Promise<boolean> {
  const db = c.env.MEMORY;
  const visitorId = session.client_reference_id ?? session.metadata?.visitor ?? '';
  if (!db || session.payment_status !== 'paid' || !visitorId) return false;
  const seconds = Number(session.metadata?.seconds) || PACK.seconds;
  const fresh = await recordPayment(db, {
    id: session.id,
    visitorId,
    seconds,
    amount: session.amount_total ?? PACK.amount,
    currency: session.currency ?? PACK.currency,
  });
  if (!fresh) return false;
  await addCredit(db, visitorId, seconds);
  writePoint(c.env, c.route, 'credited');
  return true;
}

export async function payCheckout(c: ApiContext): Promise<Response> {
  const secret = c.env.STRIPE_SECRET_KEY;
  if (!secret) return fail(503, PAY_OFF);
  const s = store(c);
  if (s instanceof Response) return s;
  const id = await consented(c, s);
  if (id instanceof Response) return id;
  const origin = siteOrigin(c.request, c.env);
  try {
    const session = await createCheckout(secret, {
      visitorId: id,
      successUrl: `${origin}/?paid={CHECKOUT_SESSION_ID}#hero`,
      cancelUrl: `${origin}/?paid=cancelled#hero`,
      termsUrl: `${origin}/terms#minutes`,
    });
    writePoint(c.env, c.route, 'checkout');
    return json({ ok: true, url: session.url });
  } catch (error) {
    console.error('pay: checkout failed', error instanceof StripeError ? error.message : 'unknown');
    writePoint(c.env, c.route, '502-stripe');
    return fail(502, PAY_FAILED);
  }
}

export async function payWebhook(c: ApiContext): Promise<Response> {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !c.env.MEMORY) return fail(503, PAY_OFF);
  const length = Number(c.request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_WEBHOOK_BYTES) return fail(413, 'Too large.');
  const payload = await c.request.text();
  if (payload.length > MAX_WEBHOOK_BYTES) return fail(413, 'Too large.');
  if (!(await verifyWebhook(secret, payload, c.request.headers.get('stripe-signature')))) {
    writePoint(c.env, c.route, '400-signature');
    return fail(400, 'Bad signature.');
  }
  let event: { type?: string; data?: { object?: CheckoutSession } };
  try {
    event = JSON.parse(payload);
  } catch {
    return fail(400, 'Bad event.');
  }
  const session = event.data?.object;
  if (
    (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') &&
    session &&
    typeof session.id === 'string'
  ) {
    await credit(c, session);
  }
  // Every verified event is acknowledged, so Stripe stops retrying what this site does not use.
  return json({ ok: true });
}

export async function payStatus(c: ApiContext): Promise<Response> {
  const secret = c.env.STRIPE_SECRET_KEY;
  if (!secret) return fail(503, PAY_OFF);
  const s = store(c);
  if (s instanceof Response) return s;
  const id = await consented(c, s);
  if (id instanceof Response) return id;
  const checkout = c.url.searchParams.get('id') ?? '';
  let added = false;
  if (checkout) {
    try {
      const session = await retrieveCheckout(secret, checkout);
      // Only the visitor who bought it can confirm it: another person's Checkout id credits nobody here.
      if ((session.client_reference_id ?? session.metadata?.visitor) === id) added = await credit(c, session);
    } catch (error) {
      console.error('pay: status failed', error instanceof StripeError ? error.message : 'unknown');
    }
  }
  return json({ ok: true, seconds: await creditSeconds(s.db, id), added });
}
