/**
 * Cloudflare Turnstile, checked server side. No Phase 1 route uses it; Phase 2's POST /api/talk/session calls
 * verify() before minting a Convai token, and fails closed there (no pass, no session).
 *
 * TODO Phase 2: call this from routes/talk.ts with TURNSTILE_SECRET; the test keys from the Turnstile docs let the
 * browser flow run end to end without a real challenge.
 */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Turnstile tokens are well under this; anything longer is not one. */
const MAX_TOKEN = 2048;

/**
 * True when Turnstile confirms the token was issued for this site to this visitor. The address is passed on for
 * the check and not kept. Any failure, including a network one, is false: a pass must be proven.
 */
export async function verify(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!secret || !token || token.length > MAX_TOKEN) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  try {
    const response = await fetch(SITEVERIFY, { method: 'POST', body });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}
