/**
 * The action markers the NIM brain may write inside its reply, e.g. "[[goto:contact]]". Only the whitelisted
 * shapes become "action" events (the runtime's TourAction); anything else between the brackets is dropped, and a
 * marker never reaches the visitor as text. MarkerParser copes with a marker split across stream chunks.
 */
export type Action =
  | { type: 'goto'; target: string }
  | { type: 'highlight'; target: string }
  | { type: 'point'; side: 'left' | 'right' }
  | { type: 'emote'; name: 'smile' | 'nod' | 'think' | 'neutral' }
  | { type: 'open'; what: 'talk' };

const TARGET = /^[a-z][a-z0-9-]{0,31}$/;
const EMOTES = new Set(['smile', 'nod', 'think', 'neutral']);

export const MARKER_HELP =
  'You may add at most one marker per reply, written exactly as [[goto:<section-id>]], [[highlight:<section-id>]], [[point:left]], [[point:right]], [[emote:smile|nod|think|neutral]] or [[open:talk]].';

export function parseMarker(body: string): Action | null {
  const [kind = '', arg = ''] = body.trim().split(':', 2);
  switch (kind) {
    case 'goto':
    case 'highlight':
      return TARGET.test(arg) ? { type: kind, target: arg } : null;
    case 'point':
      return arg === 'left' || arg === 'right' ? { type: 'point', side: arg } : null;
    case 'emote':
      return EMOTES.has(arg) ? { type: 'emote', name: arg as 'smile' } : null;
    case 'open':
      return arg === 'talk' ? { type: 'open', what: 'talk' } : null;
    default:
      return null;
  }
}

const MAX_MARKER = 64;

export class MarkerParser {
  private held = '';

  /** Text safe to show now, and the actions completed by this chunk. */
  push(chunk: string): { text: string; actions: Action[] } {
    let input = this.held + chunk;
    this.held = '';
    let text = '';
    const actions: Action[] = [];
    for (;;) {
      const open = input.indexOf('[[');
      if (open < 0) {
        // A lone trailing "[" may be the start of a marker.
        if (input.endsWith('[')) {
          this.held = '[';
          input = input.slice(0, -1);
        }
        text += input;
        break;
      }
      text += input.slice(0, open);
      const close = input.indexOf(']]', open + 2);
      if (close < 0) {
        const rest = input.slice(open);
        if (rest.length > MAX_MARKER) text += rest;
        else this.held = rest;
        break;
      }
      const action = parseMarker(input.slice(open + 2, close));
      if (action) actions.push(action);
      input = input.slice(close + 2);
    }
    return { text, actions };
  }

  /** Whatever was held back at the end of the stream, as text. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}
