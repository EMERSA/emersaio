/**
 * Fragment stage of the wire being: a dual stroke (thin core plus soft halo) measured in pixels through fwidth,
 * vertex dots at the triangle corners, a faint interior, dimmer back faces and a token-driven sparkle.
 * The layers are mixed by their alpha so the result reads the same under additive (dark) and normal (light)
 * blending. colorspace_fragment converts to the output colour space when drawing straight to the canvas and is a
 * no-op inside the composer, where the OutputPass does it.
 */
export const wireFrag = /* glsl */ `
uniform vec3 uWire;
uniform vec3 uGlow;
uniform vec3 uDot;
uniform float uTime;
uniform float uTokenRate;
uniform float uTokenPulse;
uniform float uAudioLevel;
uniform float uOpacity;
uniform float uLineWidth;
uniform float uGlowWidth;
uniform float uDotSize;
uniform float uIsLight;
uniform float uLineAlpha;
uniform float uDotAlpha;
uniform float uDotAudio;
uniform float uShatter;
uniform float uMirror;
uniform vec2 uViewport;

varying vec3 vBary;
varying float vSeed;
varying float vFade;

float hash1(float n) {
  return fract(sin(n) * 43758.5453);
}

void main() {
  // Distance to the nearest edge in pixels: a barycentric coordinate over its screen-space rate of change.
  vec3 width = fwidth(vBary);
  vec3 px = vBary / max(width, vec3(1e-5));
  float edge = min(px.x, min(px.y, px.z));
  float core = 1.0 - smoothstep(uLineWidth * 0.5 - 0.5, uLineWidth * 0.5 + 0.5, edge);
  float halo = 1.0 - smoothstep(0.0, uGlowWidth, edge);
  halo *= halo;

  // Vertex dots live where one barycentric coordinate dominates. Audio makes the body dots grow.
  float corner = max(vBary.x, max(vBary.y, vBary.z));
  float radius = 0.015 * uDotSize * (1.0 + uDotAudio * uAudioLevel * 1.5);
  float aa = fwidth(corner);
  float dotMask = smoothstep(1.0 - radius - aa, 1.0 - radius + aa, corner);

  // Sparkle: every triangle rolls a new number ten times a second; the token rate decides how many light up.
  float tick = floor(uTime * 10.0);
  float roll = hash1(vSeed * 913.17 + tick * 0.173);
  float density = uTokenRate * 0.12 + uTokenPulse * 0.08;
  float sparkle = step(1.0 - density, roll) * (0.6 + 0.4 * hash1(roll * 31.7));

  // Density compensation: a triangle that spans only a few pixels on screen (the head seen from afar, or the whole
  // figure inside a small docked canvas) would otherwise stack its strokes into a solid, bloomed blob. The on-screen
  // size of the triangle is the inverse of how fast its barycentrics change per pixel.
  float triPx = 1.0 / max(max(width.x, max(width.y, width.z)), 1e-4);
  float sizeGain = smoothstep(2.5, 16.0, triPx);
  float lineGain = mix(0.18, 1.0, sizeGain);

  // The halo is softer on cream, where normal blending would otherwise fatten every line.
  float haloGain = mix(0.6, 0.35, uIsLight);
  // Strokes on cream are drawn with normal blending, which has none of the lift additive light gives on dark.
  float inkGain = mix(1.0, 1.7, uIsLight);
  float lineA = min(1.0, max(core, halo * haloGain) * uLineAlpha * lineGain * inkGain);
  float dotA = dotMask * uDotAlpha * sizeGain;
  float sparkA = sparkle * 0.5 * mix(0.3, 1.0, sizeGain);
  float fillA = 0.03 * sizeGain;

  vec3 lineC = mix(uGlow, uWire, core);
  float total = max(lineA + dotA + sparkA + fillA, 1e-4);
  vec3 colour = (lineC * lineA + uDot * dotA + uGlow * sparkA + uWire * fillA) / total;
  float alpha = min(total, 1.0);

  alpha *= gl_FrontFacing ? 1.0 : 0.35;
  alpha *= uOpacity * vFade;
  // Pieces thin out as they fly, and the mirrored draw dies out over the lowest 12 percent of the canvas so the
  // reflection never ends in a hard line.
  alpha *= 1.0 - 0.8 * smoothstep(0.0, 1.0, uShatter);
  alpha *= mix(1.0, smoothstep(0.0, 0.12, gl_FragCoord.y / uViewport.y), uMirror);

  gl_FragColor = vec4(colour, alpha);
  #include <colorspace_fragment>
}
`;
