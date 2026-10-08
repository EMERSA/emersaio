import type { BeingHandle, TourScript, TourStop } from '../types.ts';
import type { PageAdapter } from './PageAdapter.ts';
import { DEFAULT_DWELL_MS, hasVoice, stopIndex, TOUR_STORAGE_KEY } from './TourScript.ts';

export type TourStatus = 'idle' | 'moving' | 'speaking' | 'waiting' | 'ended';

export interface TourState {
  status: TourStatus;
  index: number;
  total: number;
  stop?: TourStop;
  muted: boolean;
  /**
   * No clip can play (none baked, or the being could not play one): lines are read as captions only. A refusal
   * is tried again on the next control the visitor presses.
   */
  captionsOnly: boolean;
}

export interface TourController {
  /** Begin at a stop id (unknown ids start at the first stop). Resolves once the first line has been spoken. */
  start(fromId?: string): Promise<void>;
  next(): void;
  back(): void;
  replay(): void;
  stop(): void;
  setMuted(muted: boolean): void;
  readonly state: TourState;
}

export interface TourStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TourOptions {
  script: TourScript;
  being: BeingHandle;
  adapter: PageAdapter;
  storageKey?: string;
  onState?: (state: TourState) => void;
  /** While this reports true the tour waits at a stop instead of moving on by itself. */
  isInteracting?: () => boolean;
  /** Defaults to localStorage when the page has one. */
  storage?: TourStorage;
  muted?: boolean;
}

const INTERACTION_POLL_MS = 500;

const defaultStorage = (): TourStorage | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

/** The scripted tour: idle, moving, speaking, waiting, ended. Every transition reaches onState. */
export const createTour = (options: TourOptions): TourController => {
  const { script, being, adapter } = options;
  const storageKey = options.storageKey ?? TOUR_STORAGE_KEY;
  const storage = options.storage ?? defaultStorage();
  const total = script.stops.length;
  let state: TourState = {
    status: 'idle',
    index: 0,
    total,
    muted: options.muted ?? false,
    captionsOnly: !hasVoice(script),
  };
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let speech: AbortController | undefined;

  const emit = (patch: Partial<TourState>): void => {
    state = { ...state, ...patch };
    options.onState?.(state);
  };

  const remember = (stop: TourStop): void => {
    try {
      storage?.setItem(storageKey, JSON.stringify({ stopId: stop.id, at: Date.now() }));
    } catch {
      // Private mode or a full quota: the tour runs the same without a bookmark.
    }
  };

  const forget = (): void => {
    try {
      storage?.removeItem(storageKey);
    } catch {
      // See remember().
    }
  };

  /** Cancel whatever the previous run was doing and hand out the id the new run checks itself against. */
  const interrupt = (): number => {
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    speech?.abort();
    speech = undefined;
    being.stopSpeaking();
    return generation;
  };

  const end = (completed: boolean): void => {
    interrupt();
    if (completed) forget();
    adapter.highlight(null);
    adapter.caption('', true);
    emit({ status: 'ended' });
  };

  const advance = (): void => {
    if (state.index + 1 < total) void run(state.index + 1);
    else end(true);
  };

  const wait = (generationId: number, stop: TourStop): void => {
    emit({ status: 'waiting' });
    const tick = (): void => {
      if (generationId !== generation) return;
      if (options.isInteracting?.() === true) {
        timer = setTimeout(tick, INTERACTION_POLL_MS);
        return;
      }
      advance();
    };
    timer = setTimeout(tick, stop.dwellMs ?? DEFAULT_DWELL_MS);
  };

  const run = async (index: number): Promise<void> => {
    const generationId = interrupt();
    const stop = script.stops[index];
    if (stop === undefined) {
      end(true);
      return;
    }
    remember(stop);
    emit({ status: 'moving', index, stop });
    try {
      await adapter.scrollTo(stop.anchor);
    } catch {
      // A missing anchor is a content bug, not a reason to stay silent.
    }
    if (generationId !== generation) return;

    adapter.highlight(stop.highlight ?? null);
    for (const action of stop.actions ?? []) adapter.dispatch(action);
    emit({ status: 'speaking' });
    const abort = new AbortController();
    speech = abort;
    const useClip = stop.voice !== undefined && !state.muted && !state.captionsOnly;
    try {
      await being.speak({
        text: stop.text,
        clip: useClip ? stop.voice : undefined,
        onCaption: (shown, done) => {
          if (generationId === generation) adapter.caption(shown, done);
        },
        signal: abort.signal,
      });
    } catch {
      if (generationId !== generation) return;
      // The being could not play the line: show it whole and carry on without voice until the visitor presses a
      // control (see retryVoice).
      emit({ captionsOnly: true });
      adapter.caption(stop.text, true);
    }
    if (generationId !== generation) return;
    speech = undefined;
    wait(generationId, stop);
  };

  /**
   * The controls only ever fire from a tap or a key, and the shell primes the audio inside that gesture, so a
   * voice the browser refused earlier (no gesture had unlocked it yet) gets another go; refused again, the tour
   * says captions-only again. A script without voice stays captions-only.
   */
  const retryVoice = (): void => {
    if (state.captionsOnly && hasVoice(script)) emit({ captionsOnly: false });
  };

  return {
    start: (fromId) => {
      retryVoice();
      return run(stopIndex(script, fromId));
    },
    next: () => {
      retryVoice();
      if (state.status === 'idle' || state.status === 'ended') void run(0);
      else advance();
    },
    back: () => {
      retryVoice();
      void run(Math.max(0, state.index - 1));
    },
    replay: () => {
      retryVoice();
      void run(state.index);
    },
    stop: () => end(false),
    setMuted: (muted) => {
      if (muted === state.muted) return;
      if (!muted) retryVoice();
      emit({ muted });
      if (state.status === 'speaking') void run(state.index);
    },
    get state() {
      return state;
    },
  };
};
