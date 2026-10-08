/**
 * Fragment stage of the kinect grid. Wire mode (uMode 0) is the wire being's dual stroke, measured in pixels through
 * fwidth and uLineWidth wide; mesh mode (uMode 1) is a solid metallic surface: the body in the depth ramp, a fresnel
 * rim in the hot token and a sharp highlight from the light at the upper left. Both take the cloud's opacity and
 * the mirrored draw's screen-space fade.
 */
export const kinectGridFrag = /* glsl */ `
uniform float uMode;
uniform float uLineWidth;
uniform float uKinectOpacity;
uniform float uOpacity;
uniform float uIsLight;
uniform float uMirror;
uniform vec2 uViewport;
uniform vec3 uDot;
uniform float uBrightness;
uniform float uContrast;

varying vec3 vBary;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormal;
varying vec3 vView;

void main() {
  vec3 colour = vColor;
  float alpha;
  if (uMode < 0.5) {
    vec3 width = fwidth(vBary);
    vec3 px = vBary / max(width, vec3(1e-5));
    float edge = min(px.x, min(px.y, px.z));
    float core = 1.0 - smoothstep(uLineWidth * 0.5 - 0.5, uLineWidth * 0.5 + 0.5, edge);
    float halo = 1.0 - smoothstep(0.0, uLineWidth * 2.2, edge);
    halo *= halo;
    alpha = max(core, halo * mix(0.5, 0.3, uIsLight)) * mix(0.75, 1.0, uIsLight);
  } else {
    vec3 n = normalize(vNormal);
    vec3 v = normalize(vView);
    float facing = abs(dot(n, v));
    float fresnel = pow(1.0 - facing, 3.0);
    vec3 h = normalize(normalize(vec3(-0.6, 0.8, 0.5)) + v);
    float spec = pow(max(dot(n, h), 0.0), 48.0);
    vec3 rim = max((uDot - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
    // A solid surface: drawn with normal blending whatever the theme (KinectCloud), so it occludes rather than
    // adds. The body stays under the bloom threshold; only the rim and the highlight are bright enough to bloom,
    // which is what reads as metal.
    colour = mix(colour * (0.12 + 0.4 * facing), rim * 0.7, fresnel) + vec3(0.8 * spec);
    alpha = 1.0;
  }
  alpha *= vAlpha * uKinectOpacity * uOpacity;
  alpha *= mix(1.0, smoothstep(0.0, 0.12, gl_FragCoord.y / uViewport.y), uMirror);
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(colour, alpha);
  #include <colorspace_fragment>
}
`;
