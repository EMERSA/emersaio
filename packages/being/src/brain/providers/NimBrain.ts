import type { Brain, BrainContext, BrainEvent } from '../../types.ts';

/**
 * Phase 2 options for the NVIDIA NIM path. The browser never holds a key: it posts the context to the Worker,
 * which streams `${NIM_BASE_URL}/chat/completions` back as SSE.
 */
export interface NimBrainOptions {
  /** The Worker route that proxies the model; defaults to /api/brain. */
  endpoint?: string;
  /** Model id the Worker is asked for; the Worker may override it with NIM_MODEL. */
  model?: string;
  /** Reply cap in tokens (300 by default, matching the Worker's own limit). */
  maxTokens?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export const NIM_NOT_YET = 'Available in Phase 2';

/** Typed stub until the brain route ships; respond() throws so a misconfigured shell fails at first use. */
export class NimBrain implements Brain {
  readonly name = 'nim';
  readonly options: Readonly<NimBrainOptions>;

  constructor(options: NimBrainOptions = {}) {
    this.options = { endpoint: '/api/brain', maxTokens: 300, ...options };
  }

  respond(_context: BrainContext): AsyncIterable<BrainEvent> {
    throw new Error(NIM_NOT_YET);
  }
}
