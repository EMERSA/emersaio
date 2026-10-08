/**
 * Vertex stage of the hero point cloud. Every point carries a seed, so drift, scatter and sparkle differ per point
 * while the whole animation stays a pure function of time and a handful of uniforms: no per-frame CPU work.
 */
export const cloudVert = `#version 300 es
precision highp float;

in vec3 aPosition;
in float aSeed;

uniform float uTime;
uniform float uScatter;
uniform float uYaw;
uniform vec2 uPointer;
uniform float uPointerOn;
uniform float uTokens;
uniform vec2 uCenter;
uniform vec2 uScale;
uniform float uAspect;
uniform float uSize;
uniform vec3 uOffset;

out float vAlpha;
out float vSpark;

void main() {
  // Positions arrive as int16 metres * 10000; the offset moves the figure's bounding box onto the origin.
  vec3 p = aPosition * 0.0001 + uOffset;
  float phase = aSeed * 6.2831853;

  // Idle drift on three incommensurate frequencies, so the cloud breathes instead of pulsing in step.
  p += 0.012 * vec3(sin(uTime * 0.7 + phase), cos(uTime * 0.53 + phase * 2.0), sin(uTime * 0.61 + phase * 3.0));

  // Dissolve: each point leaves along its own direction from the centre, high seeds first and furthest.
  vec3 away = normalize(p + 0.3 * vec3(sin(phase * 3.0), cos(phase * 5.0), sin(phase * 7.0)));
  float scatter = uScatter * uScatter;
  p += away * scatter * (0.8 + aSeed * 1.6);

  // A slow yaw gives the flat screen a hint of the figure's volume.
  float c = cos(uYaw);
  float s = sin(uYaw);
  p = vec3(p.x * c + p.z * s, p.y, p.z * c - p.x * s);

  // Camera three metres in front: a mild perspective so the nearer points read slightly larger.
  float persp = 3.0 / (3.0 - p.z);
  vec2 ndc = uCenter + p.xy * uScale * persp;

  // Pointer repulsion measured in circular screen units (clip space is stretched by the aspect ratio).
  vec2 d = (ndc - uPointer) * vec2(uAspect, 1.0);
  float r = length(d);
  // Reversed smoothstep edges are undefined in GLSL; this is the portable form of the same falloff.
  float push = uPointerOn * (1.0 - smoothstep(0.0, 0.42, r)) * 0.12;
  ndc += (d / max(r, 0.001)) * push / vec2(uAspect, 1.0);

  // Sparkle: a few points twinkle at rest; arriving tokens make many more flash, and brighter.
  float twinkle = smoothstep(0.86, 1.0, fract(aSeed * 61.7 + uTime * (0.3 + aSeed * 0.9)));
  float flash = uTokens * smoothstep(0.65, 1.0, fract(aSeed * 23.3 + uTime * 2.5));
  vSpark = clamp(twinkle * 0.6 + flash, 0.0, 1.0);

  vAlpha = (1.0 - uScatter * 0.95) * (0.35 + 0.65 * aSeed) * (0.7 + 0.3 * persp);
  gl_PointSize = uSize * persp * (1.0 + vSpark * 1.6);
  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;
