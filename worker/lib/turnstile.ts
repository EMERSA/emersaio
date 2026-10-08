/**
 * Cloudflare Turnstile, checked server side. POST /api/talk/session (routes/talk.ts) calls verify() with
 * TURNSTILE_SECRET before minting a Convai token, and fails closed there (no pass, no session). The documented test
 * secrets (1x0000000000000000000000000000000AA always passes) let the browser flow run end to end in development.
 */
export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Turnstile tokens are well under this; anything longer is not one. */
const MAX_TOKEN = 2048;

/** A Turnstile that does not answer in this long is a failure. */
const TIMEOUT_MS = 5000;

/**
 * True when Turnstile confirms the token was issued for this site to this visitor. The address is passed on for
 * the check and not kept. Any failure, including a network one, is false: a pass must be proven.
 */
export async function verify(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!secret || !token || token.length > MAX_TOKEN) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}
