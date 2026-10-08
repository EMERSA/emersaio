/**
 * Vertex stage of the wire being. The chunk order is load-bearing: three injects USE_SKINNING and USE_MORPHTARGETS
 * for a ShaderMaterial drawn on a skinned, morphing mesh, and the skin and morph chunks expect the same
 * `transformed` variable and bone matrices the built-in materials use. Barycentrics come from gl_VertexID because
 * loadAvatar makes the geometry non-indexed: every three consecutive vertices are one triangle, which is also what
 * makes a triangle one rigid piece under uShatter. The mirrored draw below the reflecting plane (FloorReflection)
 * raises uMirror and fades with the height above that plane of the vertex it reflects.
 */
export const wireVert = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>

uniform float uMirror;
uniform float uMirrorPlane;
uniform float uShatter;

varying vec3 vBary;
varying float vSeed;
varying float vFade;

float hashId(float n) {
  return fract(sin(n * 12.9898) * 43758.5453);
}

void main() {
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>

  // One seed per triangle, so a sparkle lights a whole face instead of a gradient across it, and so the three
  // corners fly together: while uShatter is up each triangle leaves along its own hashed direction, at its own
  // reach, after skinning, so the pieces come from where the face is now and not from the bind pose.
  float tri = float(gl_VertexID / 3);
  vSeed = hashId(tri);
  vec3 dir = normalize(vec3(hashId(tri + 0.37), hashId(tri + 0.73), hashId(tri + 1.19)) * 2.0 - 1.0 + 1e-3);
  transformed += dir * (0.15 + 0.35 * hashId(tri + 2.41)) * uShatter;
  #include <project_vertex>

  // The height above the reflecting plane before mirroring: the model matrix of a mirrored proxy already holds the
  // flip. Nothing below the plane is reflected.
  float wy = (modelMatrix * vec4(transformed, 1.0)).y;
  float above = mix(wy - uMirrorPlane, uMirrorPlane - wy, uMirror);
  vFade = mix(1.0, 0.35 * (1.0 - smoothstep(0.0, 0.9, above)) * step(0.0, above), uMirror);

  int corner = gl_VertexID - 3 * (gl_VertexID / 3);
  vBary = vec3(corner == 0 ? 1.0 : 0.0, corner == 1 ? 1.0 : 0.0, corner == 2 ? 1.0 : 0.0);
}
`;
