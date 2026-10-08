import { type Blending, type Color, Group, type IUniform, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { glowFrag, glowVert } from '../avatar/shaders/glow.glsl.ts';

/** The uniforms the backdrop shares with the rest of the being (ThemeUniforms and the shared set). */
export interface BackdropUniforms {
  uRim: IUniform<Color>;
  uIsLight: IUniform<number>;
  uOpacity: IUniform<number>;
}

/**
 * The one rim light (the minimal brief, shared contract item 5): azure --rim at alpha 0.22 on dark and 0.08 on
 * cream, centred 8 percent of the frame to the right of the head's centre, its radius 0.75 of the head's height.
 * It is the bottle's right-edge rim; the ice wire carries the left-side highlight. No beams, no pool, no floor.
 */
export const RIM_ALPHA = { dark: 0.22, light: 0.08 } as const;
export const RIM_RIGHT_SHARE = 0.08;
export const RIM_RADIUS_SHARE = 0.75;
/** The figure looks (dev harness): the same light behind the chest, 0.8 m across. */
const FIGURE_RIM = { y: 1, diameter: 1.6 } as const;
/** The height the lighting is centred on until setFocus() moves it. */
export const RIM_HEIGHT_M = FIGURE_RIM.y;

/**
 * One soft radial glow in the rim token behind the figure: a static quad sharing the glow shader. The glow's
 * radial falloff reaches zero at the quad's edge, so the quad is twice the radius across. The camera never orbits
 * far, so a plane facing +Z stands in for a sprite; drawn first and without depth, it sits behind everything.
 */
export class Backdrop {
  readonly group = new Group();
  readonly materials: ShaderMaterial[] = [];
  private readonly geometry = new PlaneGeometry(1, 1);
  private readonly rim: Mesh;

  constructor(uniforms: BackdropUniforms, blending: Blending) {
    const material = new ShaderMaterial({
      uniforms: {
        uColor: uniforms.uRim,
        uAlpha: { value: RIM_ALPHA.dark },
        uAlphaLight: { value: RIM_ALPHA.light },
        uShape: { value: 0 },
        uIsLight: uniforms.uIsLight,
        uOpacity: uniforms.uOpacity,
      },
      vertexShader: glowVert,
      fragmentShader: glowFrag,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending,
    });
    material.name = 'RimLight';
    this.rim = new Mesh(this.geometry, material);
    // Behind everything: the backdrop is the first thing drawn, whatever its distance.
    this.rim.renderOrder = -4;
    this.rim.frustumCulled = false;
    this.materials.push(material);
    this.group.add(this.rim);
    this.group.name = 'Backdrop';
    this.setFocus(0, FIGURE_RIM.y, -0.6, FIGURE_RIM.diameter);
  }

  setEnabled(on: boolean): void {
    this.group.visible = on;
  }

  /** Centre the light at a world point and give it a diameter in metres (the radius is half of it). */
  setFocus(x: number, y: number, z: number, diameter: number): void {
    this.rim.position.set(x, y, z);
    this.rim.scale.set(diameter, diameter, 1);
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.geometry.dispose();
    this.group.removeFromParent();
  }
}
