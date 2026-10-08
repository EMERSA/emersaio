import { AudioBands } from '../data/AudioBands.ts';
import { getAudioContext } from '../speech/audioUnlock.ts';
import type { Brain, BrainContext, BrainEvent } from '../types.ts';

/**
 * The structural slice of the SDK's ConvaiClient this module drives (see convai-sdk.d.ts). Tests hand in a fake;
 * the browser gets the real client from loadConvaiSdk(), which is the only place the SDK is imported.
 */
export interface ConvaiClientLike {
  readonly room: unknown;
  readonly audioControls: {
    readonly isAudioEnabled: boolean;
    enableAudio(): Promise<void>;
    muteAudio(): Promise<void>;
    unmuteAudio(): Promise<void>;
  };
  readonly blendshapeQueue: {
    isBotSpeaking(): boolean;
    getFrameAtTime(elapsedSeconds: number): { frame: Float32Array } | null;
  };
  on(event: string, callback: (...args: never[]) => void): () => void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendUserTextMessage(text: string): void;
  sendInterruptMessage(): void;
  updateContext(options: { text?: string; mode?: 'append' | 'replace' | 'reset'; run_llm?: 'true' | 'false' }): void;
}

export interface ConvaiClientConfig {
  authToken: string;
  characterId: string;
  endUserId: string;
  startWithAudioOn: boolean;
  enableLipsync: true;
  blendshapeConfig: { format: 'arkit' };
}

export interface ConvaiSdk {
  createClient(config: ConvaiClientConfig): ConvaiClientLike;
  /** Plays the character's audio (the SDK's vanilla AudioRenderer); destroy() removes its elements. */
  createAudioRenderer(room: unknown): { destroy(): void };
}

/** The one dynamic import of the SDK: /core and /vanilla only, never the root, which pulls React. */
export const loadConvaiSdk = async (): Promise<ConvaiSdk> => {
  const [core, vanilla] = await Promise.all([import('@convai/web-sdk/core'), import('@convai/web-sdk/vanilla')]);
  return {
    createClient: (config) => new core.ConvaiClient(config) as unknown as ConvaiClientLike,
    createAudioRenderer: (room) =>
      new vanilla.AudioRenderer(room as ConstructorParameters<typeof vanilla.AudioRenderer>[0]),
  };
};

/** The being as the talk path needs it; BeingHandle satisfies it. */
export interface TalkBeing {
  readonly face: { pushArkit(frame: ArrayLike<number>): void };
  setAudioLevel(level: number): void;
  setListening(on: boolean): void;
  tokens(n: number): void;
}

export type ConvaiState = 'connecting' | 'connected' | 'listening' | 'thinking' | 'speaking' | 'disconnected';
export type Speaker = 'user' | 'being';

export interface ConvaiBrainOptions {
  token: string;
  characterId: string;
  endUserId: string;
  being: TalkBeing;
  /** Captions: the visitor's words and Emily's, growing while they stream; final once the line is settled. */
  onTranscript?: (speaker: Speaker, text: string, final: boolean) => void;
  onState?: (state: ConvaiState, detail?: string) => void;
  /** Injectable for tests; the browser loads the SDK. */
  sdk?: ConvaiSdk | (() => Promise<ConvaiSdk>);
  /** Injectable frame clock for tests. */
  requestFrame?: (callback: (nowMs: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

const USER_TYPES = new Set(['user', 'user-transcription', 'user-llm-text']);
const BEING_TYPES = new Set(['convai', 'bot-output', 'bot-llm-text']);

interface MessageLike {
  id: string;
  type: string;
  content: string;
}

const isMessage = (value: unknown): value is MessageLike => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.type === 'string' && typeof record.content === 'string';
};

/** LiveKit's remote audio track, structurally: kind and the underlying MediaStreamTrack. */
interface TrackLike {
  kind?: string;
  mediaStreamTrack?: MediaStreamTrack;
}

interface RoomLike {
  on(event: string, callback: (track: TrackLike) => void): unknown;
  off(event: string, callback: (track: TrackLike) => void): unknown;
}

const isRoom = (value: unknown): value is RoomLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as RoomLike).on === 'function' &&
  typeof (value as RoomLike).off === 'function';

/** An async queue the respond() generator drains while SDK callbacks fill it. */
class EventQueue {
  private readonly items: BrainEvent[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(event: BrainEvent): void {
    if (this.closed) return;
    this.items.push(event);
    if (event.type === 'done' || event.type === 'error') this.closed = true;
    this.wake?.();
  }

  async *drain(): AsyncGenerator<BrainEvent> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        if (next.type === 'done') return;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = undefined;
    }
  }
}

/**
 * Convai is both the brain and the voice: the SDK owns the microphone, LiveKit carries audio both ways, and the
 * character's 61-value ARKit frames (60 fps, ARKIT_ORDER_61) drive the face through being.face.pushArkit. The
 * remote audio track feeds an AudioBands meter whose level goes to being.setAudioLevel.
 */
export class ConvaiBrain implements Brain {
  readonly name = 'convai';
  private readonly options: ConvaiBrainOptions;
  private client: ConvaiClientLike | null = null;
  private renderer: { destroy(): void } | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly bands = new AudioBands();
  private analyserSource: MediaStreamAudioSourceNode | null = null;
  private frameHandle: number | null = null;
  private lastFrameAt = 0;
  private speakingSince: number | null = null;
  private listening = false;
  private ended = false;
  private readonly seen = new Map<string, { speaker: Speaker; text: string; final: boolean }>();
  private turn: EventQueue | null = null;
  private turnText = '';

  constructor(options: ConvaiBrainOptions) {
    this.options = options;
  }

  /** Load the SDK, connect with the minted token and start the face and level loop. Rejects with the SDK's error. */
  async connect(): Promise<void> {
    const { sdk } = this.options;
    const loaded = sdk === undefined ? await loadConvaiSdk() : typeof sdk === 'function' ? await sdk() : sdk;
    if (this.ended) return;
    const client = loaded.createClient({
      authToken: this.options.token,
      characterId: this.options.characterId,
      endUserId: this.options.endUserId,
      startWithAudioOn: false,
      enableLipsync: true,
      blendshapeConfig: { format: 'arkit' },
    });
    this.client = client;
    this.subscribe(client);
    this.options.onState?.('connecting');
    await client.connect();
    if (this.ended) {
      await client.disconnect();
      return;
    }
    this.renderer = loaded.createAudioRenderer(client.room);
    this.watchRoomAudio(client.room);
    this.startLoop();
    this.options.onState?.('connected');
  }

  /** Open the microphone (the SDK asks for it). Rejects when the visitor refuses; typed input still works. */
  async startListening(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    if (client.audioControls.isAudioEnabled) await client.audioControls.unmuteAudio();
    else await client.audioControls.enableAudio();
    this.setListening(true);
  }

  async stopListening(): Promise<void> {
    this.setListening(false);
    await this.client?.audioControls.muteAudio();
  }

  /** A typed line, answered by voice like a spoken one. */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '' || this.client === null) return;
    this.client.sendUserTextMessage(trimmed);
  }

  /** Silent background for the next replies (an uploaded document); never triggers a reply on its own. */
  addContext(text: string): void {
    if (text.trim() === '') return;
    this.client?.updateContext({ text, mode: 'append', run_llm: 'false' });
  }

  interrupt(): void {
    this.client?.sendInterruptMessage();
  }

  /** Brain interface: send the text and stream Emily's words until she finishes the turn. */
  respond(context: BrainContext): AsyncIterable<BrainEvent> {
    this.turn?.push({ type: 'done', reason: 'aborted' });
    const queue = new EventQueue();
    this.turn = queue;
    this.turnText = '';
    if (this.client === null) {
      queue.push({ type: 'error', message: 'Not connected.' });
    } else {
      context.signal?.addEventListener(
        'abort',
        () => {
          this.interrupt();
          queue.push({ type: 'done', reason: 'aborted' });
        },
        { once: true },
      );
      this.sendText(context.text);
    }
    return queue.drain();
  }

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.turn?.push({ type: 'done', reason: 'aborted' });
    this.turn = null;
    this.stopLoop();
    this.setListening(false);
    this.options.being.setAudioLevel(0);
    for (const off of this.unsubscribe.splice(0)) off();
    this.analyserSource?.disconnect();
    this.analyserSource = null;
    this.bands.attach(null);
    this.renderer?.destroy();
    this.renderer = null;
    const client = this.client;
    this.client = null;
    if (client !== null) await client.disconnect().catch(() => undefined);
  }

  dispose(): void {
    void this.end();
  }

  private setListening(on: boolean): void {
    if (this.listening === on) return;
    this.listening = on;
    this.options.being.setListening(on);
  }

  private subscribe(client: ConvaiClientLike): void {
    const on = (event: string, callback: (...args: never[]) => void): void => {
      this.unsubscribe.push(client.on(event, callback));
    };
    on('messagesChange', ((messages: unknown) => this.onMessages(messages)) as (...args: never[]) => void);
    on('userTranscriptionChange', ((text: unknown) => {
      if (typeof text === 'string' && text !== '') this.options.onTranscript?.('user', text, false);
    }) as (...args: never[]) => void);
    on('speakingChange', ((speaking: unknown) => this.onSpeaking(speaking === true)) as (...args: never[]) => void);
    on('stateChange', ((state: unknown) => this.onClientState(state)) as (...args: never[]) => void);
    on('disconnect', ((reason: unknown) => {
      this.setListening(false);
      this.turn?.push({ type: 'done', reason: 'aborted' });
      this.options.onState?.('disconnected', reason === undefined || reason === null ? undefined : String(reason));
    }) as (...args: never[]) => void);
    on('error', ((error: unknown) => {
      this.turn?.push({ type: 'error', message: error instanceof Error ? error.message : 'Voice error.' });
    }) as (...args: never[]) => void);
  }

  private onClientState(state: unknown): void {
    if (typeof state !== 'object' || state === null) return;
    const agent = (state as { agentState?: unknown }).agentState;
    if (agent === 'listening' || agent === 'thinking' || agent === 'speaking') this.options.onState?.(agent);
  }

  private onSpeaking(speaking: boolean): void {
    // A new line restarts the face clock at its first frame (pumpFace); the end of one settles the captions.
    this.speakingSince = null;
    if (speaking) return;
    this.finalizeAll();
    this.turn?.push({ type: 'done', reason: 'complete' });
    this.turn = null;
  }

  /**
   * The SDK keeps one growing message per line and rewrites it as words arrive; a line is settled once a newer
   * message follows it, or when the character stops speaking.
   */
  private onMessages(messages: unknown): void {
    if (!Array.isArray(messages)) return;
    const lines = messages.filter(isMessage).filter((m) => USER_TYPES.has(m.type) || BEING_TYPES.has(m.type));
    lines.forEach((message, index) => {
      const speaker: Speaker = USER_TYPES.has(message.type) ? 'user' : 'being';
      const last = index === lines.length - 1;
      const known = this.seen.get(message.id);
      if (known?.final) return;
      const grew = known === undefined || known.text !== message.content;
      if (grew) {
        if (speaker === 'being') this.streamBeing(known?.text ?? '', message.content);
        this.options.onTranscript?.(speaker, message.content, !last);
      } else if (!last) {
        this.options.onTranscript?.(speaker, message.content, true);
      }
      this.seen.set(message.id, { speaker, text: message.content, final: !last });
    });
  }

  private streamBeing(before: string, after: string): void {
    const added = after.startsWith(before) ? after.slice(before.length) : after;
    if (added === '') return;
    this.options.being.tokens(added.length);
    if (this.turn !== null) {
      this.turnText += added;
      this.turn.push({ type: 'token', text: added });
    }
  }

  private finalizeAll(): void {
    for (const [id, line] of this.seen) {
      if (line.final) continue;
      this.seen.set(id, { ...line, final: true });
      this.options.onTranscript?.(line.speaker, line.text, true);
    }
  }

  private watchRoomAudio(room: unknown): void {
    const onTrack = (track: TrackLike): void => {
      if (track.kind === 'audio' && track.mediaStreamTrack !== undefined) this.meter(track.mediaStreamTrack);
    };
    if (isRoom(room)) {
      room.on('trackSubscribed', onTrack);
      this.unsubscribe.push(() => room.off('trackSubscribed', onTrack));
    }
    const client = this.client;
    if (client !== null) {
      this.unsubscribe.push(
        client.on('botAudioTrack', ((track: unknown) => {
          if (typeof MediaStreamTrack !== 'undefined' && track instanceof MediaStreamTrack) this.meter(track);
        }) as (...args: never[]) => void),
      );
    }
  }

  /** Tap the character's audio for the level; the SDK's renderer plays it, this only listens. */
  private meter(track: MediaStreamTrack): void {
    const context = getAudioContext();
    if (context === undefined || typeof MediaStream === 'undefined') return;
    this.analyserSource?.disconnect();
    const source = context.createMediaStreamSource(new MediaStream([track]));
    const analyser = context.createAnalyser();
    source.connect(analyser);
    this.analyserSource = source;
    this.bands.attach(analyser);
  }

  private startLoop(): void {
    const request = this.options.requestFrame ?? ((cb: (now: number) => void) => requestAnimationFrame(cb));
    const tick = (now: number): void => {
      if (this.ended) return;
      const dt = this.lastFrameAt === 0 ? 1 / 60 : Math.min(0.1, (now - this.lastFrameAt) / 1000);
      this.lastFrameAt = now;
      this.pumpFace(now);
      this.bands.update(dt);
      this.options.being.setAudioLevel(this.bands.level());
      this.frameHandle = request(tick);
    };
    this.frameHandle = request(tick);
  }

  private stopLoop(): void {
    if (this.frameHandle === null) return;
    const cancel = this.options.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
    cancel(this.frameHandle);
    this.frameHandle = null;
  }

  /** While the character speaks, play the queue on our own clock: frame index = elapsed time x playback fps. */
  private pumpFace(now: number): void {
    const queue = this.client?.blendshapeQueue;
    if (queue === undefined || !queue.isBotSpeaking()) return;
    if (this.speakingSince === null) this.speakingSince = now;
    const sample = queue.getFrameAtTime((now - this.speakingSince) / 1000);
    if (sample !== null) this.options.being.face.pushArkit(sample.frame);
  }
}
