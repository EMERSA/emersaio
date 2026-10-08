import type { BeingHandle } from '../../types.ts';
import { captionsOnly, type SpeakRequest, type SpeechOut } from '../SpeechOut.ts';

/**
 * No voice at all: the being times the captions and the text mouth. Used under reduced-motion, when audio
 * cannot be unlocked, and whenever a visitor mutes.
 */
export class Silent implements SpeechOut {
  readonly name = 'silent';
  private readonly being: BeingHandle;

  constructor(being: BeingHandle) {
    this.being = being;
  }

  speak(request: SpeakRequest): Promise<void> {
    return this.being.speak(captionsOnly(request));
  }

  stop(): void {
    this.being.stopSpeaking();
  }
}
