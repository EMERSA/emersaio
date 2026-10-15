/**
 * The triangle modes of the kinect cloud (wire and mesh): the depth grid as an index-free lattice of cells, six
 * vertices each, decoded from gl_VertexID (data/kinectGrid.ts has the JavaScript twin of the decoding and the
 * discontinuity rule). Every vertex samples the four corners of its cell: a cell with a corner that saw nothing, or
 * one spanning a relative depth jump of more than 4 percent of its distance (scaled by the displacement), is parked
 * outside the clip volume whole. The decode of the three encodings is the point cloud's (kinect.vert.glsl.ts).
 *
 * Every odd row of cells takes the other diagonal (data/kinectGrid.ts), and in shards mode (uMode 2) every odd
 * lattice row also stands half a cell to the right and every lattice point is nudged by its own hash, so each cell
 * cuts into two near-equilateral triangles, each a little different: the shards read as tiny triangles, not as a
 * grid of squares. Each triangle is pulled uShrink of the way toward its centroid, so hairline gaps part the lattice
 * into separate glowing facets, with a per-shard seed for the shimmer. A cell below uMinY (world metres) is not
 * drawn: the head-and-shoulders crop. Shards also hand the fragment stage the depth share, the cell's facing toward
 * the sensor and a silhouette term (a missing or jumping neighbour) for the glow.
 *
 * The shards ride a liquid skin: uFluid is SurfaceFluid's state (height, last height, slope). Every lattice point
 * moves along the sensor ray by its height (uFluidAmp metres per unit), shared by the cells that meet there, so the
 * sheet rolls with the waves without cracking; the slope tilts the light (uFluidTilt), and each facet keeps a share
 * of its own normal, so the triangles catch the light one by one as a ring passes.
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
uniform float uMode;
uniform float uShrink;
uniform float uMinY;
uniform float uIsLight;
uniform float uTime;
uniform float uRipple;
uniform sampler2D uFluid;
uniform float uFluidAmp;
uniform float uFluidTilt;

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
varying vec3 vSmooth;

const float JUMP_SHARE = 0.04;
// data/kinectGrid.ts STAGGER and JITTER: odd rows half a cell right; each point nudged within 0.3 of a cell.
const float STAGGER = 0.5;
const float JITTER = 0.3;
// How much of a facet's own normal its light keeps: enough that neighbours differ, not so much that the face is noise.
const float FACET_SHARE = 0.25;
const float CROP_FADE_FROM_M = 0.04;
const float CROP_FADE_M = 0.3;

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float hash01(uint cell, uint salt) {
  return float(pcg(pcg(cell) + salt)) / 4294967295.0;
}

// A slow water-like field over the sensor plane: three sines with periods of about 8, 11 and 13.5 s and
// wavelengths of 0.22, 0.31 and 0.17 m, summed and scaled to +-uRipple metres along the sensor ray. Evaluated at
// the shared corner uvs, so neighbouring cells agree exactly and the lattice never cracks. p is backProject()'s xy.
float ripple(vec2 uv, float d) {
  vec2 p = (uv - 0.5) * uTangents * d;
  float w = sin(p.x * 28.6 + uTime * 0.785)
    + sin(p.y * 20.3 - uTime * 0.571 + 1.7)
    + sin((p.x + p.y) * 37.0 + uTime * 0.465 + 3.1);
  return uRipple * w * (1.0 / 3.0);
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
  if (!hit) return -1.0;
  float base = centre + (d - centre) * uDisplacement;
  return base + ripple(uv, base);
}

// A lattice point's uv. The shards stagger and jitter their lattice (the same nudge for every cell sharing the
// point, so the sheet never cracks); the wire and mesh modes keep the square one.
vec2 pointUv(vec2 ij, vec2 texel) {
  if (uMode < 1.5) return (ij + 0.5) * texel;
  uint pid = uint(ij.y) * 8192u + uint(ij.x);
  vec2 jitter = (vec2(hash01(pid, 11u), hash01(pid, 12u)) - 0.5) * JITTER;
  return (ij + vec2(STAGGER * mod(ij.y, 2.0), 0.0) + 0.5 + jitter) * texel;
}

// The liquid's height at a lattice point, in metres along the sensor ray; a miss stays a miss.
float withFluid(vec2 uv, float d) {
  return d < 0.0 ? d : d + uFluidAmp * texture2D(uFluid, uv).r;
}

vec3 backProject(vec2 uv, float d) {
  return vec3((uv.x - 0.5) * d * uTangents.x, (uv.y - 0.5) * d * uTangents.y, -d + uZOffset);
}

void main() {
  int cellId = gl_VertexID / 6;
  int c = gl_VertexID - cellId * 6;
  float cols = uLattice.x - 1.0;
  vec2 cell = vec2(mod(float(cellId), cols), floor(float(cellId) / cols));
  // Even rows: (0,0) (1,0) (0,1) and (1,0) (1,1) (0,1). Odd rows take the other diagonal: (0,0) (1,0) (1,1) and
  // (0,0) (1,1) (0,1). With the shards' stagger both are near-equilateral.
  bool odd = mod(cell.y, 2.0) > 0.5;
  vec2 corner = odd
    ? (c == 0 || c == 3 ? vec2(0.0) : c == 1 ? vec2(1.0, 0.0) : c == 5 ? vec2(0.0, 1.0) : vec2(1.0))
    : (c == 0 ? vec2(0.0) : c == 1 || c == 3 ? vec2(1.0, 0.0) : c == 4 ? vec2(1.0) : vec2(0.0, 1.0));
  int b = c - 3 * (c / 3);
  vBary = vec3(b == 0 ? 1.0 : 0.0, b == 1 ? 1.0 : 0.0, b == 2 ? 1.0 : 0.0);

  vec2 texel = 1.0 / uLattice;
  vec2 uv00 = pointUv(cell, texel);
  vec2 uv10 = pointUv(cell + vec2(1.0, 0.0), texel);
  vec2 uv01 = pointUv(cell + vec2(0.0, 1.0), texel);
  vec2 uv11 = pointUv(cell + vec2(1.0), texel);
  float d00 = withFluid(uv00, distanceAt(uv00));
  float d10 = withFluid(uv10, distanceAt(uv10));
  float d01 = withFluid(uv01, distanceAt(uv01));
  float d11 = withFluid(uv11, distanceAt(uv11));
  float lo = min(min(d00, d10), min(d01, d11));
  float hi = max(max(d00, d10), max(d01, d11));
  float ok = step(0.0, lo) * step(hi - lo, JUMP_SHARE * lo * uDisplacement);

  float d = corner.x < 0.5 ? (corner.y < 0.5 ? d00 : d01) : (corner.y < 0.5 ? d10 : d11);
  vec3 p00 = backProject(uv00, d00);
  vec3 p10 = backProject(uv10, d10);
  vec3 p01 = backProject(uv01, d01);
  vec3 p11 = backProject(uv11, d11);
  vec3 pos = corner.x < 0.5 ? (corner.y < 0.5 ? p00 : p01) : (corner.y < 0.5 ? p10 : p11);
  // This vertex's triangle, for the shards' shrink and their own facet normal.
  bool second = c >= 3;
  vec3 ta = odd || !second ? p00 : p10;
  vec3 tb = second ? p11 : p10;
  vec3 tc = odd ? (second ? p01 : p11) : p01;
  if (uMode > 1.5) pos = mix(pos, (ta + tb + tc) / 3.0, uShrink);

  uint id = uint(cellId);
  float h1 = hash01(id, 5u);
  float h2 = hash01(id, 6u);
  float h3 = hash01(id, 7u);
  float travel = uScatter * (0.3 + 0.7 * h3) * 0.35;
  pos += normalize(vec3(h1, h2, h3) * 2.0 - 1.0 + 1e-3) * travel;
  float scatterFade = 1.0 - smoothstep(0.0, 0.35, travel) * 0.8;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  ok *= step(uMinY, (modelMatrix * vec4(p00, 1.0)).y);
  vSeed = hash01(id, 9u) + float(c / 3) * 0.5;
  vec3 lattice = cross(p10 - p00, p01 - p00);
  vSil = 0.0;
  vRecess = 0.0;
  if (uMode > 1.5) {
    // Shards light from a wider normal (three cells across) so the depth steps of one cell do not band the face.
    vec2 mid = 0.25 * (uv00 + uv10 + uv01 + uv11);
    vec2 span = 1.5 * texel;
    float dl = distanceAt(mid - vec2(span.x, 0.0));
    float dr = distanceAt(mid + vec2(span.x, 0.0));
    float dd = distanceAt(mid - vec2(0.0, span.y));
    float du = distanceAt(mid + vec2(0.0, span.y));
    if (min(min(dl, dr), min(dd, du)) > 0.0) {
      vec3 wide = cross(
        backProject(mid + vec2(span.x, 0.0), dr) - backProject(mid - vec2(span.x, 0.0), dl),
        backProject(mid + vec2(0.0, span.y), du) - backProject(mid - vec2(0.0, span.y), dd)
      );
      lattice = wide;
      // A step in depth across the three cells (a fold, the jaw over the neck, the ear over the cheek) glows.
      float jump = max(abs(dr - dl), abs(du - dd)) / max(lo, 1e-3);
      vSil = smoothstep(0.025, 0.07, jump);
      // A wider ring (five cells out) finds the silhouette before the cell reaches it, so the outline is a band.
      vec2 ring = 5.0 * texel;
      float rl = distanceAt(mid - vec2(ring.x, 0.0));
      float rr = distanceAt(mid + vec2(ring.x, 0.0));
      float rd = distanceAt(mid - vec2(0.0, ring.y));
      float ru = distanceAt(mid + vec2(0.0, ring.y));
      float ringMin = min(min(rl, rr), min(rd, ru));
      if (ringMin < 0.0) {
        vSil = max(vSil, 0.8);
      } else {
        // Well behind its ring (the inner shell through the eyes and the mouth): a recessed cell, drawn dim.
        vRecess = smoothstep(0.012, 0.035, lo - min(ringMin, min(min(dl, dr), min(dd, du))));
      }
    } else {
      // A neighbour that saw nothing: the cell is on the silhouette, which glows like the demo's outline.
      vSil = 1.0;
    }
  }
  vec3 lit = lattice;
  if (uMode > 1.5) {
    // The liquid's slope tilts the light (the surface is z = -(d + h), so its normal leans along the slope), and
    // each facet keeps a share of its own normal.
    vec2 slope = texture2D(uFluid, 0.25 * (uv00 + uv10 + uv01 + uv11)).ba;
    lattice = normalize(normalize(lattice) + uFluidTilt * vec3(slope, 0.0));
    vec3 facet = cross(tb - ta, tc - ta);
    facet *= dot(facet, lattice) < 0.0 ? -1.0 : 1.0;
    lit = normalize(mix(lattice, normalize(facet + 1e-6), FACET_SHARE));
  }
  // How squarely the cell faces the sensor: the lattice is in the sensor's frame, looking down -Z (the lens is
  // narrow, so the axis stands in for each ray).
  vFacing = abs(normalize(lattice).z);
  vNormal = normalize(mat3(modelMatrix) * lit);
  // The surface without the facets: the liquid's own sheen is lit from this, so it ripples instead of sparkling.
  vSmooth = normalize(mat3(modelMatrix) * lattice);
  vView = cameraPosition - world.xyz;
  float above = mix(world.y - uMirrorPlane, uMirrorPlane - world.y, uMirror);
  float mirrorFade = mix(1.0, 0.35 * (1.0 - smoothstep(0.0, 0.9, above)) * step(0.0, above), uMirror);

  float depthT = clamp((d - uRamp.x) / max(uRamp.y - uRamp.x, 1e-3), 0.0, 1.0);
  vDepthT = depthT;
  vec3 royal = mix(uGlow, uBg, 0.68);
  vec3 colour = depthT < 0.5 ? mix(uWire, uGlow, depthT * 2.0) : mix(uGlow, royal, depthT * 2.0 - 1.0);
  if (uMode > 1.5 && uIsLight < 0.5) {
    // The demo's ramp (dark theme; cream keeps the token ramp, whose near end is ink), ice-white at the nearest surface, the wire and glow tokens through the middle, navy far.
    colour = depthT < 0.12 ? mix(vec3(1.0), uWire, depthT / 0.12)
      : depthT < 0.55 ? mix(uWire, uGlow, (depthT - 0.12) / 0.43) : mix(uGlow, royal, (depthT - 0.55) / 0.45);
  }
  vColor = max((colour - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
  // The crop fades in from CROP_FADE_FROM_M to CROP_FADE_M above uMinY (cubed, so the chest has all but gone where
  // the headline's label sits and the shoulders still read at the sides).
  float cropFade = smoothstep(uMinY + CROP_FADE_FROM_M, uMinY + CROP_FADE_M, world.y);
  vAlpha = ok * mix(1.0, 0.6, depthT) * scatterFade * mirrorFade
    * mix(1.0, cropFade * cropFade * cropFade, step(-999.0, uMinY));
  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), projectionMatrix * viewMatrix * world, ok);
}
`;
