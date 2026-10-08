/**
 * Phase 2 fact distillation: a small rule-based extractor over the visitor's own words (names, company, interest).
 * No model is called. Run every DISTILL_EVERY turns by POST /api/memory/turns.
 */
export const DISTILL_EVERY = 6;

export interface Fact {
  key: 'name' | 'company' | 'interest';
  value: string;
  confidence: number;
}

/** The phrases match with their first letter in either case; the name itself must be capitalised. */
const WORD = "[A-Z][\\p{L}'-]{1,30}";
const NAME = new RegExp(
  `\\b(?:[Mm]y name is|[Ii] am called|[Cc]all me|[Ii]'m|[Ii] am)\\s+(${WORD}(?:\\s+${WORD})?)`,
  'u',
);
const COMPANY = new RegExp(
  `\\b(?:[Ii] work (?:at|for)|[Ii]'m (?:at|with)|[Ii] am (?:at|with)|[Oo]ur company is|[Ww]e are)\\s+(${WORD}(?:\\s+${WORD}){0,3})`,
  'u',
);
const INTEREST = /\b(?:interested in|curious about|looking for|want to (?:know|learn) about)\s+([^.!?\n]{3,80})/i;

/** Words that follow "I'm" without being a name. */
const NOT_NAMES = new Set(['Just', 'Not', 'Here', 'Looking', 'Interested', 'Curious', 'Fine', 'Good', 'Sorry', 'From']);

const clean = (value: string): string => value.trim().replace(/\s+/g, ' ').slice(0, 80);

/** Facts found in the visitor's turns, the latest mention of each key winning. */
export function distill(userTexts: readonly string[]): Fact[] {
  const found = new Map<Fact['key'], Fact>();
  for (const text of userTexts) {
    const name = NAME.exec(text)?.[1];
    if (name && !NOT_NAMES.has(name.split(' ')[0] ?? '')) {
      found.set('name', { key: 'name', value: clean(name), confidence: 0.7 });
    }
    const company = COMPANY.exec(text)?.[1];
    if (company) found.set('company', { key: 'company', value: clean(company), confidence: 0.6 });
    const interest = INTEREST.exec(text)?.[1];
    if (interest) found.set('interest', { key: 'interest', value: clean(interest), confidence: 0.5 });
  }
  return [...found.values()];
}
