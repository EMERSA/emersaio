/**
 * The tour's view of the monitor: binds the bar's buttons to a TourController and mirrors TourState into the DOM
 * (the panel and the tour view shown, the label "TOUR n / N", progress, button states, the mute toggle, focus) so
 * being-mount.ts never touches these elements directly. Labels are rendered by Hero.astro from site.ts; this module
 * only toggles them.
 */
import { primeAudio } from '@emersa/being/audio';
import type { TourController, TourState } from '@emersa/being/tour';

/** Why the tour runs without voice: the 3D guide is off ('still') or it failed or was too slow ('connection'). */
export type VoiceAbsence = 'still' | 'connection';

export interface TourUiOptions {
  /** The [data-tour] bar; it carries tabindex="-1" so it can take focus when the tour starts. */
  bar: HTMLElement;
  /** The monitor panel and its tour view, shown while the tour runs. */
  panel: HTMLElement | null;
  view: HTMLElement | null;
  /** The monitor's head label ("TOUR 2 / 8"). */
  label: HTMLElement | null;
  /** The word before the count, from site.ts. */
  labelText: string;
  /** The captions-only notice, shown while the tour runs without voice. */
  notice: HTMLElement | null;
  /** Every [data-tour-start] control; the first one gets focus back when the tour ends. */
  startButtons: HTMLElement[];
  /** The page has no being (reduced motion, no WebGL2 or a failed load), whatever the tour reports. */
  captionsOnly: boolean;
  /** The reason, when known; it picks the notice's sentence from the data-label-* attributes on the notice. */
  voiceAbsence?: VoiceAbsence | null;
}

export interface TourUi {
  bind(controller: TourController): void;
  update(state: TourState): void;
}

export function createTourUi(options: TourUiOptions): TourUi {
  const { bar, panel, view, label, notice, startButtons } = options;
  const back = control(bar, 'data-tour-back');
  const next = control(bar, 'data-tour-next');
  const replay = control(bar, 'data-tour-replay');
  const mute = control(bar, 'data-tour-mute');
  const end = control(bar, 'data-tour-end');
  const progress = bar.querySelector<HTMLElement>('[data-tour-progress]');
  let controller: TourController | null = null;
  let shown = false;
  let muted = false;

  // Every control that can start a clip primes the page's audio first, synchronously inside the gesture: iOS plays
  // a clip only through a context and an element that a gesture has touched (primeAudio in the runtime's
  // audioUnlock.ts). A page without voice has nothing to prime.
  const prime = (): void => {
    if (!options.captionsOnly) primeAudio();
  };
  back?.addEventListener('click', () => {
    prime();
    controller?.back();
  });
  next?.addEventListener('click', () => {
    prime();
    controller?.next();
  });
  // Replay stays enabled throughout (disabling the focused button would drop the focus to the page); a press while
  // the page is still scrolling to the stop is simply ignored.
  replay?.addEventListener('click', () => {
    if (!controller || controller.state.status === 'moving') return;
    prime();
    controller.replay();
  });
  end?.addEventListener('click', () => controller?.stop());
  mute?.addEventListener('click', () => {
    prime();
    controller?.setMuted(!muted);
  });

  const show = (): void => {
    if (shown) return;
    shown = true;
    if (panel) panel.hidden = false;
    if (view) view.hidden = false;
    bar.hidden = false;
    document.documentElement.classList.add('is-touring');
    // The conversation, if one is open, ends: the monitor carries one thing at a time (scripts/talk.ts listens).
    document.dispatchEvent(new CustomEvent('em:tour-start'));
    // being-mount.ts may have shown the bar as a loading state with every button disabled.
    for (const button of [mute, end]) if (button) button.disabled = false;
    bar.focus({ preventScroll: true });
  };

  const hide = (returnFocus: boolean): void => {
    if (!shown) return;
    shown = false;
    const hadFocus = bar.contains(document.activeElement) || document.activeElement === document.body;
    bar.hidden = true;
    if (view) view.hidden = true;
    // The panel stays if the conversation has it; otherwise it goes with the tour.
    if (panel && !document.documentElement.classList.contains('is-talking')) panel.hidden = true;
    document.documentElement.classList.remove('is-touring');
    if (returnFocus && hadFocus) startButtons[0]?.focus({ preventScroll: true });
  };

  return {
    bind(next) {
      controller = next;
    },
    update(state) {
      muted = state.muted;
      const running = state.status !== 'idle' && state.status !== 'ended';
      if (running) show();
      else hide(state.status === 'ended');

      const count = state.total > 0 ? `${Math.min(state.index + 1, state.total)} / ${state.total}` : '';
      if (progress && progress.textContent !== count) progress.textContent = count;
      if (running && label) {
        const text = count ? `${options.labelText} ${count}` : options.labelText;
        if (label.textContent !== text) label.textContent = text;
      }
      if (back) {
        const first = state.index <= 0;
        // A control that is disabled while focused drops the focus to <body>, where Space would advance the tour
        // and a screen reader loses its place; the focus moves to Next first.
        if (first && document.activeElement === back) next?.focus({ preventScroll: true });
        back.disabled = first;
      }
      if (next) next.disabled = !running;
      if (replay) replay.disabled = !state.stop;
      // A toggle button keeps its label; only the pressed state changes (ARIA button pattern).
      if (mute) mute.setAttribute('aria-pressed', String(muted));
      if (notice) {
        const visible = running && (state.captionsOnly || options.captionsOnly);
        if (visible) {
          const text = options.voiceAbsence === 'still' ? notice.dataset.labelStill : notice.dataset.labelConnection;
          if (text && notice.textContent !== text) notice.textContent = text;
        }
        notice.hidden = !visible;
      }
    },
  };
}

function control(bar: HTMLElement, attribute: string): HTMLButtonElement | null {
  const element = bar.querySelector(`[${attribute}]`);
  return element instanceof HTMLButtonElement ? element : null;
}
