import type { SpeechIn } from '../types.ts';

export type { SpeechIn };

export type SpeechInKind = 'typed' | 'web-speech' | 'ptt';

/**
 * A listener set where add() returns the unsubscribe, the shape every SpeechIn exposes for transcripts and
 * levels. Listeners are copied before emit so one can unsubscribe itself mid-loop.
 */
export class ListenerSet<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  add(listener: (...args: Args) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: Args): void {
    for (const listener of [...this.listeners]) listener(...args);
  }

  clear(): void {
    this.listeners.clear();
  }

  get size(): number {
    return this.listeners.size;
  }
}
