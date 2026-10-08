/**
 * Fragment stage of the hero point cloud: a soft round sprite in the page's wire colour, shifting to the glow colour
 * (and lifted towards white in dark mode) while a point sparkles. Blending is chosen on the CPU per theme.
 */
export const cloudFrag = `#version 300 es
precision mediump float;

in float vAlpha;
in float vSpark;

uniform vec3 uWire;
uniform vec3 uGlow;
uniform float uAlpha;
uniform float uLift;

out vec4 outColor;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float soft = 1.0 - smoothstep(0.02, 0.25, r2);
  vec3 col = mix(uWire, uGlow, vSpark) + vec3(vSpark * uLift);
  outColor = vec4(col, soft * vAlpha * uAlpha);
}
`;
