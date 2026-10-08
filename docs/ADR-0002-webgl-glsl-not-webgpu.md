# ADR-0002: WebGL and GLSL, not WebGPU and TSL

Status: accepted, 2026-10-07. Revisit in Phase 3. The depth echo named below became the kinect cloud of ADR-0005,
drawn with the same WebGL and GLSL; the decision stands.

## Context

three 0.186 ships `WebGPURenderer` with a WebGL2 fallback and the TSL node material system. The being's look
depends on one custom material: a barycentric wireframe drawn on the real skinned, morphing head mesh, with
vertex dots, a glow halo and a sparkle driven by the token rate. That material needs three's own vertex chunks
(`morphtarget_vertex`, `skinning_vertex`) inside a hand-written shader so the wire deforms with speech and bones.

`WebGPURenderer` does not accept `ShaderMaterial` and does not run `onBeforeCompile`; the effect would have to be
rewritten as TSL nodes. The depth "data echo" reads the being's own depth buffer back through a
`WebGLRenderTarget` with a `DepthTexture`, exactly as the `webgl_video_kinect` example does, and the bloom is
`UnrealBloomPass`, which is a WebGL post-processing pass. WebGPU availability in 2026 is uneven across Safari and
Firefox, and the site must run on an iPhone 12 and a Pixel 6a.

## Decision

- `WebGLRenderer` with GLSL `ShaderMaterial` for the wire (`WireBeingMaterial`), the echo and the data ring.
- `EffectComposer` with `RenderPass`, `UnrealBloomPass` and `OutputPass` on hover-capable desktops only.
- Shader sources are kept as `.glsl.ts` strings next to the material that owns them, so a later port can map
  them chunk by chunk.
- The hero cloud before three loads is raw WebGL2 with no library at all (under 7 KB).

## Consequences

- One rendering path to test on every device class; no feature detection ladder between two renderers.
- Bloom and the echo cost a full extra pass each, so both are off on touch devices and the quality ladder
  drops them first.
- No compute shaders for the point cloud; 12k points on the CPU side is well within budget.
- A WebGPU or TSL port is a rewrite of the material, the echo and the composer chain, which is why it is a
  Phase 3 investigation and not a flag.
