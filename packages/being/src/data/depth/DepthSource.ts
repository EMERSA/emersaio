import { DataTexture, type PerspectiveCamera, type Texture } from 'three';
import type { DepthClipping, FovTangents } from './depthMath.ts';

export type DepthSourceKind = 'being' | 'video' | 'kinectron';

/**
 * How the texture encodes depth: a perspective depth buffer (the being's own, through its sensor camera), grey
 * whose brightness is linear depth between the clipping planes (white near, black far; three's kinect.webm is a
 * white-cyan-blue-black ramp that decodes the same way as (r + g + b) / 3), or metres in the red channel of a float
 * texture (Kinectron, where 0 is a miss).
 */
export type DepthEncoding = 'perspective' | 'grey' | 'metres';

/**
 * Where the kinect cloud reads its depth from. A source owns one texture the cloud samples per grid cell, and
 * says how it is encoded and through which lens it was seen.
 */
export interface DepthSource {
  readonly texture: Texture;
  /** Size of the texture in texels; the cloud's grid may be coarser or finer. */
  readonly width: number;
  readonly height: number;
  /** True once the texture holds a frame; the cloud stays hidden until then. */
  readonly ready: boolean;
  readonly kind: DepthSourceKind;
  readonly encoding: DepthEncoding;
  /**
   * 2 * tan(fov / 2) for the x and y axes of the camera that saw the depth, or null when `camera` carries them (a
   * perspective source), so the cloud back-projects into the very rays that drew the depth.
   */
  readonly fovTangents: FovTangents | null;
  /** The camera a perspective source rendered through: its lens and transform place the cloud in the world. */
  readonly camera?: PerspectiveCamera;
  /** The metres a grey or metric source spans, when the source itself clips (Kinectron). */
  setClipping?(nearM: number, farM: number): void;
  /** The nearest and farthest surface of the latest frame in metres from the camera, when the source measures it. */
  range?(): DepthClipping | null;
  /** The sensor frame this texture holds, when the source has a clock: the hash key of the quantisation dither. */
  frame?(): number;
  /** Called once per frame before the cloud reads the texture. */
  update(dt: number): void;
  dispose(): void;
}

/** A 1 x 1 white texture: a miss in both image encodings, so a source without a frame yet draws nothing. */
export function blankDepthTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}
