/**
 * Soft light on a quad: a radial glow (uShape 0) for the rim light behind the head and for the floor disc of the
 * dev harness's reflection, or a ray (uShape 1), soft across its width and fading at both ends. The alpha is given
 * per theme (uAlpha on dark, uAlphaLight on cream, where normal blending would read the dark value as paint).
 * Static and cheap: no time, no noise.
 */
export const glowVert = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const glowFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uAlphaLight;
uniform float uShape;
uniform float uIsLight;
uniform float uOpacity;

varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  float radial = 1.0 - smoothstep(0.0, 0.5, length(p));
  radial *= radial;
  float across = 1.0 - smoothstep(0.0, 0.5, abs(p.x));
  float along = smoothstep(-0.5, -0.15, p.y) * (1.0 - smoothstep(0.1, 0.5, p.y));
  float ray = across * across * along;
  float alpha = mix(radial, ray, uShape) * mix(uAlpha, uAlphaLight, uIsLight) * uOpacity;
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <colorspace_fragment>
}
`;
