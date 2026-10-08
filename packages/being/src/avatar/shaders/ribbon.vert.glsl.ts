/**
 * The ribbon's vertex stage: a gentle undulation along the tube's normal, world-space normal and view vector for
 * the fresnel and the highlight, and the mirror fade from the height above the reflecting plane before mirroring.
 */
export const ribbonVert = /* glsl */ `
uniform float uTime;
uniform float uWave;
uniform float uMirror;
uniform float uMirrorPlane;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vView;
varying float vFade;

void main() {
  vUv = uv;
  vec3 displaced = position + normal * (sin(uTime * 1.3 + uv.x * 25.0) * uWave);
  vec4 world = modelMatrix * vec4(displaced, 1.0);
  // Rotation and the mirror are orthogonal transforms, so the normal moves with the model matrix itself.
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - world.xyz;
  float above = mix(world.y - uMirrorPlane, uMirrorPlane - world.y, uMirror);
  vFade = mix(1.0, 0.35 * (1.0 - smoothstep(0.0, 0.9, above)) * step(0.0, above), uMirror);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;
