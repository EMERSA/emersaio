/**
 * Convai's REST calls, made only by the Worker with CONVAI_API_KEY (the browser holds the one-hour token alone).
 * Every call has a 5 s timeout and fails with a ConvaiError whose kind the routes map to an answer.
 *
 * connect(): POST https://api.convai.com/user/connect, header CONVAI-API-KEY, body {}, answers { apiAuthToken }.
 * revoke(): Convai documents no token revocation endpoint for 1.8.0, so it is a no-op; the token lapses in an hour.
 * deleteMemories(): best effort, see the note on MEMORY_DELETE.
 */
export const CONVAI_API = 'https://api.convai.com';
export const CONNECT_URL = `${CONVAI_API}/user/connect`;
/**
 * Long-term memory delete for one end user. Unverified against Convai's public docs at the time of writing (the
 * plugins document per-speaker deletion only), so a failure here is logged and never fails "Forget me".
 */
export const MEMORY_DELETE = `${CONVAI_API}/user/end-user/memory/delete-all`;

/**
 * Test hook: CONVAI_API_BASE (a dev var) points the Worker at a mock Convai. Ignored in production and when it is
 * not an http(s) origin; every other case uses the real API.
 */
export function apiBase(env: { CONVAI_API_BASE?: string; ENV?: string }): string {
  const raw = env.CONVAI_API_BASE;
  if (!raw || env.ENV === 'production') return CONVAI_API;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : CONVAI_API;
  } catch {
    return CONVAI_API;
  }
}

export const TIMEOUT_MS = 5000;
/** The token Convai mints lives one hour. */
export const TOKEN_TTL_MS = 3_600_000;

export type ConvaiErrorKind = 'unauthorized' | 'timeout' | 'upstream' | 'bad-response' | 'network';

export class ConvaiError extends Error {
  readonly kind: ConvaiErrorKind;
  readonly status: number | undefined;

  constructor(kind: ConvaiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ConvaiError';
    this.kind = kind;
    this.status = status;
  }
}

async function post(apiKey: string, url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'CONVAI-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') throw new ConvaiError('timeout', 'convai: timed out');
    throw new ConvaiError('network', 'convai: unreachable');
  }
}

const statusError = (response: Response): ConvaiError =>
  response.status === 401 || response.status === 403
    ? new ConvaiError('unauthorized', 'convai: key refused', response.status)
    : new ConvaiError('upstream', `convai: answered ${response.status}`, response.status);

export interface ConvaiToken {
  token: string;
  expiresAt: string;
}

/** Mint a one-hour apiAuthToken. */
export async function connect(apiKey: string, nowMs = Date.now(), base = CONVAI_API): Promise<ConvaiToken> {
  const response = await post(apiKey, base === CONVAI_API ? CONNECT_URL : `${base}/user/connect`, {});
  if (!response.ok) throw statusError(response);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ConvaiError('bad-response', 'convai: not JSON');
  }
  const token = (payload as { apiAuthToken?: unknown } | null)?.apiAuthToken;
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new ConvaiError('bad-response', 'convai: no token');
  }
  return { token, expiresAt: new Date(nowMs + TOKEN_TTL_MS).toISOString() };
}

/** No revocation endpoint is documented; resolves at once so callers can treat it as done. */
export async function revoke(_apiKey: string, _token?: string): Promise<void> {}

/** Delete Convai's long-term memories for one end user. Best effort: false on any failure, never throws. */
export async function deleteMemories(apiKey: string, endUserId: string, base = CONVAI_API): Promise<boolean> {
  try {
    const url = base === CONVAI_API ? MEMORY_DELETE : `${base}/user/end-user/memory/delete-all`;
    const response = await post(apiKey, url, { end_user_id: endUserId });
    return response.ok;
  } catch {
    return false;
  }
}
