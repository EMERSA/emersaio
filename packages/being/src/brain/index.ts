/**
 * @emersa/being/brain: providers behind one Brain interface, the middleware that shapes context and events,
 * and compose() to chain them: MockBrain, and NimBrain (the Worker's /api/brain stream). ConvaiBrain lives in
 * @emersa/being/talk so the Convai SDK never reaches this chunk.
 */
import { compose } from './compose.ts';
import { type GuardrailsOptions, guardrails } from './middleware/guardrails.ts';
import { type MemoryRecallOptions, memoryRecall } from './middleware/memoryRecall.ts';
import { type PageContextOptions, pageContext } from './middleware/pageContext.ts';
import { sentenceChunker } from './middleware/sentenceChunker.ts';
import { type TokenUnit, tokenMeter } from './middleware/tokenMeter.ts';

export { MemoryClient, type MemoryClientOptions, type MemorySnapshot, parseSnapshot } from '../memory/MemoryClient.ts';
export {
  type Brain,
  type BrainContext,
  type BrainEvent,
  type BrainMiddleware,
  type BrainNext,
  collect,
  contextOf,
  createBrain,
  type Reply,
} from './Brain.ts';
export { compose } from './compose.ts';
export {
  ALLOWED_HOSTS,
  dropUrls,
  type GuardedChunk,
  type GuardrailsOptions,
  guardrails,
  hostAllowed,
  REPLY_MAX_CHARS,
  TextGuard,
} from './middleware/guardrails.ts';
export {
  formatFacts,
  MEMORY_MAX_CHARS,
  type MemoryRecallOptions,
  memoryRecall,
  selectFacts,
} from './middleware/memoryRecall.ts';
export { PAGE_EXCERPT_MAX_CHARS, type PageContextOptions, pageContext } from './middleware/pageContext.ts';
export { COMMA_CHUNK_CHARS, SentenceBuffer, sentenceChunker } from './middleware/sentenceChunker.ts';
export { countUnits, type TokenUnit, tokenMeter } from './middleware/tokenMeter.ts';
export {
  bestStop,
  type FaqEntry,
  MockBrain,
  type MockBrainOptions,
  sectionFor,
  tokensOf,
} from './providers/MockBrain.ts';
export {
  NimBrain,
  type NimBrainOptions,
  readSse,
  type SseMessage,
  SseParser,
  speakSentences,
  toBrainEvent,
} from './providers/NimBrain.ts';

export interface StandardChainOptions {
  memory?: MemoryRecallOptions;
  page?: PageContextOptions;
  guardrails?: GuardrailsOptions;
  /** Receives token counts for the sparkle (being.tokens). */
  onToken?: (n: number) => void;
  tokenUnit?: TokenUnit;
}

/**
 * The chain from the plan, in the order that makes it correct: memory and page shape the context on the way
 * in; on the way out events pass guardrails first (nearest the brain), then the sentence chunker, then the
 * meter, so no marker ever reaches speech and only clean tokens count.
 */
export const standardChain = (
  options: StandardChainOptions = {},
): ((brain: import('../types.ts').Brain) => import('../types.ts').Brain) =>
  compose([
    memoryRecall(options.memory),
    pageContext(options.page),
    tokenMeter(options.onToken ?? (() => undefined), options.tokenUnit),
    sentenceChunker(),
    guardrails(options.guardrails),
  ]);
