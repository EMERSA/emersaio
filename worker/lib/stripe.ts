/**
 * Stripe, by its REST API (no SDK in the Worker): a hosted Checkout page for one pack of talk time, the signature
 * check on its webhook, and reading a Checkout back when the visitor returns. Card details never reach this site;
 * Stripe's page takes them. The secret key and the webhook signing secret are Worker secrets (lib/env.ts).
 */

export const STRIPE_API = 'https://api.stripe.com/v1';
/** How old a webhook signature may be before it is refused as a replay. */
export const WEBHOOK_TOLERANCE_S = 300;

/** The pack on sale: one price, one product, made inline on each Checkout so nothing has to be set up in Stripe. */
export const PACK = {
  amount: 500,
  currency: 'gbp',
  seconds: 3600,
  name: 'Talk with Emily: 60 minutes',
} as const;

/** The parts of a Checkout Session this site reads. */
export interface CheckoutSession {
  id: string;
  url?: string | null;
  payment_status?: string;
  status?: string;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
}

export class StripeError extends Error {}

const form = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

async function call(secret: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
      ...(init.headers ?? {}),
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new StripeError(`stripe ${response.status}`);
  return body;
}

/** A Checkout Session for the pack, tied to the visitor; the visitor is sent to its url. */
export async function createCheckout(
  secret: string,
  options: { visitorId: string; successUrl: string; cancelUrl: string; termsUrl: string },
): Promise<CheckoutSession> {
  const body = form({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': PACK.currency,
    'line_items[0][price_data][unit_amount]': String(PACK.amount),
    'line_items[0][price_data][product_data][name]': PACK.name,
    client_reference_id: options.visitorId,
    'metadata[visitor]': options.visitorId,
    'metadata[seconds]': String(PACK.seconds),
    success_url: options.successUrl,
    cancel_url: options.cancelUrl,
    'custom_text[submit][message]': `The minutes are yours at once. By paying you agree to the Terms (${options.termsUrl}) and that, as they are digital content supplied straight away, the 14-day right to cancel ends once you start a paid conversation.`,
  });
  const session = (await call(secret, '/checkout/sessions', { method: 'POST', body })) as CheckoutSession;
  if (typeof session?.id !== 'string' || typeof session.url !== 'string') throw new StripeError('stripe: no url');
  return session;
}

/** Read a Checkout Session back by id (the visitor's return carries it). */
export async function retrieveCheckout(secret: string, id: string): Promise<CheckoutSession> {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) throw new StripeError('stripe: not a checkout id');
  return (await call(secret, `/checkout/sessions/${id}`, { method: 'GET' })) as CheckoutSession;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** Equal-time comparison of two hex strings. */
const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Stripe's webhook signature: the Stripe-Signature header is "t=<seconds>,v1=<hex>[,v1=...]", where v1 is
 * HMAC-SHA-256 of "<t>.<raw body>" under the endpoint's signing secret. True only for a fresh, matching signature.
 */
export async function verifyWebhook(
  secret: string,
  payload: string,
  header: string | null,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!secret || !header) return false;
  const parts = header.split(',').map((part) => part.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!Number.isFinite(t) || signatures.length === 0) return false;
  if (Math.abs(nowMs / 1000 - t) > WEBHOOK_TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const expected = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${payload}`)));
  return signatures.some((signature) => same(signature, expected));
}

/** The test helper's counterpart: the header Stripe would send for this body at this time. */
export async function signWebhook(secret: string, payload: string, t: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return `t=${t},v1=${hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${t}.${payload}`)))}`;
}
