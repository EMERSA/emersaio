/**
 * The desktop bloom chain, in a module of its own so phones (where bloom never runs) neither download nor parse
 * three's postprocessing add-ons: createBeing imports it only when bloom is on and hands it to the Stage.
 */
import { type Camera, type IUniform, type Scene, Vector2, type WebGLRenderer } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface BloomChainOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  /** The canvas in CSS pixels; the composer applies the pixel ratio itself. */
  width: number;
  height: number;
  pixelRatio: number;
  strength: number;
  radius: number;
  threshold: number;
}

/** Scene, bloom and output passes; the Stage drives the bloom pass and the output mode directly. */
export interface BloomChain {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  output: StraightOutputPass;
  dispose(): void;
}

/**
 * The stock output shader with one extra path for a transparent canvas drawn with normal blending (the light
 * theme). The composer's target then holds premultiplied colour, and encoding that as it is lifts every
 * translucent stroke towards white on the page. Straight mode divides the alpha out, encodes, and multiplies
 * it back in, so the canvas composites the frame exactly as the direct render path does. Off, the pass is the
 * stock one: the dark theme's additive output is summed light with no coverage to undo, and un-premultiplying it
 * would dim the halos about fourfold. Tone mapping is left out because the stage runs with NoToneMapping.
 */
const straightOutputFrag = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform float uStraight;

#include <colorspace_pars_fragment>

varying vec2 vUv;

void main() {
  vec4 c = texture2D(tDiffuse, vUv);
  #ifdef SRGB_TRANSFER
    if (uStraight > 0.5) {
      // Bloom adds its own alpha on top of coverage that is already near 1, hence the clamp.
      float a = clamp(c.a, 0.0, 1.0);
      vec3 s = c.a > 1e-4 ? clamp(c.rgb / c.a, 0.0, 1.0) : vec3(0.0);
      gl_FragColor = vec4(sRGBTransferOETF(vec4(s, 1.0)).rgb * a, a);
    } else {
      gl_FragColor = sRGBTransferOETF(c);
    }
  #else
    gl_FragColor = c;
  #endif
}
`;

export class StraightOutputPass extends OutputPass {
  private readonly straight: IUniform<number> = { value: 0 };

  constructor() {
    super();
    this.uniforms.uStraight = this.straight;
    this.material.fragmentShader = straightOutputFrag;
  }

  /** Un-premultiply before the sRGB transfer (normal blending) or encode as is (additive). */
  setStraight(on: boolean): void {
    this.straight.value = on ? 1 : 0;
  }
}

export function createBloomChain(options: BloomChainOptions): BloomChain {
  const composer = new EffectComposer(options.renderer);
  composer.setPixelRatio(options.pixelRatio);
  composer.addPass(new RenderPass(options.scene, options.camera));
  // UnrealBloomPass builds its mip chain from half the size it is given, so this is a half-resolution bloom.
  const bloom = new UnrealBloomPass(
    new Vector2(options.width, options.height),
    options.strength,
    options.radius,
    options.threshold,
  );
  composer.addPass(bloom);
  const output = new StraightOutputPass();
  composer.addPass(output);
  composer.setSize(options.width, options.height);
  return {
    composer,
    bloom,
    output,
    dispose(): void {
      bloom.dispose();
      output.dispose();
      composer.dispose();
    },
  };
}
