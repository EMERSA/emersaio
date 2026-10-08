/**
 * Soft round discs through gl_PointCoord, 0.16 alpha at the near end of the ramp (the vertex stage thins it to 0.4
 * of that at the far end), so the cloud never looks like squares and overlaps glow where the dark theme adds light.
 * Cream draws with normal blending and gets twice the ink, which still reads as a faint field rather than paint.
 */
export const kinectFrag = /* glsl */ `
uniform float uOpacity;
uniform float uIsLight;
uniform float uKinectOpacity;
uniform float uMirror;
uniform vec2 uViewport;

varying vec3 vColor;
varying float vAlpha;

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float d = dot(p, p);
  float disc = 1.0 - smoothstep(0.1, 0.25, d);
  float alpha = disc * vAlpha * 0.16 * mix(1.0, 2.0, uIsLight) * uOpacity * uKinectOpacity;
  alpha *= mix(1.0, smoothstep(0.0, 0.12, gl_FragCoord.y / uViewport.y), uMirror);
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(vColor, alpha);
  #include <colorspace_fragment>
}
`;
