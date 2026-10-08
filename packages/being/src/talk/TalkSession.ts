import { MemoryClient } from '../memory/MemoryClient.ts';
import type { SpeechIn } from '../types.ts';
import { ConvaiBrain, type ConvaiBrainOptions, type ConvaiState, type Speaker, type TalkBeing } from './ConvaiBrain.ts';

/** The session cap from the plan; the Worker may send a lower one. */
export const MAX_SESSION_MINUTES = 20;
/** How much of an uploaded document Emily is given as context. */
export const DOCUMENT_CONTEXT_CHARS = 6000;
/** Reconnects with a fresh token before the session gives up. */
export const MAX_RECONNECTS = 2;

export type TalkState =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'busy'
  | 'limited'
  | 'unavailable'
  | 'error'
  | 'ended';

export type TalkEndReason = 'visitor' | 'cap' | 'busy' | 'error' | 'disconnected';

/** Why the shell should show a notice; the copy lives in site.ts. */
export type TalkNotice = 'busy' | 'cap' | 'mic-denied' | 'reconnecting' | 'expired';

export interface TalkSessionGrant {
  token: string;
  expiresAt: string;
  characterId: string;
  endUserId: string;
  turnsLeft: number;
  maxMinutes: number;
}

/** The voice the session drives; ConvaiBrain in the browser, a fake in tests. */
export interface TalkVoice {
  connect(): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  sendText(text: string): void;
  addContext(text: string): void;
  end(): Promise<void>;
}

export interface TalkVoiceInit extends Omit<ConvaiBrainOptions, 'sdk' | 'requestFrame' | 'cancelFrame'> {}

export interface TalkSessionOptions {
  being: TalkBeing;
  /** Turnstile and consent for the first request. */
  turnstile: string;
  consentVersion: number;
  /** A fresh Turnstile token for a reconnect (tokens are single use); without it the session ends instead. */
  refreshTurnstile?: () => Promise<string>;
  sessionEndpoint?: string;
  revokeEndpoint?: string;
  memoryEndpoint?: string;
  onState?: (state: TalkState, detail?: string) => void;
  onTranscript?: (speaker: Speaker, text: string, final: boolean) => void;
  onNotice?: (notice: TalkNotice) => void;
  /** Start with the microphone open (false keeps the session text-only until startListening()). */
  listen?: boolean;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  createVoice?: (init: TalkVoiceInit) => TalkVoice;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Validate the Worker's answer; anything off-shape is treated as unavailable rather than trusted. */
export const parseGrant = (payload: unknown): TalkSessionGrant | undefined => {
  if (!isRecord(payload) || payload.ok !== true) return undefined;
  const { token, expiresAt, characterId, endUserId, session } = payload;
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof characterId !== 'string' || characterId === '') return undefined;
  if (typeof endUserId !== 'string' || endUserId === '') return undefined;
  const turnsLeft = isRecord(session) && typeof session.turnsLeft === 'number' ? session.turnsLeft : 0;
  const maxMinutes = isRecord(session) && typeof session.maxMinutes === 'number' ? session.maxMinutes : 0;
  return {
    token,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
    characterId,
    endUserId,
    turnsLeft,
    maxMinutes: maxMinutes > 0 ? Math.min(maxMinutes, MAX_SESSION_MINUTES) : MAX_SESSION_MINUTES,
  };
};

/**
 * Assumption (Convai does not document a code for it): a character at its concurrency limit (three sessions on
 * the plan's tier) fails /connect with 429 or a message naming the limit.
 */
export const isBusyError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|concurren|too many|limit|capacity|busy/i.test(message);
};

const isMicDenied = (error: unknown): boolean =>
  error instanceof Error && /NotAllowed|Permission|denied|NotFound/i.test(`${error.name} ${error.message}`);

/**
 * One conversation with Emily: token from the Worker, connect, the 20-minute cap, the busy notice, reconnect with a
 * fresh token, revoke on end, and every settled line mirrored to /api/memory/turns.
 */
export class TalkSession {
  private readonly options: TalkSessionOptions;
  private readonly memory: MemoryClient;
  private voice: TalkVoice | null = null;
  private stateValue: TalkState = 'idle';
  private grantValue: TalkSessionGrant | undefined;
  private capTimer: unknown;
  private reconnects = 0;
  private listening = false;
  private readonly detachTyped: (() => void)[] = [];
  private pendingContext: string[] = [];

  constructor(options: TalkSessionOptions) {
    this.options = options;
    this.memory = new MemoryClient({
      endpoint: options.memoryEndpoint ?? '/api/memory',
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  /** Create and start a session in one call, the shape the shell's tap handler uses. */
  static async start(options: TalkSessionOptions): Promise<TalkSession> {
    const session = new TalkSession(options);
    await session.start();
    return session;
  }

  get state(): TalkState {
    return this.stateValue;
  }

  get grant(): TalkSessionGrant | undefined {
    return this.grantValue;
  }

  async start(): Promise<void> {
    if (this.stateValue !== 'idle') return;
    await this.open(this.options.turnstile, false);
  }

  /** Open the microphone; a refusal leaves the session in typed mode and raises the mic-denied notice. */
  async startListening(): Promise<boolean> {
    if (this.voice === null || this.stateValue !== 'live') return false;
    try {
      await this.voice.startListening();
      this.listening = true;
      return true;
    } catch (error) {
      this.listening = false;
      if (isMicDenied(error)) this.options.onNotice?.('mic-denied');
      return false;
    }
  }

  async stopListening(): Promise<void> {
    this.listening = false;
    await this.voice?.stopListening();
  }

  /** A typed line (TypedIn, or the shell's own form). Recorded as the visitor's turn. */
  sendText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed === '' || this.voice === null || this.stateValue !== 'live') return false;
    this.voice.sendText(trimmed);
    this.options.onTranscript?.('user', trimmed, true);
    this.record('user', trimmed);
    return true;
  }

  /** Wire a typed input (TypedIn) so its final lines go to Emily; returns the detach function. */
  bindTyped(input: SpeechIn): () => void {
    const off = input.onTranscript((text, final) => {
      if (final) this.sendText(text);
    });
    void input.start();
    const detach = (): void => {
      off();
      input.stop();
    };
    this.detachTyped.push(detach);
    return detach;
  }

  /** An uploaded document (text the Worker extracted) given to Emily as silent context for the next replies. */
  addDocument(name: string, text: string): void {
    const clipped = text.length > DOCUMENT_CONTEXT_CHARS ? `${text.slice(0, DOCUMENT_CONTEXT_CHARS)}...` : text;
    const context = `The visitor shared a document named "${name}". Its text follows.\n${clipped}`;
    this.pendingContext.push(context);
    if (this.voice !== null && this.stateValue === 'live') this.voice.addContext(context);
  }

  async end(reason: TalkEndReason = 'visitor'): Promise<void> {
    if (this.stateValue === 'ended') return;
    this.clearCap();
    for (const detach of this.detachTyped.splice(0)) detach();
    const voice = this.voice;
    this.voice = null;
    this.listening = false;
    this.options.being.setListening(false);
    if (voice !== null) await voice.end().catch(() => undefined);
    if (this.grantValue !== undefined) await this.revoke();
    this.grantValue = undefined;
    this.setState('ended', reason);
  }

  private async open(turnstile: string, reconnecting: boolean): Promise<void> {
    this.setState(reconnecting ? 'reconnecting' : 'requesting');
    const grant = await this.requestGrant(turnstile);
    if (grant === undefined) return;
    this.grantValue = grant;
    this.setState('connecting');
    const voice = this.createVoice(grant);
    this.voice = voice;
    try {
      await voice.connect();
    } catch (error) {
      this.voice = null;
      await voice.end().catch(() => undefined);
      await this.revoke();
      this.grantValue = undefined;
      if (isBusyError(error)) {
        this.options.onNotice?.('busy');
        this.setState('busy');
      } else {
        this.setState('error', error instanceof Error ? error.message : undefined);
      }
      return;
    }
    if (this.voice !== voice) return;
    for (const context of this.pendingContext) voice.addContext(context);
    this.setState('live');
    if (!reconnecting) this.armCap(grant.maxMinutes);
    if (this.options.listen === true || (reconnecting && this.listening)) await this.startListening();
  }

  private createVoice(grant: TalkSessionGrant): TalkVoice {
    const init: TalkVoiceInit = {
      token: grant.token,
      characterId: grant.characterId,
      endUserId: grant.endUserId,
      being: this.options.being,
      onTranscript: (speaker, text, final) => {
        this.options.onTranscript?.(speaker, text, final);
        if (final) this.record(speaker, text);
      },
      onState: (state, detail) => this.onVoiceState(state, detail),
    };
    return this.options.createVoice ? this.options.createVoice(init) : new ConvaiBrain(init);
  }

  private onVoiceState(state: ConvaiState, _detail?: string): void {
    if (state !== 'disconnected' || this.stateValue !== 'live') return;
    // The room dropped (network, or the one-hour token ran out): try again with a fresh token.
    void this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const old = this.voice;
    this.voice = null;
    if (old !== null) await old.end().catch(() => undefined);
    await this.revoke();
    this.grantValue = undefined;
    const refresh = this.options.refreshTurnstile;
    if (this.reconnects >= MAX_RECONNECTS || refresh === undefined) {
      this.options.onNotice?.('expired');
      await this.end('disconnected');
      return;
    }
    this.reconnects += 1;
    this.options.onNotice?.('reconnecting');
    let turnstile: string;
    try {
      turnstile = await refresh();
    } catch {
      await this.end('disconnected');
      return;
    }
    if (this.stateValue === 'ended') return;
    await this.open(turnstile, true);
  }

  private async requestGrant(turnstile: string): Promise<TalkSessionGrant | undefined> {
    const fetchImpl = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(this.options.sessionEndpoint ?? '/api/talk/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ turnstile, consentVersion: this.options.consentVersion }),
        credentials: 'same-origin',
      });
    } catch {
      this.setState('error', 'network');
      return undefined;
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const message = isRecord(payload) && typeof payload.error === 'string' ? payload.error : undefined;
    if (response.status === 429) {
      this.setState('limited', message);
      return undefined;
    }
    if (response.status === 503) {
      this.setState('unavailable', message);
      return undefined;
    }
    const grant = response.ok ? parseGrant(payload) : undefined;
    if (grant === undefined) {
      this.setState('error', message);
      return undefined;
    }
    if (grant.turnsLeft <= 0 && isRecord(payload) && isRecord(payload.session)) {
      this.setState('limited', message);
      return undefined;
    }
    return grant;
  }

  /** Best effort: the token dies within the hour anyway. */
  private async revoke(): Promise<void> {
    const fetchImpl = this.options.fetch ?? fetch;
    await fetchImpl(this.options.revokeEndpoint ?? '/api/talk/revoke', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  }

  private record(speaker: Speaker, text: string): void {
    if (text.trim() === '') return;
    void this.memory.recordTurn({ role: speaker, text, at: Date.now() }).catch(() => undefined);
  }

  private armCap(minutes: number): void {
    const set = this.options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
    this.capTimer = set(() => {
      this.options.onNotice?.('cap');
      void this.end('cap');
    }, minutes * 60_000);
  }

  private clearCap(): void {
    if (this.capTimer === undefined) return;
    const clear = this.options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as number));
    clear(this.capTimer);
    this.capTimer = undefined;
  }

  private setState(state: TalkState, detail?: string): void {
    this.stateValue = state;
    if (state === 'busy' || state === 'limited' || state === 'unavailable' || state === 'error') this.clearCap();
    this.options.onState?.(state, detail);
  }
}
