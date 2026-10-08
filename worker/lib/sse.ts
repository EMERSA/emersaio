/**
 * Server-sent events: frame() builds one event, sseStream() gives a writer and the Response that streams it.
 * Data is always JSON on one line, so a newline inside visitor or model text can never end a frame early.
 */
import { SECURE_HEADERS } from './http.ts';

const encoder = new TextEncoder();

export type SseEvent = 'token' | 'action' | 'done' | 'error';

/** One event: "event: <name>\ndata: <json>\n\n". */
export const frame = (event: SseEvent, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export interface SseWriter {
  send(event: SseEvent, data: unknown): Promise<void>;
  close(): Promise<void>;
}

/**
 * A writer and the Response that streams what it sends. Frames are queued without back-pressure (a reply is a few
 * hundred tokens), so the producer never waits on a slow or absent reader; a cancelled stream drops later frames.
 */
export function sseStream(status = 200): { writer: SseWriter; response: Response } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const writer: SseWriter = {
    async send(event, data) {
      if (closed) return;
      try {
        controller?.enqueue(encoder.encode(frame(event, data)));
      } catch {
        closed = true;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        controller?.close();
      } catch {
        // Already errored or cancelled.
      }
    },
  };
  const response = new Response(readable, {
    status,
    headers: { ...SECURE_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' },
  });
  return { writer, response };
}

/**
 * Read an upstream event stream (OpenAI-compatible chat completions) and yield each "data:" payload. Comments and
 * other fields are skipped; the stream may split a line anywhere.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += value;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
      at = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.startsWith('data:')) yield buffer.slice(5).trim();
}
