/**
 * The data ring: a circle of points around the figure, each pushed outward and upward by the audio band it sits
 * on. The spectrum is mirrored around the ring so the low bands face the camera on both sides. Half mode parks
 * every second point outside the clip volume, which halves the rasterised points without touching the geometry.
 */
export const ringVert = /* glsl */ `
uniform float uBands[32];
uniform float uTime;
uniform float uPointSize;
uniform float uCount;
uniform float uHalf;
uniform float uBoost;

varying float vEnergy;

void main() {
  float t = float(gl_VertexID) / uCount;
  float band = abs(fract(t) * 2.0 - 1.0) * 31.0;
  int i0 = int(band);
  int i1 = min(i0 + 1, 31);
  float energy = mix(uBands[i0], uBands[i1], fract(band));
  // A quiet ring still breathes so it never reads as frozen.
  energy = max(energy, 0.05 + 0.04 * sin(uTime * 1.3 + t * 25.1327));
  energy *= uBoost;

  vec3 outward = normalize(vec3(position.x, 0.0, position.z));
  vec3 displaced = position + outward * energy * 0.16 + vec3(0.0, energy * 0.1, 0.0);
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);

  float odd = mod(float(gl_VertexID), 2.0);
  float keep = 1.0 - uHalf * odd;

  gl_Position = mix(vec4(2.0, 2.0, 2.0, 1.0), projectionMatrix * mvPosition, keep);
  gl_PointSize = keep * (uPointSize * (0.6 + 1.6 * energy)) / max(-mvPosition.z, 0.1);
  vEnergy = energy;
}
`;
