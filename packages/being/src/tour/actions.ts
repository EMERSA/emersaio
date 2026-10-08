import type { TourAction } from '../types.ts';

/** More than this in one reply is a model running the page, not helping a visitor. */
export const MAX_ACTIONS = 4;

/** A highlight target: an id, class or attribute selector with nothing that could reach outside the page. */
export const SELECTOR_PATTERN = /^[#.[][\w\-[\]=".:]+$/;

/** A goto target names a section id; the adapter turns it into the anchor. */
export const SECTION_PATTERN = /^[a-z][a-z0-9-]{0,39}$/i;

const EMOTES = new Set(['smile', 'nod', 'think', 'neutral']);

/* Markers look like ⟦goto:products⟧; the ASCII form [[goto:products]] is accepted for models without the glyphs. */
const MARKER = /⟦\s*([a-z]+)\s*:\s*([^⟧]*?)\s*⟧|\[\[\s*([a-z]+)\s*:\s*([^\]]*?)\s*\]\]/giu;
const STRAY_BRACKETS = /[⟦⟧]/gu;

type Emote = 'smile' | 'nod' | 'think' | 'neutral';
const isEmote = (value: string): value is Emote => EMOTES.has(value);

/** One marker to an action, or undefined when the kind or value is not on the whitelist. */
export const parseAction = (kind: string, value: string): TourAction | undefined => {
  const trimmed = value.trim();
  switch (kind.toLowerCase()) {
    case 'goto': {
      const target = trimmed.replace(/^#/, '').toLowerCase();
      return SECTION_PATTERN.test(target) ? { type: 'goto', target } : undefined;
    }
    case 'highlight':
      return SELECTOR_PATTERN.test(trimmed) ? { type: 'highlight', target: trimmed } : undefined;
    case 'point':
      return trimmed === 'left' || trimmed === 'right' ? { type: 'point', side: trimmed } : undefined;
    case 'emote':
      return isEmote(trimmed) ? { type: 'emote', name: trimmed } : undefined;
    case 'open':
      return trimmed === 'talk' ? { type: 'open', what: 'talk' } : undefined;
    default:
      return undefined;
  }
};

export interface ParsedActions {
  /** The text with every marker removed, valid or not. */
  clean: string;
  /** Whitelisted actions in reading order, at most MAX_ACTIONS. */
  actions: TourAction[];
}

/** Pull page actions out of model text. Unknown or malformed markers are dropped, never spoken. */
export const parseActions = (text: string): ParsedActions => {
  const actions: TourAction[] = [];
  const stripped = text.replace(
    MARKER,
    (_match: string, kindA?: string, valueA?: string, kindB?: string, valueB?: string): string => {
      const action = parseAction(kindA ?? kindB ?? '', valueA ?? valueB ?? '');
      if (action !== undefined && actions.length < MAX_ACTIONS) actions.push(action);
      return '';
    },
  );
  const clean = stripped
    .replace(STRAY_BRACKETS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .trim();
  return { clean, actions };
};
