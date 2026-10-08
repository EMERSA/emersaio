import type { Brain, BrainContext, BrainEvent } from '../../types.ts';

/**
 * Phase 2 options for the Convai path. The Worker mints a one-hour token at POST /api/talk/session; the
 * client connects with it, streams speech both ways over LiveKit and pushes 61-value ARKit frames to
 * ArkitStreamSource through onFrame. Memory stays server side, keyed by an opaque endUserId.
 */
export interface ConvaiBrainOptions {
  /** Where the browser asks for its session token; defaults to /api/talk/session. */
  sessionEndpoint?: string;
  /** The character to talk to (CONVAI_CHARACTER_ID is public configuration). */
  characterId: string;
  /** Opaque visitor id the Worker derives from the consent cookie; never a raw cookie value. */
  endUserId?: string;
  /** Ask for ARKit blendshapes alongside audio. */
  enableLipsync?: boolean;
  /** Receives each 61-value frame; wire it to ArkitStreamSource.push. */
  onFrame?: (frame61: Float32Array) => void;
  /** Receives the remote audio stream so the data ring can tap it. */
  onAudioTrack?: (stream: MediaStream) => void;
  /** Called when the character has no free session (the plan's concurrency cap). */
  onBusy?: () => void;
}

export const CONVAI_NOT_YET = 'Available in Phase 2';

/** Typed stub until the talk routes ship; respond() throws so a misconfigured shell fails at first use. */
export class ConvaiBrain implements Brain {
  readonly name = 'convai';
  readonly options: Readonly<ConvaiBrainOptions>;

  constructor(options: ConvaiBrainOptions) {
    this.options = { sessionEndpoint: '/api/talk/session', enableLipsync: true, ...options };
  }

  respond(_context: BrainContext): AsyncIterable<BrainEvent> {
    throw new Error(CONVAI_NOT_YET);
  }
}
