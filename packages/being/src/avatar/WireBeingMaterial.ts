import { type Blending, type Color, DoubleSide, type IUniform, ShaderMaterial, Vector2 } from 'three';
import { wireFrag } from './shaders/wire.frag.glsl.ts';
import { wireVert } from './shaders/wire.vert.glsl.ts';

export type WirePreset = 'head' | 'body';

/** The theme colours, owned by ThemeUniforms and shared by reference with every material of the being. */
export type ThemeColorUniforms = {
  uWire: IUniform<Color>;
  uGlow: IUniform<Color>;
  uDot: IUniform<Color>;
  uEcho: IUniform<Color>;
  uRibbon: IUniform<Color>;
  uRim: IUniform<Color>;
  uFan: IUniform<Color>;
  /** The page colour (--bg-3d): the cloud's far end fades into it. */
  uBg: IUniform<Color>;
  uIsLight: IUniform<number>;
};

/** Everything that changes per frame, written once in index.ts and read by all materials. */
export type SharedUniforms = ThemeColorUniforms & {
  uTime: IUniform<number>;
  uTokenRate: IUniform<number>;
  uTokenPulse: IUniform<number>;
  uAudioLevel: IUniform<number>;
  uOpacity: IUniform<number>;
  /** Pieces: 0 assembled, 1 fully scattered; the wire triangles and the head's depth cloud read it alike. */
  uShatter: IUniform<number>;
  /** The drawing buffer in device pixels; the mirrored draw fades out over the lowest 12 percent of it. */
  uViewport: IUniform<Vector2>;
  /** World height of the reflecting plane: the floor for the figure, the plinth under the chin for the face. */
  uMirrorPlane: IUniform<number>;
};

/** Picks the colour uniforms by name: the source is usually a ThemeUniforms instance, not a plain object. */
export const createSharedUniforms = (colors: ThemeColorUniforms): SharedUniforms => ({
  uWire: colors.uWire,
  uGlow: colors.uGlow,
  uDot: colors.uDot,
  uEcho: colors.uEcho,
  uRibbon: colors.uRibbon,
  uRim: colors.uRim,
  uFan: colors.uFan,
  uBg: colors.uBg,
  uIsLight: colors.uIsLight,
  uTime: { value: 0 },
  uTokenRate: { value: 0 },
  uTokenPulse: { value: 0 },
  uAudioLevel: { value: 0 },
  uOpacity: { value: 0 },
  uShatter: { value: 0 },
  uViewport: { value: new Vector2(1, 1) },
  uMirrorPlane: { value: 0 },
});

export type WireUniforms = SharedUniforms & {
  uLineWidth: IUniform<number>;
  uGlowWidth: IUniform<number>;
  uDotSize: IUniform<number>;
  uLineAlpha: IUniform<number>;
  uDotAlpha: IUniform<number>;
  uDotAudio: IUniform<number>;
  /** 1 while the FloorReflection draws this material's mirrored proxy, 0 otherwise. */
  uMirror: IUniform<number>;
};

interface PresetValues {
  /** Core stroke width in pixels. */
  lineWidth: number;
  /** Halo width in pixels. */
  glowWidth: number;
  dotSize: number;
  lineAlpha: number;
  dotAlpha: number;
  /** How much the audio level grows the vertex dots. */
  dotAudio: number;
}

/** HEAD draws the full wire with dots; BODY keeps the lines faint and lets the audio level size its dots. */
const PRESETS: Readonly<Record<WirePreset, PresetValues>> = {
  head: { lineWidth: 1.2, glowWidth: 2.6, dotSize: 1, lineAlpha: 1, dotAlpha: 0.9, dotAudio: 0 },
  body: { lineWidth: 1, glowWidth: 2.2, dotSize: 0.85, lineAlpha: 0.15, dotAlpha: 0.75, dotAudio: 1 },
};

/**
 * One ShaderMaterial per mesh of the being. Both presets share one program (the preset lives in uniforms), and
 * three adds USE_SKINNING and USE_MORPHTARGETS itself for a non-raw ShaderMaterial on a skinned, morphing mesh.
 * Depth is never written: the wire is a set of transparent strokes that must not occlude each other.
 */
export class WireBeingMaterial extends ShaderMaterial {
  declare uniforms: WireUniforms;
  readonly preset: WirePreset;

  constructor(preset: WirePreset, shared: SharedUniforms, blending: Blending) {
    const values = PRESETS[preset];
    super({
      uniforms: {
        ...shared,
        uLineWidth: { value: values.lineWidth },
        uGlowWidth: { value: values.glowWidth },
        uDotSize: { value: values.dotSize },
        uLineAlpha: { value: values.lineAlpha },
        uDotAlpha: { value: values.dotAlpha },
        uDotAudio: { value: values.dotAudio },
        uMirror: { value: 0 },
      },
      vertexShader: wireVert,
      fragmentShader: wireFrag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      blending,
    });
    this.preset = preset;
    this.name = `WireBeing:${preset}`;
  }
}
