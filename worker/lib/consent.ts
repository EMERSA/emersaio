/**
 * The signed visitor id behind Phase 2 memory. An id is 128 random bits as hex; its cookie value is `${id}.${mac}`
 * with mac = HMAC-SHA-256(VISITOR_HMAC_KEY, id), so an altered or invented cookie verifies to nothing and the
 * database is only ever asked about ids this Worker issued.
 *
 * TODO Phase 2: set the cookie only after consent (POST /api/talk/session), clear it from "Forget me", and re-ask
 * when consent_version changes. Name and attributes are fixed there, next to the route that sets them.
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
