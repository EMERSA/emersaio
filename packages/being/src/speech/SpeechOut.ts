import type { SpeakRequest, SpeechOut } from '../types.ts';

export type { SpeakRequest, SpeechOut };

/** Which speech provider the shell asked for; createSpeechOut() in speech/index.ts turns it into an instance. */
export type SpeechOutKind = 'clip' | 'browser' | 'silent';

/** A request without its clip: the captions-only shape every provider can fall back to. */
export const captionsOnly = (request: SpeakRequest): SpeakRequest => ({
  text: request.text,
  onCaption: request.onCaption,
  signal: request.signal,
});
