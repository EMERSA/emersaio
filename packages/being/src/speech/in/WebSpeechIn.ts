import { ListenerSet, type SpeechIn } from '../SpeechIn.ts';

/*
 * The Web Speech recognition types are not in lib.dom, so the slice this module uses is declared here.
 * Nothing touches the globals at import time: the feature test runs when start() is called.
 */
interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface RecognitionErrorEvent {
  readonly error: string;
  readonly message?: string;
}

interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  /** Chrome 139+: keep audio on the device. Undefined where unsupported. */
  processLocally?: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionConstructor {
  new (): Recognition;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

const findRecognition = (): RecognitionConstructor | undefined => {
  const scope = globalThis as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
};

export const isWebSpeechSupported = (): boolean => findRecognition() !== undefined;

export interface WebSpeechInOptions {
  lang?: string;
  /** Keep listening after a pause (restarts the recogniser when the browser ends a session). */
  continuous?: boolean;
  /** Ask for on-device recognition when the browser has a language pack; off sends audio to the vendor. */
  preferLocal?: boolean;
  onError?: (message: string) => void;
}

const describeError = (code: string): string => {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access was refused';
    case 'audio-capture':
      return 'No microphone was found';
    case 'network':
      return 'Speech recognition needs a network connection';
    case 'language-not-supported':
      return 'Speech recognition does not support this language here';
    default:
      return `Speech recognition failed (${code})`;
  }
};

/**
 * The browser's own recogniser (Chrome, Edge, Safari in part; not Firefox). Interim results stream as
 * non-final transcripts, each finished phrase as a final one. The vendor may process the audio, so the
 * shell only offers this after the visitor opts in.
 */
export class WebSpeechIn implements SpeechIn {
  readonly name = 'web-speech';
  private readonly transcripts = new ListenerSet<[string, boolean]>();
  private readonly levels = new ListenerSet<[number]>();
  private readonly lang: string;
  private readonly continuous: boolean;
  private readonly preferLocal: boolean;
  private readonly onError: ((message: string) => void) | undefined;
  private recognition: Recognition | undefined;
  private listening = false;
  private localAvailable: boolean | undefined;

  constructor(options: WebSpeechInOptions = {}) {
    this.lang = options.lang ?? 'en-GB';
    this.continuous = options.continuous ?? false;
    this.preferLocal = options.preferLocal ?? true;
    this.onError = options.onError;
  }

  start(): Promise<void> {
    if (this.listening) return Promise.resolve();
    const RecognitionImpl = findRecognition();
    if (RecognitionImpl === undefined) {
      this.fail('Speech recognition is not available in this browser');
      return Promise.resolve();
    }
    const recognition = new RecognitionImpl();
    recognition.lang = this.lang;
    recognition.interimResults = true;
    recognition.continuous = this.continuous;
    recognition.maxAlternatives = 1;
    // Local processing is only requested once the browser has confirmed a language pack: asking for it
    // without one makes start() fail. The check runs in the background so the first start stays inside the tap.
    if (this.preferLocal && this.localAvailable === true && recognition.processLocally !== undefined) {
      recognition.processLocally = true;
    } else if (this.preferLocal && this.localAvailable === undefined) {
      this.probeLocal(RecognitionImpl);
    }

    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      this.fail(describeError(event.error));
    };
    recognition.onend = () => {
      if (this.listening && this.continuous && this.recognition === recognition) {
        try {
          recognition.start();
        } catch {
          this.listening = false;
        }
        return;
      }
      if (this.recognition === recognition) this.listening = false;
    };

    this.recognition = recognition;
    this.listening = true;
    try {
      recognition.start();
    } catch (error) {
      this.listening = false;
      this.recognition = undefined;
      this.fail(error instanceof Error ? error.message : 'Speech recognition could not start');
    }
    return Promise.resolve();
  }

  stop(): void {
    const recognition = this.recognition;
    this.listening = false;
    this.recognition = undefined;
    try {
      recognition?.stop();
    } catch {
      // Stopping a recogniser that already ended throws in some browsers; it is stopped either way.
    }
  }

  onTranscript(listener: (text: string, final: boolean) => void): () => void {
    return this.transcripts.add(listener);
  }

  /** The recogniser exposes no audio level; the listener never fires. */
  onLevel(listener: (level: number) => void): () => void {
    return this.levels.add(listener);
  }

  private handleResult(event: RecognitionResultEvent): void {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const alternative = result?.[0];
      if (result === undefined || alternative === undefined) continue;
      if (result.isFinal) {
        const text = alternative.transcript.trim();
        if (text !== '') this.transcripts.emit(text, true);
      } else {
        interim += alternative.transcript;
      }
    }
    const partial = interim.trim();
    if (partial !== '') this.transcripts.emit(partial, false);
  }

  private probeLocal(RecognitionImpl: RecognitionConstructor): void {
    this.localAvailable = false;
    const available = RecognitionImpl.available;
    if (available === undefined) return;
    available
      .call(RecognitionImpl, { langs: [this.lang], processLocally: true })
      .then((status) => {
        this.localAvailable = status === 'available';
      })
      .catch(() => {
        this.localAvailable = false;
      });
  }

  private fail(message: string): void {
    this.onError?.(message);
  }
}
