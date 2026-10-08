# ADR-0005: The Kinect cloud and its depth sources

Status: accepted, 2026-10-07. Replaces the depth echo that ADR-0002 describes; the rest of ADR-0002 stands.

## Context

The user asked for the look of a Kinect point cloud on the being (the mood board: a face dissolving into
particles and lines of data) and for a Kinectron path, so that a real Kinect can one day feed the same cloud.

Until now the figure's only data effect was the depth echo: the being's depth buffer read back once more and
drawn behind the figure, a full extra pass that was off on touch devices. three's `webgl_video_kinect` example
does more with the same ingredients: a regular grid of points, each reading a depth texture at its own cell and
placed along the camera ray at that depth, with `2 * tan(fov / 2)` per axis turning the cell offset into metres.
Its input is a grey depth video of the first Kinect, white near and black far.

Two ready-made pieces were looked at. Kinectron (github.com/kinectron/kinectron) is an Electron app that
broadcasts Kinect frames to browsers over PeerJS; it and its browser client `kinectron-client` are MIT.
Three-Kinectron (github.com/kinectron/Three-Kinectron) draws Kinectron feeds in three.js, but on 2026-10-07 it
had no LICENSE file, no `license` field in its package.json and GitHub listed no licence for it, and it targets
three 0.89 from 2017 against our 0.186. Without a licence there is no permission to copy, so none of its code
was used; its example was read for the shape of the client API only.

Constraints: the three chunk stays under 195 KB gzipped and the being under 30 KB; colours come only from the
tokens; every motion respects reduced motion; the cloud must also run on phones; the production CSP allows
scripts from our own origin only, so no client library may be fetched from a CDN.

## Decision

- Our own implementation of the technique: `packages/being/src/data/KinectCloud.ts` with the shaders in
  `avatar/shaders/kinect.*.glsl.ts`. The maths (back-projection, the two depth encodings, hit tests, scatter,
  mirror fade, the scan band) lives free of three.js in `data/depth/depthMath.ts`, where `node --test` checks it,
  and the shaders are its GLSL twins.
- A `DepthSource` interface (`texture`, `width`, `height`, `ready`, `kind`, `fovTangents`, optional
  `setClipping`, `update`, `dispose`) with three sources behind it, exported from `@emersa/being/depth`.
  `BeingDepthSource` renders the meshes that cast the cloud through the main camera into a small depth texture
  on a layer of their own, so the cloud lands exactly on the figure and follows morphs and bones.
  `VideoDepthSource` plays a grey depth video, the example's own input. `KinectronDepthSource` takes a Kinectron
  client the page constructs (the processed depth image, or the raw 16-bit depth encoded to grey against the
  clipping) and fails soft to "never ready" with one console warning when there is no client or no sensor.
- Three looks, switched with layers: `hybrid` (wire head, cloud body; the default), `kinect` (all cloud) and
  `wire` (the old look). A stage under 260 px tall draws the wire whatever the look says.
- The grid is 320 x 240 points in the full tier and 160 x 120 below it, where touch devices start. Point size
  falls with distance and scales with the canvas height, the colour ramps from `--dot` to `--wire` with depth,
  the scatter follows the token meter, and the scan band parks under reduced motion.
- The Kinectron client is neither bundled nor fetched from a CDN. The runtime types the slice of it it needs as
  the structural `KinectronClient` interface; the dev harness page at `/dev/kinect` loads a local copy of the MIT
  client from our own origin under `astro dev`, and `scripts/postbuild.mjs` deletes every `dist/dev*` page after
  a build, with `scripts/preflight.mjs` failing the build if one survives (`docs/runbooks/kinectron.md`).
- The same change gave the stage its product-shot setting (the ribbon, the floor reflection, the rim light and
  rays), documented in `docs/CONVENTIONS.md`; this record is about the cloud.

## Consequences

- The echo pass is gone. The cloud costs one depth pass at grid resolution plus one `Points` draw, cheap enough
  to run on phones at the reduced grid, which the echo never did.
- The cloud's density no longer depends on the GLB: the decimated body has 7,998 triangles and the full grid
  76,800 cells, so the model stays within its 600 KB budget and still reads as a Kinect scan.
- Anything that produces a depth image can drive the figure: the being itself, a recording or a live sensor,
  through `options.depthSource` or `handle.setDepthSource()`. The caller owns and disposes external sources.
- Nothing has been tested against a real sensor. The 1.x client sequence, the 0.x queueing of feed requests and
  the millimetre unit of raw frames are assumptions written in the `KinectronClient` doc comment, and the grey
  scaling of Kinectron's processed depth image is unknown; `handle.kinect.setClipping()` tunes it.
- The WebGL classes (`KinectCloud`, `BeingDepthSource`, `Ribbon`, `FloorReflection`, `Backdrop`) have no unit
  tests; the maths, the quality ladder and the Kinectron fail-soft paths do, and `tests/browser/gpu-look.mjs` and
  `pixels.mjs` check the result on a real GPU.
- The combined three and being chunk sits within 1 KB of the 185 KB warning in `scripts/bundle-budget.mjs`;
  further growth triggers the warning (not a failure) and should be paid for elsewhere.
- ADR-0002 still holds: everything is WebGL and GLSL, and a WebGPU or TSL port would now have to rewrite the
  cloud, the ribbon and the glow shaders as well as the wire.
