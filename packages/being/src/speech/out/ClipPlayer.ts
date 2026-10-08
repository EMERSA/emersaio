import type { BeingHandle } from '../../types.ts';
import type { SpeakRequest, SpeechOut } from '../SpeechOut.ts';

export interface ClipPlayerOptions {
  /** The analyser the being exposes on its clip output, when it has one; it drives the data ring. */
  analyser?: AnalyserNode;
}

/**
 * Pre-rendered clips. The being owns the audio element, the viseme timeline and the caption timing, so this
 * provider only delegates: it exists so the shell treats clips, browser TTS and silence alike.
 */
export class ClipPlayer implements SpeechOut {
  readonly name = 'clip';
  readonly analyser: AnalyserNode | undefined;
  private readonly being: BeingHandle;

  constructor(being: BeingHandle, options: ClipPlayerOptions = {}) {
    this.being = being;
    this.analyser = options.analyser;
  }

  speak(request: SpeakRequest): Promise<void> {
    return this.being.speak(request);
  }

  stop(): void {
    this.being.stopSpeaking();
  }
}
