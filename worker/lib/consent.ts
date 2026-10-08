/**
 * The signed visitor id behind Phase 2 memory. An id is 128 random bits as hex; its cookie value is `${id}.${mac}`
 * with mac = HMAC-SHA-256(VISITOR_HMAC_KEY, id), so an altered or invented cookie verifies to nothing and the
 * database is only ever asked about ids this Worker issued.
 *
 * The cookie is set only after consent (POST /api/talk/session) and cleared by "Forget me" (DELETE /api/memory).
 * Its attributes: HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age 13 months (Secure dropped on localhost only,
 * where wrangler dev serves plain http).
 */
const encoder = new TextEncoder();
const ID_PATTERN = /^[0-9a-f]{32}$/;
const MAC_BYTES = 32;

/** A fresh id: 16 random bytes as lower-case hex. */
export const newVisitorId = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (text: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
};

/** The cookie value for an id. Throws on anything that is not an id, since that is a programming error. */
export async function signVisitorId(secret: string, id: string): Promise<string> {
  if (!secret) throw new Error('consent: VISITOR_HMAC_KEY is not set');
  if (!ID_PATTERN.test(id)) throw new Error('consent: not a visitor id');
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(id));
  return `${id}.${toBase64Url(mac)}`;
}

/** The id inside a cookie value, or null for anything not signed with this secret. Never throws on input. */
export async function verifyVisitorId(secret: string, signed: string): Promise<string | null> {
  if (!secret) return null;
  const parts = signed.split('.');
  const [id, mac] = parts;
  if (parts.length !== 2 || !id || !mac || !ID_PATTERN.test(id)) return null;
  const bytes = fromBase64Url(mac);
  if (!bytes || bytes.length !== MAC_BYTES) return null;
  // Only the canonical encoding is accepted: the last base64url character carries two padding bits that atob
  // ignores, so several strings decode to the same bytes. Comparing the input with its own re-encoding (not
  // with a secret) rejects those aliases without leaking anything through timing.
  if (toBase64Url(bytes.buffer as ArrayBuffer) !== mac) return null;
  // subtle.verify compares in constant time; a string comparison of the two macs would not.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, encoder.encode(id));
  return valid ? id : null;
}

/** The cookie's name and lifetime (13 months; the data itself goes after 12 idle months). */
export const COOKIE_NAME = 'em_vid';
export const COOKIE_MAX_AGE = 34_164_000;

/** The consent copy the Talk sheet shows; a visitor who agreed to an older one is asked again. */
export const CONSENT_VERSION = 1;

/** One cookie's value from a Cookie header, or null. */
export function readCookie(request: Request, name = COOKIE_NAME): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

const attributes = (secure: boolean, maxAge: number): string =>
  `HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax; Path=/api; Max-Age=${maxAge}`;

/** Set-Cookie for a signed value. `secure` is false only for wrangler dev on a local host. */
export const visitorCookie = (signed: string, secure: boolean): string =>
  `${COOKIE_NAME}=${signed}; ${attributes(secure, COOKIE_MAX_AGE)}`;

/** Set-Cookie that removes the cookie. */
export const clearVisitorCookie = (secure: boolean): string => `${COOKIE_NAME}=; ${attributes(secure, 0)}`;

/** The verified visitor id behind the request's cookie, or null. */
export async function cookieVisitor(request: Request, secret: string | undefined): Promise<string | null> {
  const value = readCookie(request);
  if (!value || !secret) return null;
  return verifyVisitorId(secret, value);
}

/**
 * The opaque id Convai knows the visitor by: HMAC(key, "convai:" + id), 32 hex characters. It cannot be turned
 * back into the cookie id, so Convai never holds anything that opens this database.
 */
export async function endUserId(secret: string, id: string): Promise<string> {
  if (!secret) throw new Error('consent: VISITOR_HMAC_KEY is not set');
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`convai:${id}`));
  return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
