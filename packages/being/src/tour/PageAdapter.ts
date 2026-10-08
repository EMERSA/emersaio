import type { TourAction } from '../types.ts';

/**
 * What the tour needs from the page. The site implements it in being-mount.ts (scroll, highlight class,
 * caption element, pose and navigation); tests and headless hosts use the no-op one.
 */
export interface PageAdapter {
  /** Scroll the anchor into view; resolves when the page has settled enough to speak. */
  scrollTo(selector: string): Promise<void>;
  /** Mark an element as the one being talked about; null clears it. */
  highlight(selector: string | null): void;
  /** Mirror the spoken words; done is true on the last call of a line. */
  caption(text: string, done: boolean): void;
  /** Hand a whitelisted action to the page and the being. */
  dispatch(action: TourAction): void;
}

export const createNoopAdapter = (): PageAdapter => ({
  scrollTo: () => Promise.resolve(),
  highlight: () => undefined,
  caption: () => undefined,
  dispatch: () => undefined,
});
