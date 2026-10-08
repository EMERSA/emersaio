/**
 * @emersa/being/face: the lip-sync sources the FaceDriver blends, and the viseme tables behind them.
 * Nothing here touches three.js or the DOM, so other hosts of the runtime and the tests can use it as plain data.
 */
export { CHANNEL, CHANNEL_COUNT, createFrame, type FaceSource, VISEME_COUNT } from './source.ts';
export { type ArkitStreamOptions, ArkitStreamSource } from './sources/ArkitStream.ts';
export {
  type AnalyserLike,
  ENERGY_VISEMES,
  type EnergyOptions,
  EnergyVisemesSource,
} from './sources/EnergyVisemes.ts';
export { type IdleOptions, IdleSource } from './sources/Idle.ts';
export { estimateDurationMs, TEXT_CHARS_PER_SECOND, TextVisemesSource, textToCues } from './sources/TextVisemes.ts';
export {
  type NormalizedCue,
  normalizeCues,
  sampleCues,
  TIMELINE_TAIL_MS,
  VISEME_RAMP_MS,
  VisemeTimelineSource,
} from './sources/VisemeTimeline.ts';
export {
  ARKIT_FRAME_LENGTH,
  ARKIT_ORDER_61,
  ARKIT_ROTATIONS,
  type ArkitName,
  type ArkitRotationName,
  arkit52,
  arkitIndex,
} from './tables/arkit52.ts';
export { azure2ms22, azureToMs22 } from './tables/azure2ms22.ts';
export {
  grapheme2ms22,
  graphemeToMs22,
  isVowelViseme,
  splitGraphemes,
  VOWEL_VISEMES,
} from './tables/grapheme2ms22.ts';
export { clampViseme, jawOpenOf, MS22_COUNT, type Ms22Viseme, ms22 } from './tables/ms22.ts';
export { OCULUS_VISEMES, type OculusViseme, oculus2ms22, oculusToMs22 } from './tables/oculus2ms22.ts';
