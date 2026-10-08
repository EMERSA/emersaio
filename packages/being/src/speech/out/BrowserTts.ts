import { estimateDurationMs } from '../../face/sources/TextVisemes.ts';
import type { BeingHandle } from '../../types.ts';
import { captionsOnly, type SpeakRequest, type SpeechOut } from '../SpeechOut.ts';

/** The slice of SpeechSynthesisVoice the picker reads; plain objects work in tests. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly default?: boolean;
}

/** Natural British voices first, by the names browsers give them, then whatever en-GB exists. */
export const PREFERRED_VOICES: readonly string[] = [
  'Sonia',
  'Libby',
  'Google UK English Female',
  'Kate',
  'Serena',
  'Martha',
  'Hazel',
  'Susan',
];

const sameLang = (a: string, b: string): boolean => a.toLowerCase().replace('_', '-') === b.toLowerCase();

/** Best voice for the language: a preferred name in that language, else any voice in it, else any English one. */
export const pickVoice = <V extends VoiceLike>(
  voices: readonly V[],
  lang = 'en-GB',
  preferred: readonly string[] = PREFERRED_VOICES,
): V | undefined => {
  const inLang = voices.filter((voice) => sameLang(voice.lang, lang));
  for (const name of preferred) {
    const match = inLang.find((voice) => voice.name.toLowerCase().includes(name.toLowerCase()));
    if (match !== undefined) return match;
  }
  if (inLang.length > 0) return inLang[0];
  const base = lang.split('-')[0]?.toLowerCase() ?? '';
  return voices.find((voice) => voice.lang.toLowerCase().startsWith(base)) ?? voices.find((voice) => voice.default);
};

export interface BrowserTtsOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
}

const findSynthesis = (): SpeechSynthesis | undefined =>
  (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;

/**
 * The browser's own voice. speechSynthesis cannot feed Web Audio, so there is no analyser and no viseme
 * timeline: the being runs its text mouth and captions in parallel at the typewriter rate, which matches
 * a default-rate utterance closely enough. Falls back to captions only where synthesis is missing.
 */
export class BrowserTts implements SpeechOut {
  readonly name = 'browser';
  private readonly being: BeingHandle;
  private readonly lang: string;
  private readonly rate: number;
  private readonly pitch: number;
  private voice: SpeechSynthesisVoice | undefined;
  private current: (() => void) | undefined;
  private readonly onVoicesChanged = (): void => {
    this.chooseVoice();
  };

  constructor(being: BeingHandle, options: BrowserTtsOptions = {}) {
    this.being = being;
    this.lang = options.lang ?? 'en-GB';
    this.rate = options.rate ?? 1;
    this.pitch = options.pitch ?? 1;
    const synthesis = findSynthesis();
    if (synthesis !== undefined) {
      this.chooseVoice();
      // Chromium delivers the voice list asynchronously; keep choosing until one for the language arrives.
      synthesis.addEventListener('voiceschanged', this.onVoicesChanged);
    }
  }

  speak(request: SpeakRequest): Promise<void> {
    const synthesis = findSynthesis();
    const captions = this.being.speak(captionsOnly(request));
    if (synthesis === undefined) return captions;

    this.stopUtterance();
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.lang = this.lang;
    utterance.rate = this.rate;
    utterance.pitch = this.pitch;
    if (this.voice !== undefined) utterance.voice = this.voice;

    const spoken = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (this.current === finish) this.current = undefined;
        resolve();
      };
      // Some engines never fire end for a cancelled or cut-off utterance; the guard keeps the tour moving.
      const guard = setTimeout(finish, estimateDurationMs(request.text) * 2 + 2000);
      utterance.onend = finish;
      utterance.onerror = finish;
      this.current = finish;
      request.signal?.addEventListener(
        'abort',
        () => {
          synthesis.cancel();
          finish();
        },
        { once: true },
      );
    });

    // speak() runs before any await so the call still counts as part of the visitor's gesture. Cancelling an
    // empty queue in the same tick can swallow the new utterance in Chromium, so only a busy queue is cleared.
    if (synthesis.speaking || synthesis.pending) synthesis.cancel();
    synthesis.speak(utterance);
    return Promise.all([captions, spoken]).then(() => undefined);
  }

  stop(): void {
    this.stopUtterance();
    this.being.stopSpeaking();
  }

  dispose(): void {
    this.stop();
    findSynthesis()?.removeEventListener('voiceschanged', this.onVoicesChanged);
  }

  private stopUtterance(): void {
    findSynthesis()?.cancel();
    this.current?.();
  }

  private chooseVoice(): void {
    const voices = findSynthesis()?.getVoices() ?? [];
    const picked = pickVoice(voices, this.lang);
    if (picked !== undefined) this.voice = picked;
  }
}
