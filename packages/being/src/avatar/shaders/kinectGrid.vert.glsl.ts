/**
 * The triangle modes of the kinect cloud (wire and mesh): the depth grid as an index-free lattice of cells, six
 * vertices each, decoded from gl_VertexID (data/kinectGrid.ts has the JavaScript twin of the decoding and the
 * discontinuity rule). Every vertex samples the four corners of its cell: a cell with a corner that saw nothing, or
 * one spanning a relative depth jump of more than 4 percent of its distance (scaled by the displacement), is parked
 * outside the clip volume whole. The decode of the three encodings is the point cloud's (kinect.vert.glsl.ts).
 */
export const kinectGridVert = /* glsl */ `
#include <packing>

uniform sampler2D uDepth;
uniform vec2 uLattice;
uniform float uNear;
uniform float uFar;
uniform float uEncoding;
uniform vec2 uTangents;
uniform float uZOffset;
uniform float uScatter;
uniform vec2 uRamp;
uniform float uMirror;
uniform float uMirrorPlane;
uniform float uDisplacement;
uniform float uBrightness;
uniform float uContrast;
uniform vec3 uDot;
uniform vec3 uWire;
uniform vec3 uGlow;
uniform vec3 uBg;

varying vec3 vBary;
varying vec3 vColor;
varying float vAlpha;
varying vec3 vNormal;
varying vec3 vView;

const float JUMP_SHARE = 0.04;

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float hash01(uint cell, uint salt) {
  return float(pcg(pcg(cell) + salt)) / 4294967295.0;
}

float distanceAt(vec2 uv) {
  vec4 texel = texture2D(uDepth, uv);
  float d;
  bool hit;
  if (uEncoding < 0.5) {
    hit = texel.r < 0.9999;
    d = -perspectiveDepthToViewZ(texel.r, uNear, uFar);
  } else if (uEncoding < 1.5) {
    float grey = dot(texel.rgb, vec3(1.0 / 3.0));
    hit = grey > 0.02 && grey < 0.98;
    d = (1.0 - grey) * (uFar - uNear) + uNear;
  } else {
    d = texel.r;
    hit = d >= uNear && d <= uFar;
  }
  float centre = 0.5 * (uRamp.x + uRamp.y);
  return hit ? centre + (d - centre) * uDisplacement : -1.0;
}

vec3 backProject(vec2 uv, float d) {
  return vec3((uv.x - 0.5) * d * uTangents.x, (uv.y - 0.5) * d * uTangents.y, -d + uZOffset);
}

void main() {
  int cellId = gl_VertexID / 6;
  int c = gl_VertexID - cellId * 6;
  float cols = uLattice.x - 1.0;
  vec2 cell = vec2(mod(float(cellId), cols), floor(float(cellId) / cols));
  vec2 corner = c == 0 ? vec2(0.0) : c == 1 ? vec2(1.0, 0.0) : c == 2 ? vec2(0.0, 1.0)
    : c == 3 ? vec2(1.0, 0.0) : c == 4 ? vec2(1.0) : vec2(0.0, 1.0);
  int b = c - 3 * (c / 3);
  vBary = vec3(b == 0 ? 1.0 : 0.0, b == 1 ? 1.0 : 0.0, b == 2 ? 1.0 : 0.0);

  vec2 texel = 1.0 / uLattice;
  vec2 uv00 = (cell + 0.5) * texel;
  float d00 = distanceAt(uv00);
  float d10 = distanceAt(uv00 + vec2(texel.x, 0.0));
  float d01 = distanceAt(uv00 + vec2(0.0, texel.y));
  float d11 = distanceAt(uv00 + texel);
  float lo = min(min(d00, d10), min(d01, d11));
  float hi = max(max(d00, d10), max(d01, d11));
  float ok = step(0.0, lo) * step(hi - lo, JUMP_SHARE * lo * uDisplacement);

  float d = corner.x < 0.5 ? (corner.y < 0.5 ? d00 : d01) : (corner.y < 0.5 ? d10 : d11);
  vec3 pos = backProject(uv00 + corner * texel, d);
  vec3 p00 = backProject(uv00, d00);
  vec3 p10 = backProject(uv00 + vec2(texel.x, 0.0), d10);
  vec3 p01 = backProject(uv00 + vec2(0.0, texel.y), d01);

  uint id = uint(cellId);
  float h1 = hash01(id, 5u);
  float h2 = hash01(id, 6u);
  float h3 = hash01(id, 7u);
  float travel = uScatter * (0.3 + 0.7 * h3) * 0.35;
  pos += normalize(vec3(h1, h2, h3) * 2.0 - 1.0 + 1e-3) * travel;
  float scatterFade = 1.0 - smoothstep(0.0, 0.35, travel) * 0.8;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vNormal = normalize(mat3(modelMatrix) * cross(p10 - p00, p01 - p00));
  vView = cameraPosition - world.xyz;
  float above = mix(world.y - uMirrorPlane, uMirrorPlane - world.y, uMirror);
  float mirrorFade = mix(1.0, 0.35 * (1.0 - smoothstep(0.0, 0.9, above)) * step(0.0, above), uMirror);

  float depthT = clamp((d - uRamp.x) / max(uRamp.y - uRamp.x, 1e-3), 0.0, 1.0);
  vec3 royal = mix(uGlow, uBg, 0.55);
  vec3 colour = depthT < 0.5 ? mix(uWire, uGlow, depthT * 2.0) : mix(uGlow, royal, depthT * 2.0 - 1.0);
  vColor = max((colour - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
  vAlpha = ok * mix(1.0, 0.6, depthT) * scatterFade * mirrorFade;
  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), projectionMatrix * viewMatrix * world, ok);
}
`;
