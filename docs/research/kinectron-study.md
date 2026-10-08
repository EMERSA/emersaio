# Kinectron study

Date: 2026-10-07. Synthesis of four research passes: Three-Kinectron, Kinectron itself, the three.js Kinect examples, and the minimalist redesign.

## What Kinectron is

- A Windows-only Electron app (the server) plus a browser client. They talk over WebRTC through PeerJS. The app runs its own PeerJS signalling server on port 9001, path "/", and joins as the fixed peer id "kinectron". No public PeerJS cloud, no STUN or TURN (iceServers is empty).
- Licence: MIT (repo root LICENSE). The npm client kinectron-client@1.0.1 says MIT but ships no LICENSE file.
- Current line: server 1.0.2 (2026-10-06, connection limit raised to 50) with client 1.0.1 (2025-05-11). Version 1 supports only the Azure Kinect. Version 0 (final 0.4.0, client 0.3.9 on jsDelivr only) supports Azure and Kinect v2 and is unmaintained.
- Azure Kinect DK sales ended in October 2023. A live sensor is optional for us; the GLB depth stays the dependable input.
- 1.x client API: `new Kinectron(host | {host, port, path, secure, role, config})`, `on('ready'|'error'|'stateChange'|'metrics')`, `isConnected`, `initKinect()` (a Promise with no timeout), `startDepth`, `startRawDepth`, `startDepthKey`, `startRGBD`, `startBodies`, `stopAll`, `close`. The server ignores `setKinectType` and `startMultiFrame`. There is no `makeConnection` in 1.x.
- The 1.x constructor connects by itself. The README's `peer.connect()` call is redundant. "ready" fires on every connection open, including after reconnects.
- `on()` is a Map.set: one handler per event, no `off()`. Colour, depth, key and RGBD all share one "frame" slot, so a client must not be shared.
- Any client's feed request restarts the cameras for everyone, `stopAll` stops everyone, and `initKinect` closes and re-opens the device for everyone. With "Block API Calls" on, the server drops every message except ping, so `initKinect` never settles.

Feeds and encodings (1.x, Azure; mm = depth in millimetres, g = 8-bit grey):

| Feed | Size, rate | Encoding | Notes |
|---|---|---|---|
| depth | 640x576, 15 fps, NFOV unbinned | g = floor(255 * (4000 - mm) / 3500), lossy WebP q90 | white = 0.5 m or no data, black = 4 m or more, 13.7 mm per level |
| rawDepth | 320x288, 15 fps, NFOV 2x2 binned | mm = (G << 8) or R, lossless WebP | client returns `depthValues: Uint16Array`, 0 = no data |
| depth-key | 320x288 | raw packing, A = 0 on background | needs the body tracker; client does not unpack it |
| rgbd | 512x512, WFOV 120x120 deg | RGB colour, A = floor(255 * (3000 - mm) / 2750) | read alpha without premultiplication |

Kinect v2 on the 0.x line is the odd one out: depth bytes are mm / 17 for 500..4500 mm and 0 otherwise, so black is near or no data. The 0.x rawDepth callback passes a bare number array, one frame late.

## Three-Kinectron in detail

- A tiny browserify plugin for three r89 (repo kinectron/Three-Kinectron, moved from juniorxsound). One class, two shaders, and an embedded 960x540 lossless WebP test frame that is 98% of its 510 KB dist. Its README says it is untested with Kinectron 1.0.0.
- Input: the "rgbd" feed, ONE RGBA image. RGB is colour registered to the depth grid, A is 8-bit depth. One UV reads both. Not side by side, not top and bottom (its ancestor DepthKit.js used top and bottom with hue-coded depth).
- Geometry: one shared `PlaneBufferGeometry(5, 4, 512, 424)`: 218,025 vertices, 434,176 triangles, Uint32 index. The vertex shader sets z = -alpha * displacement. x and y never move: a 2.5D extrusion with no intrinsics (its Kinect v2 intrinsics file is unused).
- Modes: "mesh" (triangles, every quad including stretched ones across depth jumps), "wire" (material.wireframe, 1 px lines only in WebGL, every edge duplicated plus diagonals, 2.6M line indices), "points" (Points through the triangle index, so interior vertices are drawn about 6 times, square and constant in pixels).
- Fragment: discard when colour red < 0.01; optional colour/depth mix; rgb = (c - 0.5) * contrast + 0.5 + brightness; alpha = opacity. Transparent, NormalBlending, depth test and write on, DoubleSide, unlit.
- Defaults in code: displacement 2.0 (README says 1.0), brightness 0, contrast 1, opacity 1, pointSize 1.
- Bugs: a new Texture every frame and never disposed (GPU leak); pause only skips the uniform swap; `update()` writes a missing `time` uniform and throws; all instances share one uniforms object; the README omits `new`.
- On Azure and all of 1.x, A is bright when near, so z = -a * d inverts the relief. It matched the 0.x Kinect v2 encoding (near dark).
- Bilinear sampling at texel edges smears depth across silhouettes. The README screenshot shows the rubber-sheet streaks this produces.

## The three.js Kinect examples

- The old example (timoxley fork, r52, 2012) and today's webgl_video_kinect share one vertex shader: d = (r + g + b) / 3; z = (1 - d) * (far - near) + near with near 850 and far 4000; X = (u - 0.5) * z * 1.11146, Y = (v - 0.5) * z * 0.83359 (58.1 x 45.3 deg). 640x480 points, pointSize 2, zOffset 1000.
- Old fragment: alpha = smoothstep(8000, -8000, eyeDistance), a fog fade from about 0.47 near to 0.19 far, normal blending, no depth write. Reversed smoothstep edges are undefined in GLSL; the portable form is 1 - smoothstep(-8000, 8000, d).
- New fragment: alpha 0.2, additive blending, no depth test or write. Overlaps glow and silhouettes brighten into a natural rim light. setPixelRatio makes pointSize 2 equal 1 CSS px at DPR 2.
- kinect.webm is NOT grey. It is a white, cyan, blue, black ramp from mr.doob's modified libfreenect glview.c, screen-recorded with ffmpeg. (r + g + b) / 3 recovers about 768 levels. Our shaders read only `.r`, which would treat everything past about 0.7 m as no data.
- kinect.webm: 4 MB, VP8, 512x512, 34.4 s, about 14.9 fps effective (2011). kinect.mp4: 4.1 MB, H.264, 474x490 (2019, for Safari).
- The rendered canon is a cyan and azure additive cloud on black (73% of lit pixels blue-dominant). That is our navy, azure and ice palette.

## Making synthetic depth look like a Kinect capture

Our depth comes from the GLB through the main camera, so every artefact lines up with the viewer's own rays and stays invisible. The recipe, agreed across reports:

1. Decouple a fixed sensor camera from the view camera: about 0.9 to 1.2 m from the face, 5 to 10 deg below the eye line. The view gets eased pointer parallax; the design report says at most 6 deg, the canon report 6 to 10 deg. Use 6.
2. Sensor clock: re-render the depth pass only when floor(t * 30) changes. Freeze it under reduced motion.
3. Integer PCG hash keyed on (cell, frame, salt). No fract(sin()) with growing time.
4. Quantise in disparity space: uFB = 43.19 px m, 1/8 px steps, giving 2.9 mm at 1 m and 4.5 mm at 1.25 m. Dither about 30% of points between adjacent steps. Cap the step at 10 mm in the full-figure framing.
5. A four-neighbour gradient gives a facing term; a relative jump of 3 to 5% of distance marks a discontinuity. Replace the flat JUMP_M = 0.12 m in the wire grid with this.
6. Drop points only at grazing angles and discontinuities. Crossfade the dropout mask at about 10 Hz rather than strobing. Never drop on the eyes or mouth. Keep flicker small-area (WCAG 2.3.1).
7. Optional time-of-flight flavour: 1 to 2% of edge points pushed back up to 2 cm at 0.35 alpha. Skip IR shadows on a standalone face (under one cell).
8. Fixed x-only jitter of 0.3 cell so rows read as scan lines without moire. Keep projected spacing at 1.5 px or more.
9. Points: size max(1, 1.6 css px * dpr * refDist / dist), soft round disc. Ramp ice near, azure mid, navy (close to the background) far. Alpha about 0.16 * mix(1, 0.4, depthT). Additive or screen blending in dark, normal in light.
10. Avoid: curtain triangles, face holes, whole-frame jitter, a 15 fps scene, rainbow depth, compression blocks, white blow-out, sensor-frame edges.

Conflict: the design report's ramp is ice #cfe4f2, azure #2896dd, royal #0e5ba4; the canon report mapped it to today's tokens #e8f4ff and #8fd3ff. The new design tokens win.

## Licences and what we may ship

| Source | Licence | Our use |
|---|---|---|
| Three-Kinectron | none (all rights reserved) | read only; copy no code, GLSL, test frame or images |
| Kinectron server and client | MIT | dev-only client; if self-hosted, keep the repo MIT text plus PeerJS (MIT), webrtc-adapter (BSD-3), sdp, eventemitter3, binarypack (MIT), msgpack (ISC) |
| DepthKit.js | MIT | edge and blob filter ideas may be adapted with attribution; do not reuse its demo capture |
| three.js examples, kinect.webm and kinect.mp4 | MIT (no separate asset licence) | dev fixture only; never in production |
| House of Cards data | CC BY-NC-SA 3.0 | not usable (non-commercial) |
| Amaterasu, Igloo Inc | proprietary | visual reference only |

ADR-0005's no-copy decision stands. Production ships no Kinectron code; the client stays under /dev with the self-only CSP.

## Corrections to our KinectronDepthSource

File: packages/being/src/data/depth/KinectronDepthSource.ts (and the dev harness type in apps/web/src/scripts/kinect-harness.ts).

1. Never call `peer.connect()`. If `isConnected()`, start now; otherwise register `on('ready')` and `on('error')`.
2. Make onReady idempotent; re-request the feed on every "ready".
3. Request the feed at once. Only if no frame arrives within 2 s, race `initKinect()` against a 5 s timeout, then request again. Expose `autoInit`.
4. 1.x is Azure only: coerce kinectType and warn once for "windows". On 0.x call setKinectType before makeConnection.
5. Format errors as `detail?.error ?? detail?.message ?? String(detail)`.
6. Accept 0.x raw frames as a bare array or typed array; take the size from the sensor.
7. Warn once on 1.x raw error frames.
8. Initial size by (type, feed): Azure depth 640x576, Azure raw and depth-key 320x288, Kinect v2 512x424.
9. Depth feed calibration: Azure is 0.5 to 4.0 m, not 0.85 to 4. Preferred: decode g to mm (4000 - (g + 0.5) * 13.725; 255 is a miss) and re-encode against the source's clipping like the raw path.
10. Kinect v2 0.x depth is inverted: mm = 17 * g, g = 0 is a miss.
11. Widen the constructor config type; pass a plain host string to 0.x. For ngrok use the bare ngrok-free.app host.
12. dispose: stopAll only if this source requested the feed; close only a client it constructed; dispose the texture.
13. Document exclusive ownership of the client (single-slot events).
14. Remove the dead `imagedata` field and string branch; read `frame.src` only.
15. Fix the runbook: release date 2026-10-06, no LICENSE in the npm tarball, no peer.connect().
16. Do not rely on multiFrame, infrared or tracked-body feeds in 1.x.

Also: prefer rawDepth for a face and keep it in a float texture (8-bit over 0.85 to 4 m is 12.4 mm per level, about 8 levels across a face). Decode grey as (r + g + b) / 3 in both vertex shaders. Correct the "grey video" wording in ADR-0005, VideoDepthSource.ts and the dev README. Fix the reversed smoothstep in hero-cloud/cloud.vert.glsl.ts line 51. Fix the KINECT_DEFAULTS comment (Three-Kinectron's code uses displacement 2.0; ours means something else).

Tests to add: no connect call; repeated ready; hung initKinect still requests the feed; error object formatting; 0.x array frame; raw error frame; 0.5 to 4.0 m calibration; inverted Kinect v2 depth; close only for self-built clients. Use our own synthetic frames only.

## Sources

- https://github.com/kinectron/Three-Kinectron (src/kinectGeometry.js, src/shaders, src/util, README, examples/simple.html)
- https://api.github.com/repos/kinectron/Three-Kinectron (license null)
- https://github.com/kinectron/kinectron (app/main/processors, handlers, kinectController.js; client/src; LICENSE; releases 0.4.0, 1.0.0, 1.0.1, v1.0.2)
- https://registry.npmjs.org/kinectron-client
- https://raw.githubusercontent.com/kinectron/kinectron.github.io/main/docs/README.md
- https://raw.githubusercontent.com/timoxley/threejs/master/examples/webgl_kinect.html
- https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/webgl_video_kinect.html and examples/textures/kinect.nfo
- https://gist.github.com/mrdoob/1326080 and https://gist.github.com/mrdoob/1325393
- https://github.com/juniorxsound/DepthKit.js
- https://github.com/wouterverweirder/kinect2 and https://github.com/wouterverweirder/kinect-azure
- https://learn.microsoft.com/en-us/previous-versions/azure/kinect-dk/hardware-specification and depth-camera
- https://pmc.ncbi.nlm.nih.gov/articles/PMC3304120/ (Khoshelham and Oude Elberink 2012)
- https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html
- https://www.awwwards.com/sites/amaterasu and https://www.awwwards.com/sites/igloo-inc
