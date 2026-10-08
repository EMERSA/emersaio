/**
 * @emersa/being/talk: the live conversation with Emily over Convai. The shell imports this subpath dynamically,
 * only after the visitor taps "Start talking", so the SDK (loaded from here with a dynamic import of
 * @convai/web-sdk/core and /vanilla) never reaches the home page's chunks.
 */
export {
  ConvaiBrain,
  type ConvaiBrainOptions,
  type ConvaiClientConfig,
  type ConvaiClientLike,
  type ConvaiSdk,
  type ConvaiState,
  loadConvaiSdk,
  type Speaker,
  type TalkBeing,
} from './ConvaiBrain.ts';
export {
  DOCUMENT_CONTEXT_CHARS,
  isBusyError,
  MAX_RECONNECTS,
  MAX_SESSION_MINUTES,
  parseGrant,
  type TalkEndReason,
  type TalkNotice,
  TalkSession,
  type TalkSessionGrant,
  type TalkSessionOptions,
  type TalkState,
  type TalkVoice,
  type TalkVoiceInit,
} from './TalkSession.ts';
