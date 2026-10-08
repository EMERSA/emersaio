import { MAX_ACTIONS, parseActions } from '../../tour/actions.ts';
import type { BrainMiddleware, TourAction } from '../../types.ts';

export const REPLY_MAX_CHARS = 1200;
export const ALLOWED_HOSTS: readonly string[] = ['emersa.io', 'krupiq.com'];
/** A marker longer than this is not a marker; the held text is released as words. */
const MARKER_MAX_CHARS = 96;

export interface GuardrailsOptions {
  maxChars?: number;
  allowedHosts?: readonly string[];
  maxActions?: number;
}

const URL_PATTERN = /https?:\/\/[^\s⟦⟧[\]()<>"']+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/u;
const MARKERS_AND_STRAYS = /⟦[^⟧]*⟧|\[\[[^\]]*\]\]|[⟦⟧]|\[\[|\]\]/gu;

export const hostAllowed = (url: string, hosts: readonly string[] = ALLOWED_HOSTS): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
};

/** Remove every link that does not point at our own sites; a model must not send visitors elsewhere. */
export const dropUrls = (text: string, hosts: readonly string[] = ALLOWED_HOSTS): string =>
  text.replace(URL_PATTERN, (match) => {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    const url = match.slice(0, match.length - tail.length);
    return hostAllowed(url, hosts) ? match : tail;
  });

/** Index of an opener that has no closer after it, or -1. */
const openMarkerAt = (text: string): number => {
  const openAt = Math.max(text.lastIndexOf('⟦'), text.lastIndexOf('[['));
  const closeAt = Math.max(text.lastIndexOf('⟧'), text.lastIndexOf(']]'));
  return openAt > closeAt ? openAt : -1;
};

/** Where a trailing word that might still become a URL starts, or -1. */
const partialUrlStart = (text: string): number => {
  const start = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n')) + 1;
  const tail = text.slice(start).toLowerCase();
  if (tail === '') return -1;
  return tail.startsWith('http') || 'https://'.startsWith(tail) ? start : -1;
};

export interface GuardedChunk {
  text: string;
  actions: TourAction[];
  /** The reply reached its length cap; nothing more should be emitted. */
  limit: boolean;
}

/**
 * Streaming scanner behind the middleware. Text is released only once it can no longer be part of a marker
 * or a URL, so a marker split across tokens is still caught whole.
 */
export class TextGuard {
  private readonly maxChars: number;
  private readonly hosts: readonly string[];
  private readonly maxActions: number;
  private pending = '';
  private emitted = 0;
  private lastChar = ' ';
  private actionCount = 0;

  constructor(options: GuardrailsOptions = {}) {
    this.maxChars = options.maxChars ?? REPLY_MAX_CHARS;
    this.hosts = options.allowedHosts ?? ALLOWED_HOSTS;
    this.maxActions = options.maxActions ?? MAX_ACTIONS;
  }

  /** Count an action the provider emitted itself; false when the reply already has its share. */
  allowAction(): boolean {
    if (this.actionCount >= this.maxActions) return false;
    this.actionCount += 1;
    return true;
  }

  push(text: string): GuardedChunk {
    this.pending += text;
    const actions = parseActions(this.pending).actions.filter(() => this.allowAction());
    let held = openMarkerAt(this.pending);
    if (held >= 0 && this.pending.length - held > MARKER_MAX_CHARS) held = -1;
    const safe = held >= 0 ? this.pending.slice(0, held) : this.pending;
    const urlStart = partialUrlStart(safe);
    const release = urlStart >= 0 ? safe.slice(0, urlStart) : safe;
    this.pending = this.pending.slice(release.length);
    return this.budget(this.clean(release), actions);
  }

  flush(): GuardedChunk {
    const opener = openMarkerAt(this.pending);
    const rest = opener >= 0 ? this.pending.slice(0, opener) : this.pending;
    this.pending = '';
    return this.budget(this.clean(rest), []);
  }

  /** Strip markers and foreign links, then mend the spacing a removal leaves, across chunk boundaries too. */
  private clean(text: string): string {
    let out = dropUrls(text.replace(MARKERS_AND_STRAYS, ''), this.hosts).replace(/ {2,}/g, ' ');
    if (out.startsWith(' ') && this.lastChar === ' ') out = out.slice(1);
    if (out !== '') this.lastChar = out.slice(-1);
    return out;
  }

  private budget(text: string, actions: TourAction[]): GuardedChunk {
    const remaining = this.maxChars - this.emitted;
    const limit = text.length >= remaining;
    const out = limit ? text.slice(0, Math.max(0, remaining)) : text;
    this.emitted += out.length;
    return { text: out, actions, limit };
  }
}

/** Whitelisted actions only, no foreign links, and a hard cap on how much a reply may say. */
export const guardrails = (options: GuardrailsOptions = {}): BrainMiddleware =>
  async function* guard(context, next) {
    const scanner = new TextGuard(options);
    let ended = false;
    for await (const event of next(context)) {
      if (event.type === 'token') {
        const chunk = scanner.push(event.text);
        for (const action of chunk.actions) yield { type: 'action', action };
        if (chunk.text !== '') yield { type: 'token', text: chunk.text };
        if (chunk.limit) {
          ended = true;
          yield { type: 'done', reason: 'limit' };
          break;
        }
        continue;
      }
      if (event.type === 'sentence') {
        const text = dropUrls(parseActions(event.text).clean, options.allowedHosts).replace(/ {2,}/g, ' ').trim();
        if (text !== '') yield { type: 'sentence', text };
        continue;
      }
      if (event.type === 'action') {
        if (scanner.allowAction()) yield event;
        continue;
      }
      if (event.type === 'done' || event.type === 'error') {
        const rest = scanner.flush();
        if (rest.text !== '') yield { type: 'token', text: rest.text };
        ended = true;
      }
      yield event;
    }
    if (!ended) {
      const rest = scanner.flush();
      if (rest.text !== '') yield { type: 'token', text: rest.text };
    }
  };
