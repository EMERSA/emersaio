/**
 * The kinect cloud, after three's webgl_video_kinect example with the Kinect fidelity recipe of
 * docs/research/kinectron-study.md on top: one point per grid cell, the depth sample gives the distance along the
 * cell's ray and uTangents (2 * tan(fov / 2) per axis) turn the cell offset into metres there. uEncoding picks the
 * decode: 0 reads a perspective depth buffer of the being itself, rendered from a fixed sensor camera, 1 reads grey
 * as linear depth between the clipping planes ((r + g + b) / 3, so the three example's white-cyan-blue-black ramp
 * decodes as well as a true grey), 2 reads metres from a float texture (Kinectron). The Points object carries the
 * sensor camera's transform, so the cloud lands in world space wherever that camera is.
 *
 * The recipe (JavaScript twins and the numbers in data/depth/depthMath.ts): an integer PCG hash keyed on (cell,
 * sensor frame, salt); disparity quantisation with 30 percent of points dithered to a neighbouring step; a relative
 * discontinuity cut of 4 percent of the distance and a facing term from the four neighbours; stochastic dropout at
 * grazing angles and jumps, crossfaded at 10 Hz and masked off the eyes and the mouth; a fixed x-only jitter of 0.3
 * cell; a point size of max(1, 1.6 css px * dpr * refDist / dist); a ramp from the wire token (near) through the
 * glow token to a deep royal fading into the page (far), thinning to 0.4 of its alpha at the far end.
 */
export const kinectVert = /* glsl */ `
#include <packing>

uniform sampler2D uDepth;
uniform vec2 uGrid;
uniform float uNear;
uniform float uFar;
uniform float uEncoding;
uniform vec2 uTangents;
uniform float uPointScale;
uniform float uZOffset;
uniform float uScatter;
uniform vec2 uRamp;
uniform float uMirror;
uniform float uMirrorPlane;
uniform float uDisplacement;
uniform float uBrightness;
uniform float uContrast;
uniform float uFrame;
uniform float uDropFrame;
uniform float uDropMix;
uniform float uQuantise;
uniform vec4 uMaskA;
uniform vec4 uMaskB;
uniform float uMinY;
uniform vec3 uDot;
uniform vec3 uWire;
uniform vec3 uGlow;
uniform vec3 uBg;

varying vec3 vColor;
varying float vAlpha;

const float FB = 43.19;
const float SUBPX = 8.0;
const float MAX_STEP_M = 0.01;
const float DITHER_SHARE = 0.3;
const float JUMP_SHARE = 0.04;
const float FACING_DROP = 0.45;
const float JITTER_CELLS = 0.3;

uint pcg(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

float hash01(uint cell, uint frame, uint salt) {
  return float(pcg(pcg(pcg(cell) + frame) + salt)) / 4294967295.0;
}

float distanceAt(vec2 uv) {
  vec4 texel = texture2D(uDepth, uv);
  if (uEncoding < 0.5) {
    return texel.r < 0.9999 ? -perspectiveDepthToViewZ(texel.r, uNear, uFar) : -1.0;
  }
  if (uEncoding < 1.5) {
    float grey = dot(texel.rgb, vec3(1.0 / 3.0));
    return (grey > 0.02 && grey < 0.98) ? (1.0 - grey) * (uFar - uNear) + uNear : -1.0;
  }
  return (texel.r >= uNear && texel.r <= uFar) ? texel.r : -1.0;
}

float quantise(float z, float dither) {
  float stepM = z * z / (FB * SUBPX);
  if (stepM > MAX_STEP_M) return floor(z / MAX_STEP_M + 0.5 + dither) * MAX_STEP_M;
  float q = floor(FB / z * SUBPX + 0.5 + dither);
  return q > 0.0 ? FB * SUBPX / q : z;
}

float gradient(float lo, float hi, float d, float w) {
  if (lo > 0.0 && hi > 0.0) return (hi - lo) / (2.0 * w);
  if (hi > 0.0) return (hi - d) / w;
  if (lo > 0.0) return (d - lo) / w;
  return 0.0;
}

float jumpTo(float n, float d) {
  return n > 0.0 ? step(JUMP_SHARE * min(n, d), abs(n - d)) : 0.0;
}

void main() {
  float index = float(gl_VertexID);
  uint cellId = uint(gl_VertexID);
  uint frame = uint(max(uFrame, 0.0));
  vec2 cell = vec2(mod(index, uGrid.x), floor(index / uGrid.x));
  vec2 texel = 1.0 / uGrid;
  vec2 uv = (cell + 0.5) * texel;
  float d0 = distanceAt(uv);
  float hit = step(0.0, d0);
  float dSafe = max(d0, 0.1);

  float dl = distanceAt(uv - vec2(texel.x, 0.0));
  float dr = distanceAt(uv + vec2(texel.x, 0.0));
  float dd = distanceAt(uv - vec2(0.0, texel.y));
  float du = distanceAt(uv + vec2(0.0, texel.y));
  vec2 cellM = dSafe * uTangents * texel;
  float gx = gradient(dl, dr, dSafe, cellM.x);
  float gy = gradient(dd, du, dSafe, cellM.y);
  float facing = inversesqrt(1.0 + gx * gx + gy * gy);
  float jump = max(max(jumpTo(dl, dSafe), jumpTo(dr, dSafe)), max(jumpTo(dd, dSafe), jumpTo(du, dSafe)));

  float dither = step(hash01(cellId, frame, 1u), DITHER_SHARE) * (hash01(cellId, frame, 2u) - 0.5);
  float dist = uQuantise > 0.5 ? quantise(dSafe, dither) : dSafe;
  float centre = 0.5 * (uRamp.x + uRamp.y);
  dist = centre + (dist - centre) * uDisplacement;

  float jitter = (hash01(cellId, 0u, 3u) - 0.5) * JITTER_CELLS * texel.x;
  vec2 ray = uv + vec2(jitter, 0.0) - 0.5;
  vec3 pos = vec3(ray.x * dist * uTangents.x, ray.y * dist * uTangents.y, -dist + uZOffset);

  float h1 = hash01(cellId, 0u, 5u);
  float h2 = hash01(cellId, 0u, 6u);
  float h3 = hash01(cellId, 0u, 7u);
  vec3 dir = normalize(vec3(h1, h2, h3) * 2.0 - 1.0 + 1e-3);
  float travel = uScatter * (0.3 + 0.7 * h3) * 0.35;
  pos += dir * travel;
  float scatterFade = 1.0 - smoothstep(0.0, 0.35, travel) * 0.8;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  hit *= step(uMinY, world.y);

  float protectA = 1.0 - smoothstep(uMaskA.w * 0.7, uMaskA.w, distance(world.xyz, uMaskA.xyz));
  float protectB = 1.0 - smoothstep(uMaskB.w * 0.7, uMaskB.w, distance(world.xyz, uMaskB.xyz));
  float candidate = max(step(facing, FACING_DROP), jump) * (1.0 - max(protectA, protectB));
  float dropP = mix(0.3, 0.7, 1.0 - facing);
  uint dropFrame = uint(max(uDropFrame, 0.0));
  float dice = mix(hash01(cellId, dropFrame, 4u), hash01(cellId, dropFrame + 1u, 4u), uDropMix);
  float keep = mix(1.0, smoothstep(dropP - 0.12, dropP + 0.12, dice), candidate);

  float above = mix(world.y - uMirrorPlane, uMirrorPlane - world.y, uMirror);
  float mirrorFade = mix(1.0, 0.35 * (1.0 - smoothstep(0.0, 0.9, above)) * step(0.0, above), uMirror);
  vec4 mvPosition = viewMatrix * world;

  float depthT = clamp((dist - uRamp.x) / max(uRamp.y - uRamp.x, 1e-3), 0.0, 1.0);
  vec3 royal = mix(uGlow, uBg, 0.55);
  vec3 colour = depthT < 0.5 ? mix(uWire, uGlow, depthT * 2.0) : mix(uGlow, royal, depthT * 2.0 - 1.0);
  vColor = max((colour - 0.5) * uContrast + 0.5 + uBrightness, 0.0);
  vAlpha = hit * keep * mix(1.0, 0.4, depthT) * scatterFade * mirrorFade;

  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), projectionMatrix * mvPosition, hit);
  gl_PointSize = hit * max(1.0, uPointScale / max(-mvPosition.z, 0.05));
}
`;
