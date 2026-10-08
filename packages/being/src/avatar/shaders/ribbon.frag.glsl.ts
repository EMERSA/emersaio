/**
 * Glossy ribbon: a fresnel rim, a sharp highlight from a light at the upper left whose band slides along the
 * tube, and a gradient flowing along the length from the ribbon token through the hot token to near white.
 */
export const ribbonFrag = /* glsl */ `
uniform vec3 uRibbon;
uniform vec3 uDot;
uniform float uTime;
uniform float uFlow;
uniform float uOpacity;
uniform float uIsLight;
uniform float uMirror;
uniform vec2 uViewport;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying float vFade;

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vView);
  float facing = abs(dot(n, v));
  float fresnel = pow(1.0 - facing, 2.5);

  vec3 l = normalize(vec3(-0.6, 0.8, 0.5));
  vec3 h = normalize(l + v);
  float spec = pow(max(dot(n, h), 0.0), 36.0);
  // The highlight sharpens where a band passes, three bands along the tube, sliding with time.
  float slide = fract(vUv.x * 3.0 - uTime * 0.12 * uFlow);
  float band = exp(-pow((slide - 0.5) * 6.0, 2.0));
  float gloss = spec * (0.3 + 0.7 * band);

  // A smooth, seamless flow: ribbon colour, the hot token, near white and back, moving along the length.
  float flow = 0.5 + 0.5 * sin((vUv.x - uTime * 0.05 * uFlow) * 9.4248);
  vec3 colour = mix(uRibbon, uDot, smoothstep(0.15, 0.75, flow));
  colour = mix(colour, vec3(1.0), smoothstep(0.75, 1.0, flow) * 0.3);
  colour = mix(colour, vec3(1.0), min(1.0, fresnel * 0.35 + gloss));

  float alpha = 0.5 * (0.35 + 0.5 * fresnel + 0.6 * gloss) * mix(1.0, 1.4, uIsLight);
  alpha = min(alpha, 1.0) * vFade * uOpacity;
  alpha *= mix(1.0, smoothstep(0.0, 0.12, gl_FragCoord.y / uViewport.y), uMirror);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
  #include <colorspace_fragment>
}
`;
