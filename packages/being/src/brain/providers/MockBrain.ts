import type { Brain, BrainContext, BrainEvent, TourAction, TourScript, TourStop } from '../../types.ts';

export interface FaqEntry {
  patterns: RegExp;
  answer: string;
  /** Optional page action to send before the answer, such as a goto. */
  action?: TourAction;
}

export interface MockBrainOptions {
  /** Tour stops double as answers: a question close to a stop's text gets that line and a goto to its section. */
  script?: TourScript;
  /** Keyword answers built from site copy; the first matching entry wins. */
  faq: FaqEntry[];
  /** What to say when nothing matches. The shell passes its own copy; this default keeps the brain usable alone. */
  fallback?: string;
  /** Pause between streamed words; 0 in tests. */
  delayMs?: number;
}

const DEFAULT_FALLBACK = 'I can tell you about Emersa, Emily Wilson and Krupiq. What would you like to know?';
const DEFAULT_DELAY_MS = 40;

/** Sections a question can send the page to, by the words people use for them. */
const SECTION_HINTS: readonly { target: string; pattern: RegExp }[] = [
  { target: 'products', pattern: /\b(products?|emily|krupiq|hologram|assistant|decoy)\b/i },
  { target: 'story', pattern: /\b(story|history|began|begin|started|founded|studio|npcs?)\b/i },
  { target: 'contact', pattern: /\b(contact|demo|email|reach|book|get in touch|sales)\b/i },
  { target: 'docs', pattern: /\b(docs?|documentation|manual|guides?)\b/i },
];

export const sectionFor = (text: string): string | undefined =>
  SECTION_HINTS.find((hint) => hint.pattern.test(text))?.target;

const STOP_WORDS = new Set(
  'the a an and or of to in is are it that this what who how do does you your i me my we us our be can tell about with for on at as by from'.split(
    ' ',
  ),
);

const contentWords = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter((word) => !STOP_WORDS.has(word)));

/** The stop whose line shares the most content words with the question, when the overlap is real. */
export const bestStop = (script: TourScript, question: string): TourStop | undefined => {
  const asked = contentWords(question);
  if (asked.size === 0) return undefined;
  let best: TourStop | undefined;
  let bestScore = 0;
  for (const stop of script.stops) {
    let score = asked.has(stop.id) ? 3 : 0;
    for (const word of contentWords(stop.text)) if (asked.has(word)) score += 1;
    if (score > bestScore) {
      best = stop;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : undefined;
};

/** Words with their trailing space, so joining the tokens gives the text back exactly. */
export const tokensOf = (text: string): string[] => text.match(/\S+\s*/g) ?? [];

const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** The offline brain: tour lines and a keyword FAQ, streamed word by word so the whole pipeline runs without a model. */
export class MockBrain implements Brain {
  readonly name = 'mock';
  private readonly script: TourScript | undefined;
  private readonly faq: readonly FaqEntry[];
  private readonly fallback: string;
  private readonly delayMs: number;

  constructor(options: MockBrainOptions) {
    this.script = options.script;
    this.faq = options.faq;
    this.fallback = options.fallback ?? DEFAULT_FALLBACK;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  }

  async *respond(context: BrainContext): AsyncIterable<BrainEvent> {
    const question = context.text.trim();
    const { answer, action } = this.answerFor(question);
    if (action !== undefined) yield { type: 'action', action };
    for (const token of tokensOf(answer)) {
      if (context.signal?.aborted === true) {
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      yield { type: 'token', text: token };
      if (this.delayMs > 0) await sleep(this.delayMs, context.signal);
    }
    yield { type: 'done', reason: context.signal?.aborted === true ? 'aborted' : 'complete' };
  }

  private answerFor(question: string): { answer: string; action: TourAction | undefined } {
    const entry = this.faq.find((candidate) => {
      candidate.patterns.lastIndex = 0;
      return candidate.patterns.test(question);
    });
    if (entry !== undefined) {
      return { answer: entry.answer, action: entry.action ?? this.gotoFor(question) };
    }
    const stop = this.script === undefined ? undefined : bestStop(this.script, question);
    if (stop !== undefined) {
      return { answer: stop.text, action: { type: 'goto', target: stop.anchor.replace(/^#/, '') } };
    }
    return { answer: this.fallback, action: this.gotoFor(question) };
  }

  private gotoFor(question: string): TourAction | undefined {
    const target = sectionFor(question);
    return target === undefined ? undefined : { type: 'goto', target };
  }
}
