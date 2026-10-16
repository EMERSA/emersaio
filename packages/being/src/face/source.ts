/**
 * The contract between lip-sync sources (face/sources/*) and the FaceDriver that blends them onto the mesh.
 * A frame is a Float32Array of CHANNEL_COUNT weights in 0..1 (bone channels in -1..1). Indices 0-21 are the
 * canonical 22 Microsoft/Azure viseme ids, 22-28 the expression channels, 29-33 the head and eye bones, and 34-85
 * the ARKit block: the 52 ARKit blendshapes in the order of arkit52 (face/tables/arkit52.ts), each driving the morph
 * of the same name 1:1, which a live ARKit stream writes in its direct mode.
 */
export const VISEME_COUNT = 22;

export const CHANNEL = {
  jawOpen: 22,
  blinkLeft: 23,
  blinkRight: 24,
  browUp: 25,
  browDown: 26,
  smile: 27,
  frown: 28,
  headYaw: 29,
  headPitch: 30,
  headRoll: 31,
  eyesYaw: 32,
  eyesPitch: 33,
} as const;

/** The first channel of the ARKit block and its length (arkit52.length). */
export const ARKIT_BASE = 34;
export const ARKIT_COUNT = 52;

export const CHANNEL_COUNT = ARKIT_BASE + ARKIT_COUNT;

export const createFrame = (): Float32Array => new Float32Array(CHANNEL_COUNT);

/** Something that wants to move the face. Higher priority wins per channel; sources only write channels they own. */
export interface FaceSource {
  readonly name: string;
  /** Sources with a higher number override lower ones on the channels they write. Idle is 0, timelines 10, live streams 20. */
  readonly priority: number;
  /** Whether the source has anything to say right now. Inactive sources are skipped and their channels release. */
  active(nowMs: number): boolean;
  /**
   * Write this source's channels into `frame` and return a mask of the channel indices it wrote
   * (true = written). Values persist in `frame` only for the channels in the mask.
   */
  sample(nowMs: number, frame: Float32Array, written: Uint8Array): void;
  /** Stop and release resources; the driver calls it when the source is removed. */
  stop?(): void;
}
