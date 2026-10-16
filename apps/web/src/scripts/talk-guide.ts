/**
 * The guide line of the conversation (site.talk.howTo, [data-talk-guide]): it shows once per page, when the chat
 * view first opens, stays ten seconds, then fades out over 600 ms and is hidden, so only the prompt and the
 * conversation remain. Under reduced motion it is simply hidden at ten seconds. Plain numbers and no DOM, so
 * node --test checks the timings (apps/web/test/talk-guide.test.ts); talk.ts schedules them and hud.css fades.
 */

/** How long the line stays before it starts to go. */
export const GUIDE_VISIBLE_MS = 10_000;
/** The fade; the transition on .talk-guide in hud.css has the same length (the test compares them). */
export const GUIDE_FADE_MS = 600;

export type GuideState = 'shown' | 'fading' | 'hidden';

export interface GuidePlan {
  /** When the fade starts, counted from the chat opening; null under reduced motion, where the line just goes. */
  fadeAt: number | null;
  /** When the line is hidden for good. */
  hideAt: number;
}

export function guidePlan(reducedMotion: boolean): GuidePlan {
  return reducedMotion
    ? { fadeAt: null, hideAt: GUIDE_VISIBLE_MS }
    : { fadeAt: GUIDE_VISIBLE_MS, hideAt: GUIDE_VISIBLE_MS + GUIDE_FADE_MS };
}

/** What the line is doing this long after the chat opened. */
export function guideState(elapsedMs: number, reducedMotion: boolean): GuideState {
  const plan = guidePlan(reducedMotion);
  if (elapsedMs >= plan.hideAt) return 'hidden';
  if (plan.fadeAt !== null && elapsedMs >= plan.fadeAt) return 'fading';
  return 'shown';
}
