/**
 * The data fan: fine lines from points on the face to small ice nodes, with packets travelling along them only
 * while the being speaks. Each line is two vertices that share the head point in `position` (bind-pose world
 * space, moved by the head bone's delta in uHead); aEnd picks the face end or the node end, and the node comes from
 * the uTargets array by the line's number. The nodes are point sprites at the same targets. At rest the lines are
 * static and faint; nothing here moves until uActivity rises.
 */
export const fanLineVert = /* glsl */ `
uniform mat4 uHead;
uniform vec3 uTargets[8];
uniform float uCount;

attribute float aEnd;
attribute float aLine;

varying float vT;
varying float vSeed;

void main() {
  vec3 start = (uHead * vec4(position, 1.0)).xyz;
  vec3 end = uTargets[int(mod(aLine, max(uCount, 1.0)))];
  vT = aEnd;
  vSeed = fract(aLine * 0.618034);
  gl_Position = projectionMatrix * viewMatrix * vec4(mix(start, end, aEnd), 1.0);
}
`;

export const fanLineFrag = /* glsl */ `
uniform vec3 uFan;
uniform float uTime;
uniform float uActivity;
uniform float uFlow;
uniform float uOpacity;
uniform float uIsLight;
uniform float uLineAlpha;

varying float vT;
varying float vSeed;

void main() {
  float line = uLineAlpha * mix(1.2, 0.8, vT) * mix(1.0, 1.5, uIsLight);
  float phase = fract(vT * 3.0 - uTime * (0.3 + 0.9 * uActivity) * uFlow + vSeed);
  float packet = smoothstep(0.88, 0.97, phase) * (1.0 - smoothstep(0.97, 1.0, phase)) * uActivity * uFlow;
  float alpha = (line + 0.6 * packet) * uOpacity;
  gl_FragColor = vec4(mix(uFan, vec3(1.0), 0.5 * packet), min(alpha, 1.0));
  #include <colorspace_fragment>
}
`;

export const fanNodeVert = /* glsl */ `
uniform float uPointSize;

void main() {
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
  gl_PointSize = uPointSize;
}
`;

/** A small solid ice dot with a soft edge; it brightens a little while data flows and does not pulse. */
export const fanNodeFrag = /* glsl */ `
uniform vec3 uFan;
uniform vec3 uWire;
uniform float uActivity;
uniform float uOpacity;
uniform float uIsLight;

void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(0.7, 1.0, d);
  float alpha = disc * mix(0.85, 1.0, uActivity) * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(mix(uFan, uWire, 0.75), alpha);
  #include <colorspace_fragment>
}
`;
