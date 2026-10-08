import type { BrainMiddleware } from '../../types.ts';

/** A clause this long with a comma in it is worth speaking before the sentence ends. */
export const COMMA_CHUNK_CHARS = 40;

const TERMINATOR = /[.!?]/;
const CLOSER = /["')\]]/;

/** Index just past a sentence end that is safe to cut at, or -1. A "." before a digit is a decimal, not an end. */
const sentenceEnd = (text: string, final: boolean): number => {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (!TERMINATOR.test(char)) continue;
    let end = index + 1;
    while (end < text.length && CLOSER.test(text[end] ?? '')) end += 1;
    if (end >= text.length) {
      if (final) return end;
      // Without more text we cannot tell "3." from "3.5"; wait for the next token.
      return -1;
    }
    const after = text[end] ?? '';
    if (/\s/.test(after)) return end;
  }
  return -1;
};

/** Last ", " in a buffer long enough to be worth splitting, or -1. */
const commaEnd = (text: string): number => {
  if (text.length < COMMA_CHUNK_CHARS) return -1;
  const index = text.lastIndexOf(', ');
  return index < 0 ? -1 : index + 1;
};

/** Pure sentence assembly from a token stream: push() returns the sentences completed so far, flush() the rest. */
export class SentenceBuffer {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): string[] {
    const out = this.drain(true);
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest !== '') out.push(rest);
    return out;
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      let cut = sentenceEnd(this.buffer, final);
      if (cut < 0) cut = commaEnd(this.buffer);
      if (cut < 0) break;
      const sentence = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (sentence !== '') out.push(sentence);
    }
    return out;
  }
}

/**
 * Turn token events into sentence events as well (tokens still pass through), so speech out can start on
 * the first sentence while the brain is still writing the second.
 */
export const sentenceChunker = (): BrainMiddleware =>
  async function* chunk(context, next) {
    const buffer = new SentenceBuffer();
    let ended = false;
    for await (const event of next(context)) {
      if (event.type === 'token') {
        yield event;
        for (const text of buffer.push(event.text)) yield { type: 'sentence', text };
        continue;
      }
      if (event.type === 'done' || event.type === 'error') {
        ended = true;
        for (const text of buffer.flush()) yield { type: 'sentence', text };
      }
      yield event;
    }
    if (!ended) for (const text of buffer.flush()) yield { type: 'sentence', text };
  };
