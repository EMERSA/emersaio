/**
 * Text -> viseme sequence by grapheme rules (the same idea as the runtime's TextVisemes source).
 * Used twice: to align the spoken audio with the words, and on its own when no audio can be baked.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TABLE = JSON.parse(readFileSync(fileURLToPath(new URL('../tables/graphemes.json', import.meta.url)), 'utf8'));
const DIGRAPHS = Object.entries(TABLE.digraphs).sort((a, b) => b[0].length - a[0].length);
const VOWELS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

/** Numbers are read as words by the synthesiser; approximate the same so the syllable count lines up. */
const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const smallNumber = (value) => {
  if (value < 20) return ONES[value];
  const tens = TENS[Math.floor(value / 10)];
  return value % 10 ? `${tens} ${ONES[value % 10]}` : tens;
};

const expandNumbers = (text) =>
  text.replace(/\d+/g, (digits) => {
    const value = Number(digits);
    if (digits.length === 4 && value >= 2000 && value < 2100) {
      // Years such as 2023 are read "twenty twenty-three"; 2000 to 2009 as "two thousand (and) nine".
      const rest = value - 2000;
      return rest < 10 ? `two thousand ${rest ? smallNumber(rest) : ''}`.trim() : `twenty ${smallNumber(rest)}`;
    }
    if (value < 100) return smallNumber(value);
    return [...digits].map((d) => ONES[Number(d)]).join(' ');
  });

/**
 * @typedef {{ viseme: number, weight: number, vowel: boolean }} Unit
 */

/**
 * @param {string} text
 * @returns {Unit[]} graphemic units with relative durations
 */
export const textToUnits = (text) => {
  const units = [];
  const clean = expandNumbers(text.toLowerCase());
  const tokens = clean.split(/(\s+|[.,;:!?]+)/).filter((token) => token.length > 0);
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      units.push({ viseme: TABLE.wordGap[0], weight: TABLE.wordGap[1], vowel: false });
      continue;
    }
    if (/^[.,;:!?]+$/.test(token)) {
      units.push({ viseme: TABLE.pauseGap[0], weight: TABLE.pauseGap[1], vowel: false });
      continue;
    }
    const word = token.replace(/[^a-z']/g, '');
    let i = 0;
    while (i < word.length) {
      const digraph = DIGRAPHS.find(([key]) => word.startsWith(key, i));
      if (digraph) {
        units.push({ viseme: digraph[1][0], weight: digraph[1][1], vowel: VOWELS.has(digraph[1][0]) });
        i += digraph[0].length;
        continue;
      }
      const letter = TABLE.letters[word[i]];
      if (letter) units.push({ viseme: letter[0], weight: letter[1], vowel: VOWELS.has(letter[0]) });
      i++;
    }
  }
  // Collapse doubled consonants and repeated gaps: "ll", "tt" and a comma followed by a space.
  return units.filter((unit, index) => index === 0 || unit.vowel || unit.viseme !== units[index - 1].viseme);
};

/**
 * A timeline from text alone, at a fixed cadence: used when no audio exists (captions-only tour).
 * @param {string} text
 * @param {number} [unitMs] average milliseconds per unit of weight 1
 * @returns {{ durationMs: number, visemes: [number, number, number][] }}
 */
export const textOnlyTimeline = (text, unitMs = 70) => {
  const units = textToUnits(text);
  const visemes = [];
  let at = 0;
  for (const unit of units) {
    const ms = Math.round(unit.weight * unitMs);
    const weight = unit.viseme === 0 ? 0 : unit.vowel ? 0.85 : 0.6;
    visemes.push([Math.round(at), unit.viseme, weight]);
    at += ms;
  }
  visemes.push([Math.round(at), 0, 0]);
  return { durationMs: Math.round(at), visemes };
};
