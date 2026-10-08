import { type Blending, BufferAttribute, BufferGeometry, type IUniform, Points, ShaderMaterial } from 'three';
import { ringFrag } from '../avatar/shaders/ring.frag.glsl.ts';
import { ringVert } from '../avatar/shaders/ring.vert.glsl.ts';
import type { SharedUniforms } from '../avatar/WireBeingMaterial.ts';
import { BAND_COUNT } from './AudioBands.ts';

export const RING_SEGMENTS = 256;

export interface DataRingOptions {
  radius?: number;
  /** Height of the ring's centre above the feet, in metres. */
  height?: number;
  /** Forward tilt in radians, so a camera at eye level sees an ellipse rather than a line. */
  tilt?: number;
  pixelRatio?: number;
}

type RingUniforms = {
  uBands: IUniform<Float32Array>;
  uTime: IUniform<number>;
  uPointSize: IUniform<number>;
  uCount: IUniform<number>;
  uHalf: IUniform<number>;
  uBoost: IUniform<number>;
  uDot: SharedUniforms['uDot'];
  uGlow: SharedUniforms['uGlow'];
  uListening: IUniform<number>;
  uOpacity: IUniform<number>;
};

const BASE_POINT_SIZE = 16;
const LISTEN_FADE_S = 0.25;

/** A 256-segment ring of points around the figure, each segment lifted by the audio band it sits on. */
export class DataRing {
  readonly points: Points<BufferGeometry, ShaderMaterial>;
  private readonly uniforms: RingUniforms;
  private listening = false;
  private mix = 0;

  constructor(shared: SharedUniforms, blending: Blending, options: DataRingOptions = {}) {
    // Fits a portrait stage's view (about 1.3 m across at the figure, see framingFor) with the bands' 0.16 m
    // reach to spare, so the ring never runs off the canvas edges.
    const radius = options.radius ?? 0.48;
    const positions = new Float32Array(RING_SEGMENTS * 3);
    for (let i = 0; i < RING_SEGMENTS; i += 1) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2;
      positions[i * 3] = Math.sin(angle) * radius;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.cos(angle) * radius;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));

    this.uniforms = {
      uBands: { value: new Float32Array(BAND_COUNT) },
      uTime: shared.uTime,
      uPointSize: { value: BASE_POINT_SIZE * (options.pixelRatio ?? 1) },
      uCount: { value: RING_SEGMENTS },
      uHalf: { value: 0 },
      uBoost: { value: 1 },
      uDot: shared.uDot,
      uGlow: shared.uGlow,
      uListening: { value: 0 },
      uOpacity: shared.uOpacity,
    };
    const material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: ringVert,
      fragmentShader: ringFrag,
      transparent: true,
      depthWrite: false,
      blending,
    });
    material.name = 'DataRing';

    this.points = new Points(geometry, material);
    this.points.position.y = options.height ?? 0.98;
    this.points.rotation.x = options.tilt ?? 0.32;
    // The bands push points outside the static bounds, so culling has to stay off.
    this.points.frustumCulled = false;
  }

  get material(): ShaderMaterial {
    return this.points.material;
  }

  /** Copy this frame's bands in and ease the listening colour. */
  update(bands: Float32Array, dtSeconds: number): void {
    this.uniforms.uBands.value.set(bands.subarray(0, BAND_COUNT));
    const goal = this.listening ? 1 : 0;
    this.mix += (goal - this.mix) * (1 - Math.exp(-dtSeconds / LISTEN_FADE_S));
    this.uniforms.uListening.value = this.mix;
    this.uniforms.uBoost.value = 1 + 0.5 * this.mix;
  }

  /** The microphone is open: the ring switches to the glow colour and leans out a little further. */
  setListening(on: boolean): void {
    this.listening = on;
  }

  /** Draw every second point (the lite tier). */
  setHalf(half: boolean): void {
    this.uniforms.uHalf.value = half ? 1 : 0;
  }

  setPixelRatio(ratio: number): void {
    this.uniforms.uPointSize.value = BASE_POINT_SIZE * ratio;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.removeFromParent();
  }
}
