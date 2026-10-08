import { getAudioContext } from '../audioUnlock.ts';
import { ListenerSet, type SpeechIn } from '../SpeechIn.ts';

export interface PttRecorderOptions {
  /** Where the recording goes; answers { text } or 503 until the ASR route ships. */
  endpoint?: string;
  maxMs?: number;
  maxBytes?: number;
  onError?: (message: string) => void;
  /** Injectable for tests and for a shell that adds headers. */
  fetch?: typeof fetch;
}

/** Opus in WebM where the browser has it (Chrome, Firefox, Edge), AAC in MP4 on Safari. */
export const DEFAULT_MIME_TYPES: readonly string[] = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

/** First container the recorder supports, or '' to let the browser choose. */
export const pickMimeType = (
  isSupported: (type: string) => boolean,
  candidates: readonly string[] = DEFAULT_MIME_TYPES,
): string => candidates.find((type) => isSupported(type)) ?? '';

/** Shape of a successful transcription answer from the endpoint. */
export const transcriptOf = (payload: unknown): string => {
  if (typeof payload !== 'object' || payload === null) return '';
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text.trim() : '';
};

const LEVEL_INTERVAL_MS = 50;

/**
 * Push to talk: start() inside the press opens the microphone and records, stop() on release uploads the
 * clip for transcription. Capped at 15 seconds and 1 MB so a held button can never post more than the
 * Worker accepts. The level listener drives the listening ring while the button is down.
 */
export class PttRecorderIn implements SpeechIn {
  readonly name = 'ptt';
  private readonly transcripts = new ListenerSet<[string, boolean]>();
  private readonly levels = new ListenerSet<[number]>();
  private readonly endpoint: string;
  private readonly maxMs: number;
  private readonly maxBytes: number;
  private readonly onError: ((message: string) => void) | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private recorder: MediaRecorder | undefined;
  private stream: MediaStream | undefined;
  private chunks: Blob[] = [];
  private bytes = 0;
  private wantRecording = false;
  private discard = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setInterval> | undefined;
  private levelSource: MediaStreamAudioSourceNode | undefined;

  constructor(options: PttRecorderOptions = {}) {
    this.endpoint = options.endpoint ?? '/api/asr';
    this.maxMs = options.maxMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.onError = options.onError;
    this.fetchImpl = options.fetch;
  }

  start(): Promise<void> {
    if (this.wantRecording) return Promise.resolve();
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (devices?.getUserMedia === undefined || typeof MediaRecorder === 'undefined') {
      this.fail('Recording is not available in this browser');
      return Promise.resolve();
    }
    this.wantRecording = true;
    this.discard = false;
    // getUserMedia is the first call so the permission prompt is tied to the press itself.
    return devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(
      (stream) => this.begin(stream),
      (error: unknown) => {
        this.wantRecording = false;
        const refused = error instanceof Error && error.name === 'NotAllowedError';
        this.fail(refused ? 'Microphone access was refused' : 'The microphone could not be opened');
      },
    );
  }

  stop(): void {
    this.wantRecording = false;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const recorder = this.recorder;
    if (recorder !== undefined && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    this.release();
  }

  /** Stop without uploading, for a press that turned out to be a mistake. */
  cancel(): void {
    this.discard = true;
    this.stop();
  }

  onTranscript(listener: (text: string, final: boolean) => void): () => void {
    return this.transcripts.add(listener);
  }

  onLevel(listener: (level: number) => void): () => void {
    return this.levels.add(listener);
  }

  private begin(stream: MediaStream): void {
    if (!this.wantRecording) {
      for (const track of stream.getTracks()) track.stop();
      return;
    }
    this.stream = stream;
    const mimeType = pickMimeType((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType === '' ? undefined : { mimeType, audioBitsPerSecond: 32_000 });
    this.recorder = recorder;
    this.chunks = [];
    this.bytes = 0;
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.chunks.push(event.data);
      this.bytes += event.data.size;
      if (this.bytes > this.maxBytes) this.stop();
    };
    recorder.onstop = () => {
      void this.finish(recorder.mimeType || mimeType);
    };
    recorder.onerror = () => {
      this.discard = true;
      this.fail('Recording failed');
      this.stop();
    };
    recorder.start(250);
    this.timer = setTimeout(() => this.stop(), this.maxMs);
    this.meter(stream);
  }

  private async finish(mimeType: string): Promise<void> {
    const blob = new Blob(this.chunks, { type: mimeType || 'application/octet-stream' });
    this.release();
    if (this.discard || blob.size === 0) return;
    if (blob.size > this.maxBytes) {
      this.fail('That recording was too long to send');
      return;
    }
    const fetchImpl = this.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (fetchImpl === undefined) {
      this.fail('Transcription could not be reached');
      return;
    }
    try {
      const response = await fetchImpl(this.endpoint, {
        method: 'POST',
        body: blob,
        headers: { 'content-type': blob.type },
      });
      if (response.status === 503) {
        this.fail('Transcription is not available yet');
        return;
      }
      if (!response.ok) {
        this.fail(`Transcription failed (${response.status})`);
        return;
      }
      const text = transcriptOf(await response.json());
      if (text === '') this.fail('Nothing was heard');
      else this.transcripts.emit(text, true);
    } catch {
      this.fail('Transcription could not be reached');
    }
  }

  /** RMS through the shared context, when the page has unlocked audio; otherwise no level, still a recording. */
  private meter(stream: MediaStream): void {
    const context = getAudioContext();
    if (context === undefined || this.levels.size === 0) return;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.levelSource = source;
      const samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.levelTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const value = samples[index] ?? 0;
          sum += value * value;
        }
        this.levels.emit(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      }, LEVEL_INTERVAL_MS);
    } catch {
      // No meter is not an error: the transcript still arrives.
    }
  }

  private release(): void {
    if (this.levelTimer !== undefined) clearInterval(this.levelTimer);
    this.levelTimer = undefined;
    this.levelSource?.disconnect();
    this.levelSource = undefined;
    if (this.stream !== undefined) for (const track of this.stream.getTracks()) track.stop();
    this.stream = undefined;
    this.recorder = undefined;
    this.chunks = [];
    this.bytes = 0;
    this.levels.emit(0);
  }

  private fail(message: string): void {
    this.onError?.(message);
  }
}
