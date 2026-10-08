/**
 * @emersa/being/speech: speech in (typed, browser recognition, push to talk) and speech out (clips, browser
 * voice, captions only) behind the two interfaces in types.ts, plus the one-tap audio unlock.
 */
import type { BeingHandle } from '../types.ts';
import { BrowserTts, type BrowserTtsOptions } from './out/BrowserTts.ts';
import { ClipPlayer, type ClipPlayerOptions } from './out/ClipPlayer.ts';
import { Silent } from './out/Silent.ts';
import type { SpeechOut, SpeechOutKind } from './SpeechOut.ts';

export { getAudioContext, isAudioUnlocked, resetAudioContext, unlock } from './audioUnlock.ts';
export {
  DEFAULT_MIME_TYPES,
  PttRecorderIn,
  type PttRecorderOptions,
  pickMimeType,
  transcriptOf,
} from './in/PttRecorderIn.ts';
export { TypedIn, type TypedInOptions } from './in/TypedIn.ts';
export { isWebSpeechSupported, WebSpeechIn, type WebSpeechInOptions } from './in/WebSpeechIn.ts';
export { BrowserTts, type BrowserTtsOptions, PREFERRED_VOICES, pickVoice, type VoiceLike } from './out/BrowserTts.ts';
export { ClipPlayer, type ClipPlayerOptions } from './out/ClipPlayer.ts';
export { Silent } from './out/Silent.ts';
export { ListenerSet, type SpeechIn, type SpeechInKind } from './SpeechIn.ts';
export { captionsOnly, type SpeakRequest, type SpeechOut, type SpeechOutKind } from './SpeechOut.ts';

export interface SpeechOutOptions {
  clip?: ClipPlayerOptions;
  browser?: BrowserTtsOptions;
}

/** One place that turns a provider name into a provider, so the shell holds a kind, not a class. */
export const createSpeechOut = (kind: SpeechOutKind, being: BeingHandle, options: SpeechOutOptions = {}): SpeechOut => {
  switch (kind) {
    case 'clip':
      return new ClipPlayer(being, options.clip);
    case 'browser':
      return new BrowserTts(being, options.browser);
    default:
      return new Silent(being);
  }
};
