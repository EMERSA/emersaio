/**
 * Phase 2 test helpers: an environment with everything Talk needs, a consented visitor and its cookie, and a
 * mocked fetch that answers Turnstile, Convai and NIM as they do.
 */
import { CONSENT_VERSION, signVisitorId } from '../lib/consent.ts';
import type { Env } from '../lib/env.ts';
import { recordConsent } from '../lib/memory.ts';
import { asD1, type TestD1, testDatabase } from './d1.ts';
import { type FetchMock, fakeEnv, mockFetch } from './harness.ts';

export const HMAC = 'test-key-that-is-long-enough-for-hmac';

export function talkEnv(overrides: Partial<Env> = {}): { env: Env; db: TestD1 } {
  const db = testDatabase();
  const env = fakeEnv({
    MEMORY: asD1(db),
    VISITOR_HMAC_KEY: HMAC,
    TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
    CONVAI_API_KEY: 'convai-test-key',
    CONVAI_CHARACTER_ID: 'char-1',
    ...overrides,
  });
  return { env, db };
}

/** A consented visitor already in the database, and its Cookie header. */
export async function visitor(db: TestD1, id = 'c'.repeat(32)): Promise<{ id: string; cookie: string }> {
  await recordConsent(asD1(db), id, CONSENT_VERSION);
  return { id, cookie: `em_vid=${await signVisitorId(HMAC, id)}` };
}

export interface Upstreams {
  turnstile?: boolean;
  convai?: () => Response | Promise<Response>;
  nim?: () => Response | Promise<Response>;
  other?: FetchMock;
}

export const seen: string[] = [];

export function upstreams(u: Upstreams = {}): () => void {
  seen.length = 0;
  return mockFetch(async (url, init) => {
    seen.push(url);
    if (url.includes('turnstile')) return Response.json({ success: u.turnstile ?? true });
    if (url.startsWith('https://api.convai.com/user/connect')) {
      return u.convai ? u.convai() : Response.json({ apiAuthToken: 'tok-1' });
    }
    if (url.startsWith('https://api.convai.com/')) return new Response(null, { status: 200 });
    if (url.includes('/chat/completions') && u.nim) return u.nim();
    if (u.other) return u.other(url, init);
    throw new Error(`unexpected fetch of ${url}`);
  });
}
