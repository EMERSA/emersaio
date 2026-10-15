/**
 * One step of the shards' liquid skin (data/fluidMath.ts has the JavaScript twin): a full-screen pass over the
 * simulation's grid. The state texture holds the height now (r), the height a step before (g) and the surface's
 * slope across and up the frame (b, a), which the shards light from. The new height is half the sum of the four
 * neighbours less the height a step back, damped, plus the three brushes (the voice at the lips, the pointer, a
 * drop), held within the limit and kept only where the sensor saw the figure: off the silhouette the liquid is
 * pinned to zero, so rings reflect from the edge of the face the way they would from the rim of a dish.
 */
export const fluidVert = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const fluidFrag = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uDepth;
uniform float uEncoding;
uniform vec2 uClip;
uniform vec2 uTexel;
uniform float uDamping;
uniform float uLimit;
uniform float uAspect;
uniform float uReset;
uniform vec4 uVoice;
uniform vec4 uStir;
uniform vec4 uDrop;

varying vec2 vUv;

// The same hit test as the cloud's: something there in the sensor's frame.
float surfaceAt(vec2 uv) {
  vec4 texel = texture2D(uDepth, uv);
  if (uEncoding < 0.5) return texel.r < 0.9999 ? 1.0 : 0.0;
  if (uEncoding < 1.5) {
    float grey = dot(texel.rgb, vec3(1.0 / 3.0));
    return grey > 0.02 && grey < 0.98 ? 1.0 : 0.0;
  }
  return texel.r >= uClip.x && texel.r <= uClip.y ? 1.0 : 0.0;
}

float brush(vec4 b) {
  vec2 d = (vUv - b.xy) * vec2(uAspect, 1.0);
  return b.z * exp(-dot(d, d) / max(b.w * b.w, 1e-6));
}

void main() {
  if (uReset > 0.5) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec4 state = texture2D(uState, vUv);
  float north = texture2D(uState, vUv + vec2(0.0, uTexel.y)).r;
  float south = texture2D(uState, vUv - vec2(0.0, uTexel.y)).r;
  float east = texture2D(uState, vUv + vec2(uTexel.x, 0.0)).r;
  float west = texture2D(uState, vUv - vec2(uTexel.x, 0.0)).r;
  float h = ((north + south + east + west) * 0.5 - state.g) * uDamping;
  h += brush(uVoice) + brush(uStir) + brush(uDrop);
  h = clamp(h, -uLimit, uLimit) * surfaceAt(vUv);
  gl_FragColor = vec4(h, state.r, 0.5 * (east - west), 0.5 * (north - south));
}
`;
