import type { BrainMiddleware, Fact } from '../../types.ts';

export const MEMORY_MAX_CHARS = 600;

export interface MemoryRecallOptions {
  /** Facts are kept, most confident first, while their formatted text fits in this many characters. */
  maxChars?: number;
  /** Where to fetch facts when the context carries none (MemoryClient.get); failures mean no memory, not no answer. */
  recall?: () => Promise<readonly Fact[]>;
}

/** The line a provider sees: "name: Martin; theme: dark". */
export const formatFacts = (facts: readonly Fact[]): string =>
  facts.map((fact) => `${fact.key}: ${fact.value}`).join('; ');

/** Most confident facts first, as many as fit the character budget. */
export const selectFacts = (facts: readonly Fact[], maxChars = MEMORY_MAX_CHARS): Fact[] => {
  const sorted = [...facts].sort((a, b) => b.confidence - a.confidence);
  const kept: Fact[] = [];
  for (const fact of sorted) {
    if (formatFacts([...kept, fact]).length > maxChars) break;
    kept.push(fact);
  }
  return kept;
};

/** Put what the being remembers into the context, capped so memory never crowds out the question. */
export const memoryRecall = (options: MemoryRecallOptions = {}): BrainMiddleware =>
  async function* recall(context, next) {
    let facts: readonly Fact[] = context.facts;
    if (facts.length === 0 && options.recall !== undefined) {
      try {
        facts = await options.recall();
      } catch {
        facts = [];
      }
    }
    yield* next({ ...context, facts: selectFacts(facts, options.maxChars) });
  };
