/** Ring points: the dot colour at rest, the glow colour while the being listens, brighter with band energy. */
export const ringFrag = /* glsl */ `
uniform vec3 uDot;
uniform vec3 uGlow;
uniform float uListening;
uniform float uOpacity;

varying float vEnergy;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float disc = 1.0 - smoothstep(0.12, 0.25, dot(p, p));
  vec3 colour = mix(uDot, uGlow, uListening);
  float alpha = disc * (0.35 + 0.65 * min(vEnergy * 1.5, 1.0)) * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
  #include <colorspace_fragment>
}
`;
