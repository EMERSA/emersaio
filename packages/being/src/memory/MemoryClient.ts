import type { Fact, Turn } from '../types.ts';

export interface MemorySnapshot {
  facts: Fact[];
  turns: Turn[];
}

export interface MemoryClientOptions {
  /** The memory routes; defaults to /api/memory (GET, DELETE) and /api/memory/turns (POST). */
  endpoint?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const EMPTY: MemorySnapshot = { facts: [], turns: [] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const isFact = (value: unknown): value is Fact =>
  isRecord(value) &&
  typeof value.key === 'string' &&
  typeof value.value === 'string' &&
  typeof value.confidence === 'number';

const isTurn = (value: unknown): value is Turn =>
  isRecord(value) &&
  (value.role === 'user' || value.role === 'being') &&
  typeof value.text === 'string' &&
  typeof value.at === 'number';

/** Keep only the rows that have our shape; the Worker is trusted, the parser still is not lenient. */
export const parseSnapshot = (payload: unknown): MemorySnapshot => {
  if (!isRecord(payload)) return { facts: [], turns: [] };
  const facts = Array.isArray(payload.facts) ? payload.facts.filter(isFact) : [];
  const turns = Array.isArray(payload.turns) ? payload.turns.filter(isTurn) : [];
  return { facts, turns };
};

/**
 * What the being remembers about this visitor, as the Worker keeps it (Phase 2). Until the routes exist they
 * answer 404 or 503, and every method treats that as "nothing remembered" rather than a failure.
 */
export class MemoryClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: MemoryClientOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/memory';
    this.fetchImpl = options.fetch;
  }

  async get(): Promise<MemorySnapshot> {
    const response = await this.request('GET', '');
    if (response === undefined) return { ...EMPTY };
    return parseSnapshot(await response.json());
  }

  /** "Forget me": true when the Worker confirmed, false when there was nothing to forget yet. */
  async forget(): Promise<boolean> {
    return (await this.request('DELETE', '')) !== undefined;
  }

  /** Mirror one turn; false when memory is not available, which the caller may ignore. */
  async recordTurn(turn: Turn): Promise<boolean> {
    return (await this.request('POST', '/turns', turn)) !== undefined;
  }

  private async request(
    method: 'GET' | 'DELETE' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Response | undefined> {
    const fetchImpl = this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (fetchImpl === undefined) return undefined;
    const response = await fetchImpl(`${this.endpoint}${path}`, {
      method,
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    if (response.status === 404 || response.status === 503) return undefined;
    if (!response.ok) throw new Error(`Memory request failed (${response.status})`);
    return response;
  }
}
