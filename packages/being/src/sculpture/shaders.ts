/**
 * The shards of the sculpture. Each instance is one tiny triangle on a base triangle of the welded head and bust:
 * the vertex stage fetches the base triangle's three deformed corners (positions with the water height in w, and
 * smooth normals with the albedo in w) and places its own corner by barycentric coordinates, shrunk toward the
 * shard's centre so hairline gaps part the tiles. The water adds the simulated height and a flow of fine ripples
 * running down the surface, which also tilts the light. Colour by distance from the camera (white nearest, cyan,
 * azure, navy) shaded by a key light, with a fresnel rim and a glint; cream draws ink. Back-facing shards are parked.
 */
export const shardVert = /* glsl */ `
uniform highp sampler2D uPos;
uniform highp sampler2D uNrm;
uniform int uTexW;
uniform float uTime;
uniform float uIntro;
uniform float uFlow;
uniform float uShrink;
uniform vec3 uSubject;
uniform vec3 uWire;
uniform vec3 uGlow;
uniform vec3 uBg;
uniform float uIsLight;
uniform float uMinY;

attribute vec3 aTri;
attribute vec4 aShard;

varying vec3 vColor;
varying float vAlpha;

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float hash01(uint v) { return float(pcg(v)) / 4294967295.0; }

vec4 fetchAt(highp sampler2D tex, float index) {
  int i = int(index + 0.5);
  return texelFetch(tex, ivec2(i - (i / uTexW) * uTexW, i / uTexW), 0);
}

void main() {
  int corner = gl_VertexID;
  vec4 A = fetchAt(uPos, aTri.x);
  vec4 B = fetchAt(uPos, aTri.y);
  vec4 C = fetchAt(uPos, aTri.z);
  vec4 nA = fetchAt(uNrm, aTri.x);
  vec4 nB = fetchAt(uNrm, aTri.y);
  vec4 nC = fetchAt(uNrm, aTri.z);
  float n = aShard.z;
  vec2 off = aShard.w > 0.5
    ? (corner == 0 ? vec2(-1.0, -1.0) : corner == 1 ? vec2(2.0, -1.0) : vec2(-1.0, 2.0))
    : (corner == 0 ? vec2(1.0, -2.0) : corner == 1 ? vec2(-2.0, 1.0) : vec2(1.0, 1.0));
  vec2 uv = aShard.xy + off / (3.0 * n) * uShrink;
  vec3 w = vec3(1.0 - uv.x - uv.y, uv.x, uv.y);
  vec3 wc = vec3(1.0 - aShard.x - aShard.y, aShard.x, aShard.y);
  vec3 p = w.x * A.xyz + w.y * B.xyz + w.z * C.xyz;
  vec3 nrm = normalize(wc.x * nA.xyz + wc.y * nB.xyz + wc.z * nC.xyz);
  float height = dot(wc, vec3(A.w, B.w, C.w));
  float albedo = dot(wc, vec3(nA.w, nB.w, nC.w));
  vec3 centre = wc.x * A.xyz + wc.y * B.xyz + wc.z * C.xyz;

  // Water running down the sculpture: fine ripples travelling downward, their slope tilting the light.
  float k1 = 260.0;
  float k2 = 430.0;
  float ph1 = centre.y * k1 + centre.x * 70.0 + uTime * 2.1;
  float ph2 = centre.y * k2 - centre.z * 90.0 + uTime * 3.3;
  float flow = uFlow * (sin(ph1) + 0.6 * sin(ph2));
  vec3 slope = uFlow * vec3(70.0 * cos(ph1), k1 * cos(ph1) + 0.6 * k2 * cos(ph2), -0.6 * 90.0 * cos(ph2));
  vec3 lit = normalize(nrm - 0.9 * (slope - dot(slope, nrm) * nrm));
  // Lifted clear of the deepest trough (water 1.2 mm, flow 0.5 mm): a shard below the surface would be hidden by the
  // depth prepass and leave a black hole in her skin.
  p += nrm * (height + flow + 0.0024);

  uint id = uint(gl_InstanceID);
  float seed = hash01(id * 3u + 11u);
  // The intro: every shard flows in from a dispersed cloud, later the lower it sits, and settles on her surface.
  float delay = 0.55 * (0.6 * hash01(id * 3u + 7u) + 0.4 * clamp((1.75 - centre.y) / 0.5, 0.0, 1.0));
  float arrive = clamp((uIntro * 1.6 - delay) / 0.9, 0.0, 1.0);
  arrive = arrive * arrive * (3.0 - 2.0 * arrive);
  float swirl = seed * 6.2832;
  vec3 away = nrm * 0.25 + vec3(cos(swirl), 0.6, sin(swirl)) * (0.12 + 0.2 * hash01(id * 3u + 5u));
  p += away * (1.0 - arrive);

  vec3 toCam = cameraPosition - p;
  float dist = length(toCam);
  vec3 view = toCam / max(dist, 1e-4);
  float facing = dot(nrm, view);

  vec3 key = normalize(vec3(-0.45, 0.55, 0.7));
  float lambert = max(dot(lit, key), 0.0);
  float glint = pow(max(dot(lit, normalize(key + view)), 0.0), 48.0);
  float rim = pow(1.0 - clamp(facing, 0.0, 1.0), 3.0);
  float subject = length(cameraPosition - uSubject);
  float t = clamp((dist - (subject - 0.13)) / 0.36, 0.0, 1.0);
  float grain = 0.86 + 0.28 * seed;
  vec3 colour;
  if (uIsLight > 0.5) {
    colour = mix(uWire, uGlow, smoothstep(0.1, 0.9, t)) * (0.7 + 0.35 * lambert) * grain;
    colour = mix(colour, vec3(1.0), glint * 0.25);
    vAlpha = 0.85;
  } else {
    float luma = dot(uGlow, vec3(0.2126, 0.7152, 0.0722));
    vec3 azure = max(uGlow + (uGlow - luma) * 0.6, 0.0);
    vec3 cyan = mix(uGlow, uWire, 0.4);
    cyan = max(cyan + (cyan - dot(cyan, vec3(0.2126, 0.7152, 0.0722))) * 0.9, 0.0);
    vec3 ramp = t < 0.12 ? mix(mix(vec3(1.0), uWire, 0.5), cyan, t / 0.12)
      : t < 0.5 ? mix(cyan, azure, (t - 0.12) / 0.38) : mix(azure, azure * 0.25, (t - 0.5) / 0.5);
    colour = ramp * (0.22 + 0.8 * lambert) * albedo * grain + cyan * rim * 0.45 + mix(cyan, vec3(1.0), 0.5) * glint * 0.7;
    vAlpha = 1.0;
  }
  vColor = colour;
  // The bust fades out downward from the neck, cubed, so the shoulders still read and the headline stays clear.
  float crop = smoothstep(uMinY + 0.03, uMinY + 0.32, centre.y);
  vAlpha *= arrive * smoothstep(-0.05, 0.15, facing) * crop * crop * crop;
  vec4 clip = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_Position = facing < -0.05 ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
}
`;

export const shardFrag = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;

void main() {
  float alpha = vAlpha * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(vColor, alpha);
  #include <colorspace_fragment>
}
`;
