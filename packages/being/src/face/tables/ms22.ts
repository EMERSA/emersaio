/**
 * The canonical 22 Microsoft/Azure viseme ids (the set Azure Speech emits and the GLB's visemes01 morphs follow).
 * Every lip-sync source speaks this id space; the other tables translate into it. jawOpen is how far the jaw
 * drops for each mouth shape, so timelines can drive the jaw channel without a second data set.
 */
export interface Ms22Viseme {
  readonly id: number;
  /** Short mnemonic, stable across the runtime and the asset tooling. */
  readonly name: string;
  readonly description: string;
  /** Jaw openness 0..1 at full weight. */
  readonly jawOpen: number;
}

export const ms22: readonly Ms22Viseme[] = [
  { id: 0, name: 'sil', description: 'Silence, mouth closed and relaxed', jawOpen: 0 },
  { id: 1, name: 'ae', description: 'Open front vowel as in cat, about, cup', jawOpen: 0.6 },
  { id: 2, name: 'aa', description: 'Open back vowel as in father', jawOpen: 0.8 },
  { id: 3, name: 'ao', description: 'Rounded open vowel as in dog, law', jawOpen: 0.7 },
  { id: 4, name: 'eh', description: 'Mid vowel as in bed, book', jawOpen: 0.45 },
  { id: 5, name: 'er', description: 'R-coloured vowel as in bird', jawOpen: 0.4 },
  { id: 6, name: 'iy', description: 'Spread vowel and y as in see, sit, yes', jawOpen: 0.25 },
  { id: 7, name: 'uw', description: 'Rounded close vowel and w as in too, we', jawOpen: 0.2 },
  { id: 8, name: 'ow', description: 'Rounded mid vowel as in go', jawOpen: 0.5 },
  { id: 9, name: 'aw', description: 'Diphthong as in how', jawOpen: 0.65 },
  { id: 10, name: 'oy', description: 'Diphthong as in toy', jawOpen: 0.55 },
  { id: 11, name: 'ay', description: 'Diphthong as in my', jawOpen: 0.7 },
  { id: 12, name: 'hh', description: 'Open breath as in hat', jawOpen: 0.3 },
  { id: 13, name: 'r', description: 'Rounded consonant as in red', jawOpen: 0.25 },
  { id: 14, name: 'l', description: 'Tongue tip up as in let', jawOpen: 0.3 },
  { id: 15, name: 's', description: 'Narrow sibilant as in see, zoo', jawOpen: 0.1 },
  { id: 16, name: 'sh', description: 'Rounded sibilant as in she, chin, joy', jawOpen: 0.15 },
  { id: 17, name: 'th', description: 'Tongue between teeth as in the', jawOpen: 0.2 },
  { id: 18, name: 'f', description: 'Lip under teeth as in fat, van', jawOpen: 0.1 },
  { id: 19, name: 'd', description: 'Tongue tip stop as in do, to, no, thin', jawOpen: 0.2 },
  { id: 20, name: 'k', description: 'Back stop as in cat, go, sing', jawOpen: 0.3 },
  { id: 21, name: 'p', description: 'Closed lips as in pat, bat, mat', jawOpen: 0 },
];

export const MS22_COUNT = ms22.length;

/** Jaw openness for a viseme id; unknown ids read as closed. */
export const jawOpenOf = (viseme: number): number => ms22[viseme]?.jawOpen ?? 0;

/** Clamp any number into the id range so a bad cue can never index outside the frame. */
export const clampViseme = (viseme: number): number =>
  Number.isFinite(viseme) ? Math.min(MS22_COUNT - 1, Math.max(0, Math.trunc(viseme))) : 0;
