import type { Brain, BrainContext, BrainEvent, SpeechOut, TourAction } from '../../types.ts';

/**
 * The NVIDIA NIM text path. The browser never holds a key: it posts the question to the Worker, which streams
 * `${NIM_BASE_URL}/chat/completions` back as server-sent events named token, action, done and error. EventSource
 * cannot POST, so the stream is read with fetch and a ReadableStream.
 */
export interface NimBrainOptions {
  /** The Worker route that proxies the model; defaults to /api/brain. */
  endpoint?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

/** One parsed server-sent event. */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental SSE parser (the WHATWG rules the Worker's stream needs): fields `event:` and `data:` (several data
 * lines join with a newline), comments start with ':', a blank line ends the event, CRLF and CR count as LF.
 */
export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (match === null) break;
      // A lone CR at the end may be the first half of CRLF; wait for the next chunk.
      if (match[0] === '\r' && match.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message !== undefined) out.push(message);
    }
    return out;
  }

  /** The end of the stream dispatches an event that was not followed by a blank line. */
  flush(): SseMessage[] {
    const out = this.buffer === '' ? [] : this.push('\n');
    const last = this.line('');
    if (last !== undefined) out.push(last);
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return undefined;
      }
      const message = { event: this.event === '' ? 'message' : this.event, data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      return message;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return undefined;
  }
}

const ACTION_TYPES = new Set(['goto', 'highlight', 'point', 'emote', 'open']);

const parseJson = (data: string): unknown => {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Map one SSE message to a brain event; token data may be JSON { text } or the bare text. */
export const toBrainEvent = (message: SseMessage): BrainEvent | undefined => {
  const json = parseJson(message.data);
  switch (message.event) {
    case 'message':
    case 'token': {
      const text = isRecord(json) && typeof json.text === 'string' ? json.text : json === undefined ? message.data : '';
      return text === '' ? undefined : { type: 'token', text };
    }
    case 'action': {
      const action = isRecord(json) && isRecord(json.action) ? json.action : json;
      if (!isRecord(action) || typeof action.type !== 'string' || !ACTION_TYPES.has(action.type)) return undefined;
      return { type: 'action', action: action as unknown as TourAction };
    }
    case 'done': {
      const reason = isRecord(json) ? json.reason : undefined;
      return { type: 'done', reason: reason === 'limit' || reason === 'aborted' ? reason : 'complete' };
    }
    case 'error': {
      const text = isRecord(json) && typeof json.message === 'string' ? json.message : message.data;
      return { type: 'error', message: text === '' ? 'The brain stopped.' : text };
    }
    default:
      return undefined;
  }
};

/** Pull every brain event out of an SSE byte stream. */
export async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<BrainEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      const messages = done
        ? parser.push(decoder.decode()).concat(parser.flush())
        : parser.push(decoder.decode(value, { stream: true }));
      for (const message of messages) {
        const event = toBrainEvent(message);
        if (event !== undefined) yield event;
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export class NimBrain implements Brain {
  readonly name = 'nim';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: NimBrainOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/brain';
    this.fetchImpl = options.fetch;
  }

  async *respond(context: BrainContext): AsyncGenerator<BrainEvent> {
    const fetchImpl = this.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        // Only the validated page id travels; the Worker builds the page context from its own copy.
        body: JSON.stringify(
          context.page === undefined ? { text: context.text } : { text: context.text, page: { id: context.page.id } },
        ),
        credentials: 'same-origin',
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal?.aborted) {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      yield { type: 'error', message: error instanceof Error ? error.message : 'Network error.' };
      return;
    }
    if (!response.ok || response.body === null) {
      const payload: unknown = await response.json().catch(() => undefined);
      const message =
        isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`;
      yield { type: 'error', message };
      return;
    }
    let ended = false;
    try {
      for await (const event of readSse(response.body, context.signal)) {
        yield event;
        if (event.type === 'done' || event.type === 'error') {
          ended = true;
          return;
        }
      }
    } catch (error) {
      ended = true;
      yield context.signal?.aborted
        ? { type: 'done', reason: 'aborted' }
        : { type: 'error', message: error instanceof Error ? error.message : 'The stream broke.' };
    }
    if (!ended) yield { type: 'done', reason: context.signal?.aborted ? 'aborted' : 'complete' };
  }
}

/**
 * Speak a reply sentence by sentence as the chain produces them (standardChain puts the sentence chunker and the
 * token meter in front), through any SpeechOut: BrowserTts today, AzureTts once its Worker route exists. Each
 * sentence waits for the one before it, so the voice never overlaps itself.
 */
export const speakSentences = async (
  events: AsyncIterable<BrainEvent>,
  speech: SpeechOut,
  onEvent?: (event: BrainEvent) => void,
  signal?: AbortSignal,
): Promise<void> => {
  let chain: Promise<void> = Promise.resolve();
  for await (const event of events) {
    onEvent?.(event);
    if (event.type !== 'sentence' || signal?.aborted) continue;
    const text = event.text;
    chain = chain.then(() => (signal?.aborted ? undefined : speech.speak({ text, signal })));
  }
  await chain;
};
