/**
 * The 52 ARKit face blendshapes in the order live providers stream them (Convai, Audio2Face and most ARKit
 * capture tools agree on this order). The GLB's faceunits01 morphs carry the same names.
 */
export const arkit52 = [
  'eyeBlinkLeft',
  'eyeLookDownLeft',
  'eyeLookInLeft',
  'eyeLookOutLeft',
  'eyeLookUpLeft',
  'eyeSquintLeft',
  'eyeWideLeft',
  'eyeBlinkRight',
  'eyeLookDownRight',
  'eyeLookInRight',
  'eyeLookOutRight',
  'eyeLookUpRight',
  'eyeSquintRight',
  'eyeWideRight',
  'jawForward',
  'jawLeft',
  'jawRight',
  'jawOpen',
  'mouthClose',
  'mouthFunnel',
  'mouthPucker',
  'mouthLeft',
  'mouthRight',
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthDimpleLeft',
  'mouthDimpleRight',
  'mouthStretchLeft',
  'mouthStretchRight',
  'mouthRollLower',
  'mouthRollUpper',
  'mouthShrugLower',
  'mouthShrugUpper',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'browDownLeft',
  'browDownRight',
  'browInnerUp',
  'browOuterUpLeft',
  'browOuterUpRight',
  'cheekPuff',
  'cheekSquintLeft',
  'cheekSquintRight',
  'noseSneerLeft',
  'noseSneerRight',
  'tongueOut',
] as const;

export type ArkitName = (typeof arkit52)[number];

/**
 * The nine rotation slots a 61-value frame carries after the 52 blendshapes: head, then left eye, then right
 * eye, each as yaw, pitch, roll in radians. Positive yaw turns right, positive pitch looks up, positive roll
 * tilts the right ear down. Phase 2 verifies this order against `@convai/web-sdk/lipsync-helpers`
 * ARKIT_ORDER_61 and passes the SDK's own array to ArkitStreamSource if it differs: the source maps by name.
 */
export const ARKIT_ROTATIONS = [
  'headYaw',
  'headPitch',
  'headRoll',
  'leftEyeYaw',
  'leftEyePitch',
  'leftEyeRoll',
  'rightEyeYaw',
  'rightEyePitch',
  'rightEyeRoll',
] as const;

export type ArkitRotationName = (typeof ARKIT_ROTATIONS)[number];

/** The full 61-slot frame layout: indices 0-51 are blendshapes 0..1, indices 52-60 are rotations. */
export const ARKIT_ORDER_61: readonly (ArkitName | ArkitRotationName)[] = [...arkit52, ...ARKIT_ROTATIONS];

export const ARKIT_FRAME_LENGTH = ARKIT_ORDER_61.length;

/** Index of a name within a frame layout, so sources never hard-code a slot number. */
export const arkitIndex = (name: string, order: readonly string[] = ARKIT_ORDER_61): number => order.indexOf(name);
