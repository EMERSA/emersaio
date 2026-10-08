/**
 * Fragment stage of the kinect grid. Wire mode (uMode 0) is the wire being's dual stroke, measured in pixels through
 * fwidth and uLineWidth wide; mesh mode (uMode 1) is a solid metallic surface: the body in the depth ramp, a fresnel
 * rim in the hot token and a sharp highlight from the light at the upper left. Both take the cloud's opacity and
 * the mirrored draw's screen-space fade. Shards mode (uMode 2) is a glowing facet: a soft body in the depth ramp, a
 * crisp barycentric edge about one pixel wide in the near (wire) colour, and a fresnel shimmer from the lattice
 * normal, each shard on its own slow phase. In the dark theme (additive) the core is a deep azure from --glow and the
 * light gathers cyan-white where the surface turns from the sensor, along the silhouette and at depth steps, so the
 * outline glows like three's kinect demo; on cream it keeps the token ramp with normal blending.
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
uniform float uTime;
uniform vec3 uWire;

varying vec3 vBary;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormal;
varying vec3 vView;
varying float vSeed;
varying float vDepthT;
varying float vSil;
varying float vFacing;
varying float vRecess;
uniform vec3 uGlow;

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
  } else if (uMode > 1.5) {
    vec3 width = fwidth(vBary);
    vec3 px = vBary / max(width, vec3(1e-5));
    float edge = 1.0 - smoothstep(0.2, 0.9, min(px.x, min(px.y, px.z)));
    vec3 n = normalize(vNormal);
    float facing = abs(dot(n, normalize(vView)));
    float fresnel = pow(1.0 - facing, 2.5);
    float lambert = max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0);
    float shimmer = 0.5 + 0.5 * sin(uTime * 1.3 + vSeed * 6.2832);
    // A key light at the upper left: the face keeps its relief even seen straight on, at a few pixels a shard.
    if (uIsLight > 0.5) {
      // Cream, normal blending: ink (the wire token) near the sensor through azure (glow) behind, shaded by the key
      // light, and the turned edges and the silhouette drawn back toward ink, the light theme's echo of the glow.
      float turn = pow(1.0 - vFacing, 2.2);
      colour = mix(uWire, uGlow, smoothstep(0.05, 0.85, vDepthT)) * (0.75 + 0.35 * lambert);
      colour = mix(colour, uWire, clamp(turn * 1.5 + vSil * 0.8, 0.0, 0.8) * (1.0 - vRecess));
      colour = mix(colour, vec3(1.0), edge * 0.12 + 0.12 * vRecess);
      colour = max((colour - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
      alpha = mix(0.92, 0.55, vRecess) * (0.85 + 0.15 * shimmer);
    } else {
      // Dark theme, added onto the page: a deep, saturated azure core (the glow token, darker with depth), cyan-white
      // where the surface turns away from the sensor and along the silhouette and depth steps (the wire token is the
      // hot end), and white only at the very brightest. Dense, steep areas add up and bloom a little on their own.
      float turn = pow(1.0 - vFacing, 2.2);
      float near = 1.0 - smoothstep(0.0, 0.45, vDepthT);
      vec3 core = uGlow * uGlow * (0.1 + 0.55 * lambert) * mix(1.0, 0.3, vDepthT);
      // The hot colour: the glow token lifted toward the wire token, then pushed further from grey (cyan-azure).
      vec3 cyan = mix(uGlow, uWire, 0.35);
      cyan = max(cyan + (cyan - vec3(dot(cyan, vec3(0.2126, 0.7152, 0.0722)))) * 0.8, 0.0);
      // The inner shell seen through the eyes and the mouth lies far behind the face: it stays a dim, recessed blue.
      float recess = 1.0 - vRecess;
      float hot = clamp(turn * 4.0 + vSil * 2.4, 0.0, 2.2) * (0.75 + 0.25 * shimmer) * recess;
      colour = core + cyan * hot * (0.6 + 0.4 * near) + uWire * (edge * 0.1 + 0.08 * near * lambert * lambert);
      colour = mix(colour, vec3(1.0), smoothstep(1.4, 2.2, hot) * 0.35) * mix(1.0, 0.45, vRecess);
      colour = max((colour - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
      alpha = 1.0;
    }
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
