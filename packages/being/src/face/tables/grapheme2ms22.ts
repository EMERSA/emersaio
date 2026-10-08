/**
 * English letters and digraphs onto Microsoft viseme ids. This is the fallback mouth for text with no audio
 * (BrowserTts, captions-only), so it favours being plausible over being phonetically right: a reader sees
 * the rhythm of open vowels and closed lips, not individual phonemes.
 */
export const grapheme2ms22: Readonly<Record<string, number>> = {
  // Trigraphs and digraphs first; the tokenizer takes the longest key that matches.
  igh: 11,
  tch: 16,
  sch: 16,
  ai: 4,
  ay: 4,
  au: 3,
  aw: 9,
  ar: 2,
  ck: 20,
  ch: 16,
  dg: 16,
  ea: 6,
  ee: 6,
  ei: 4,
  er: 5,
  ew: 7,
  ey: 4,
  gh: 20,
  ie: 11,
  ir: 5,
  kn: 19,
  ng: 20,
  oa: 8,
  oi: 10,
  oo: 7,
  or: 3,
  ou: 9,
  ow: 9,
  oy: 10,
  ph: 18,
  qu: 20,
  sh: 16,
  th: 17,
  ue: 7,
  ur: 5,
  wh: 7,
  wr: 13,
  zh: 16,
  // Single letters.
  a: 1,
  b: 21,
  c: 20,
  d: 19,
  e: 4,
  f: 18,
  g: 20,
  h: 12,
  i: 6,
  j: 16,
  k: 20,
  l: 14,
  m: 21,
  n: 19,
  o: 8,
  p: 21,
  q: 20,
  r: 13,
  s: 15,
  t: 19,
  u: 7,
  v: 18,
  w: 7,
  x: 20,
  y: 6,
  z: 15,
};

const LONGEST_KEY = 3;

/** Ids that read as vowels; they get more time in a text timeline than consonants do. */
export const VOWEL_VISEMES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

export const isVowelViseme = (viseme: number): boolean => VOWEL_VISEMES.has(viseme);

/**
 * Split one lower-case word into the graphemes the table knows, longest match first. Characters the table
 * does not know (digits, apostrophes, accents) are dropped so they never produce a mouth shape.
 */
export const splitGraphemes = (word: string): string[] => {
  const out: string[] = [];
  const text = word.toLowerCase();
  let index = 0;
  while (index < text.length) {
    let matched = '';
    for (let length = Math.min(LONGEST_KEY, text.length - index); length > 0; length -= 1) {
      const candidate = text.slice(index, index + length);
      if (Object.hasOwn(grapheme2ms22, candidate)) {
        matched = candidate;
        break;
      }
    }
    if (matched === '') {
      index += 1;
      continue;
    }
    out.push(matched);
    index += matched.length;
  }
  return out;
};

export const graphemeToMs22 = (grapheme: string): number => grapheme2ms22[grapheme.toLowerCase()] ?? 0;
