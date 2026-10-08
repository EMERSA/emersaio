/**
 * The fake platform the Worker tests run on: an ASSETS stub that records what it was asked for, an Analytics
 * Engine stub that keeps its points, limiter stubs, a fetch mock, and call() through the Worker's own fetch
 * handler. Nothing here talks to the network.
 */
import assert from 'node:assert/strict';
import worker from '../index.ts';
import type { Env } from '../lib/env.ts';
import { SECURE_HEADERS } from '../lib/http.ts';

export const assetsAsked: string[] = [];

export const ASSETS = {
  fetch: async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assetsAsked.push(url.pathname);
    const missing = url.pathname === '/missing';
    return new Response(missing ? 'asset /404' : `asset ${url.pathname}`, { status: missing ? 404 : 200 });
  },
} as unknown as Fetcher;

export interface Metrics {
  points: AnalyticsEngineDataPoint[];
  binding: AnalyticsEngineDataset;
}

export function metrics(): Metrics {
  const points: AnalyticsEngineDataPoint[] = [];
  return {
    points,
    binding: {
      writeDataPoint: (point?: AnalyticsEngineDataPoint): void => {
        if (point) points.push(point);
      },
    },
  };
}

/** The kinds written so far, in order: the second blob of every point. */
export const kinds = (m: Metrics): string[] => m.points.map((p) => String(p.blobs?.[1] ?? ''));

export const limiter = (success: boolean): RateLimit => ({ limit: async () => ({ success }) });

export const brokenLimiter: RateLimit = {
  limit: async () => {
    throw new Error('limiter down');
  },
};

export const fakeEnv = (overrides: Partial<Env> = {}): Env => ({
  ASSETS,
  ENV: 'production',
  NIM_BASE_URL: '',
  NIM_MODEL: 'nvidia/nemotron-nano-3-30b-a3b',
  CONVAI_CHARACTER_ID: '',
  TURNSTILE_SITEKEY: '',
  PUBLIC_BRAIN: 'convai',
  ...overrides,
});

const pending: Promise<unknown>[] = [];

export const ctx = {
  waitUntil: (promise: Promise<unknown>): void => {
    pending.push(promise);
  },
  passThroughOnException: (): void => {},
} as unknown as ExecutionContext;

/** Wait for everything handed to ctx.waitUntil, as the platform would before ending the invocation. */
export async function settle(): Promise<void> {
  while (pending.length) await Promise.allSettled(pending.splice(0));
}

type Incoming = Parameters<typeof worker.fetch>[0];

/** A built Request through the Worker, with cf and the like already attached by the test. */
export async function callRequest(request: Request, env: Env = fakeEnv()): Promise<Response> {
  const response = await worker.fetch(request as unknown as Incoming, env, ctx);
  await settle();
  return response;
}

export const call = (url: string, init: RequestInit = {}, env: Env = fakeEnv()): Promise<Response> =>
  callRequest(new Request(url, init), env);

export const form = (fields: Record<string, string>): string => new URLSearchParams(fields).toString();

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** A POST with the body's real length declared, as browsers and fetch() do. */
export const post = (
  body: string,
  headers: Record<string, string> = {},
  type = 'application/x-www-form-urlencoded',
): RequestInit => ({
  method: 'POST',
  body,
  headers: { 'content-type': type, 'content-length': String(bytes(body)), ...headers },
});

export const JSON_ACCEPT = { accept: 'application/json' } as const;
export const SAME_SITE = { origin: 'https://emersa.io', 'sec-fetch-site': 'same-origin' } as const;

/** A submission that passes every check. `started` is long ago, so the fill-time check is satisfied. */
export const good = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  company: 'Analytical Engines',
  topic: 'emily',
  message: 'We would like to see Emily walk a runbook with our operations team.',
  started: '1',
};

export type FetchMock = (url: string, init: RequestInit) => Response | Promise<Response>;

/** Replace the global fetch for a test; returns the function that puts the real one back. */
export function mockFetch(handler: FetchMock): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    handler(input instanceof Request ? input.url : String(input), init ?? {})) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** A fetch that must not be called: proof that a path never reached the network. */
export const noFetch = (): (() => void) =>
  mockFetch((url) => {
    throw new Error(`unexpected fetch of ${url}`);
  });

export function assertSecure(response: Response, label: string, cacheable = false): void {
  for (const [name, value] of Object.entries(SECURE_HEADERS)) {
    if (cacheable && name === 'Cache-Control') continue;
    assert.equal(response.headers.get(name), value, `${label}: ${name}`);
  }
}

/** The JSON body as the reply shape every route shares. */
export const body = async (response: Response): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> =>
  (await response.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
