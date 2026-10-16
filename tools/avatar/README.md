# The guide figure and the baked tour

Everything under `tools/avatar/` produces four kinds of asset for the site:

| Output | Produced by | Contract |
| --- | --- | --- |
| `apps/web/src/assets/being/guide.glb` (<= 600 KB) and `guide-lite.glb` (<= 250 KB) | `build.py` (Blender) then `build.mjs` (gltf-transform) | one skinned humanoid, Y up, 1.75 m, feet at y=0, facing +Z, meshes `Head` (74 morphs, with the teeth and tongue) and `Body`, which meet exactly on one seam loop around the neck, both with the `_SCULPT` vertex attribute; Mixamo bone names, the eye bones carrying `extras.eyeRadius`; clip `Idle` plus `Nod`, `PointLeft`, `PointRight`, `Wave`; meshopt-compressed, no materials |
| `apps/web/src/assets/being/cloud-12k.bin` and `cloud-6k.bin` | `sample-points.mjs` | EMCL point clouds sampled from the skin of `guide.glb` |
| `apps/web/src/assets/tour/<id>.mp3` and `<id>.json` for every stop in `apps/web/src/content/tour/*.yaml` | `bake-tour.mjs` | mono MP3 at 48 kbps (<= 90 KB each) and `{ durationMs, visemes: [[offsetMs, visemeId, weight], ...] }` |
| `tables/morphs.json` and `tables/rig.json` | `build.mjs` | the morph, bone and clip names actually present in `guide.glb` |

Run the whole chain from the repository root:

```sh
"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" -b --python tools/avatar/build.py
node tools/avatar/build.mjs && node tools/avatar/sample-points.mjs
npm ci --prefix tools/avatar && node tools/avatar/bake-tour.mjs
```

The Blender step is only needed when the figure itself changes; its outputs (`src/guide-raw.glb`,
`src/guide-lite-raw.glb`, `src/build-report.json`) are committed so the three Node scripts run on any machine. It
takes about 8 seconds and is deterministic: the same inputs give byte-identical raw GLBs. `build-report.json`
records what every stage did (the split, each decimation pass, the morph transfer, the seam checks, the `_SCULPT`
masks and the eye measurements).

`build.mjs` and `sample-points.mjs` need only the root install (`@gltf-transform/*` and `meshoptimizer`).
`bake-tour.mjs` also needs the voice stack (`kokoro-js`, `@huggingface/transformers` with its ONNX runtime, and
the `@breezystack/lamejs` encoder), which lives in `tools/avatar/package.json` with its own lockfile, outside the
npm workspaces, and is installed with `npm ci --prefix tools/avatar` on the authoring machine only. The root
`npm ci` that CI and Workers Builds run therefore never downloads the 200 MB runtime, and never runs its install
script (which on Linux x64 fetches a CUDA build from GitHub releases and fails the install when that download
fails). Node resolves the two sets side by side: the voice packages from `tools/avatar/node_modules`, everything
else from the root.

## The figure: which path was taken and why

The preferred path from the plan worked, so there is no procedural fallback figure in this repository.

1. **MPFB 2.0.10** (GPL-3.0-or-later, by Joel Palmius and the MakeHuman community) installs headlessly from
   extensions.blender.org into Blender 4.2 with `blender -b --command extension install mpfb` (the catalogue
   serves the 2.0.x line that supports 4.2 LTS). `build.py` enables it through the preferences operator at run
   time; the install itself is a one-off that needs online access.
2. **The base mesh** is MPFB's bundled MakeHuman base mesh (`data/3dobjs/base.obj`), which the MakeHuman project
   publishes under **CC0**. `build.py` creates a female figure (`gender 0.0`, `proportions 0.5`, every other
   macro at the default 0.5), bakes the macro targets into the mesh, scales it uniformly to 1.75 m and puts the
   feet on the ground.
3. **Face targets** come from two MakeHuman community packs contributed by Mika Suominen:
   `faceunits01.zip` (52 ARKit face units, 0.2 MB) and `visemes01.zip` (the 22 Microsoft visemes, with the
   id in each file name such as `p_b_m_21.target`, 0.2 MB). Mirrors:
   `https://files2.makehumancommunity.org/functional/<pack>.zip` and
   `https://files.makehumancommunity.org/functional/<pack>.zip`. The asset index
   (`http://static.makehumancommunity.org/assets/assetpacks.html`) lists both as "shared under CC0", and every
   target inside the packs carries `"license": "CC0"` in `packs/<pack>.json`; `build.py` downloads them into
   the gitignored `tools/avatar/cache/` and refuses to build if any target declares another licence.
   The visemes become shape keys `viseme_00` to `viseme_21`; the face units keep their ARKit names.
4. **The rig** is MPFB's built-in Mixamo-named game rig with its weight file; `build.py` strips the
   `mixamorig:` prefix and adds `LeftEye` and `RightEye` as leaf bones under `Head` at the eyeball centres
   from the base mesh's joint helpers. No eyeball geometry ships: `build.py` measures MakeHuman's helper
   eyeballs from those bones (radius 16.6 mm, the median distance from the bone to the helper's vertices; the
   cornea reaches 17.0 mm) and `build.mjs` stores it on both bones as `extras.eyeRadius`, which three.js exposes
   as `bone.userData.eyeRadius`, so the runtime can draw its own eyeballs there.
5. **Surgery** (`blender/topology.py`):
   - Kept: the skin (MakeHuman's `body` group, which is watertight: the eye sockets and the mouth are closed
     pockets), the upper teeth, the lower teeth and the tongue. MakeHuman's face targets already move those
     helpers (jawOpen carries the lower teeth by up to 34.5 mm and the tongue by 31 mm; tongueOut moves the
     tongue by 30 mm), so they join `Head` with their morphs. Deleted: the eyes, eyelashes, hair, clothes and
     joint cubes.
   - Split: a skin face is `Head` when every corner has at least half of its bone weight on Head, Neck or the
     eye bones, with the weights normalised over the rig's bone groups first, or when any shape key moves one
     of its corners by more than 0.5 mm; a Body island the Head encloses joins it. MPFB's
     `weights.mixamo.json` does not sum to one on 6,042 of the 13,380 skin vertices, and splitting on the raw
     sums left nine seam loops, with Body patches inside the mouth and under the chin that ignored jawOpen.
     Normalised, the split leaves one loop of 46 vertices around the neck, which no target moves by more than
     0.44 mm.
   - Decimation runs in edit mode (`bpy.ops.mesh.decimate`), X-symmetric, with a vertex-group weight of 0 on
     the seam, on its one-ring and on every piece not being decimated: an edge with a zero-weight end never
     collapses, so both halves keep the seam vertex for vertex. Everything stays selected, because the operator
     stops far short of its target when part of the mesh is deselected (one deselected vertex left the body at
     4,879 triangles instead of 2,740), while zero weights cost nothing. The full head keeps its teeth and
     tongue whole (5,000 triangles: skin 4,360, teeth 2 x 96, tongue 448); the lite head halves the tongue
     (2,400: skin 1,984, teeth 192, tongue 224). The body goes to 8,000 and 3,000 triangles.
   - Morphs: edit-mode decimation keeps the shape keys (each collapse interpolates them along the edge), and
     the offsets are then re-sampled from the full-resolution surface by nearest-point barycentric lookup with
     one BVH per piece (skin, upper teeth, lower teeth, tongue), so no lip vertex can pick up a tooth's motion.
     A vertex whose sample disagrees with its interpolated offset by more than 3 mm in any key keeps the
     interpolated one (none does today: the largest disagreement is 2.4 mm, 2.7 mm in the lite file). The 74
     names keep the order the targets were loaded in. Finally the offsets fade to zero over the two rings next
     to the seam (the seam times 0, the next ring times 1/3, the one after times 2/3), so the seam never moves.
   - Weights are limited to four influences and normalised, and any vertex the decimation left unweighted
     copies its nearest neighbour's weights. Both copies of a seam vertex keep the same weights, so the seam
     holds under skinning too. Blender checks the seam before exporting (same positions, same weights, no morph
     motion) and stops if it does not hold.
6. **`_SCULPT`** (`blender/sculpt.py`): a vertex attribute that tells the runtime what each vertex is; see
   below.
7. **Clips** are keyed procedurally in `blender/animation.py` at 24 fps: `Idle` (6 s loop: breathing on the
   spine and neck, a slow sway and head drift), `Nod` (1.4 s), `PointLeft` and `PointRight` (2 s, with a glance
   towards the target) and `Wave` (2.4 s). `PointLeft` and `PointRight` are viewer-relative: `PointLeft` raises
   the figure's right arm towards screen left. All clips start and end at the rest pose. `Breathing` and
   `Talking` from the contract's optional list are not produced; `Idle` already breathes.
8. **Export**: glTF with positions, skin weights, morph positions and `_SCULPT` (Blender exports custom
   attributes whose names start with `_`, and that is the only one), and no normals, tangents, UVs, colours,
   materials or images. Blender's Z-up to glTF Y-up conversion turns the MakeHuman -Y facing into +Z.

`build.mjs` then: strips any attribute that is not `POSITION`, `JOINTS_0`, `WEIGHTS_0` or `_SCULPT` (and any morph
attribute other than position), drops materials, checks the contract (`tables/contract.json`: required names and
attributes fail the build, optional ones only warn), stores `_SCULPT` as normalised bytes, puts the eye radius
from `src/build-report.json` on the eye bones, keeps only the animation channels that actually move in some clip
(Blender writes translation, rotation and scale for all 54 bones in every clip, which was 155 KB of JSON),
runs `dedup`, `prune`, `resample` and `meshopt` (reorder, 16-bit quantisation on one grid for the whole figure,
`EXT_meshopt_compression`, level high), encodes both dense and sparse morph storage and keeps the smaller,
re-reads the encoded bytes through the meshopt decoder, runs the seam report on them, checks the size budget and
only then writes the file. It also checks height, floor and facing from the rest pose through the skin.
`sample-points.mjs` samples the skin only: the teeth and the tongue sit inside the closed mouth and would show
through a point cloud.

### The `_SCULPT` attribute

Both meshes carry the VEC4 vertex attribute `_SCULPT` (three.js lowercases it: `geometry.attributes._sculpt`),
stored as normalised unsigned bytes (`lib/sculpt.mjs` reads and writes it):

| Channel | Meaning | How it is made |
| --- | --- | --- |
| r | ambient occlusion, 0 occluded to 1 open | a Cycles AO bake (64 samples, 5 cm) of a welded copy of Head and Body, so the seam bakes as one surface and both copies of a seam vertex get the same value, with MakeHuman's helper eyeballs in place as occluders; the skin at rest, and the teeth, tongue and mouth interior with jawOpen at 1, since they are only seen with the mouth open |
| g | tone: skin 1, lips 0.8, teeth 0.92, tongue 0.55, mouth interior 0.3 | lips: MPFB's own lips region (the faces of its `lips_solid` UV layer, carried through the decimation); mouth interior: the skin the lips cut off from the rest of the figure (each piece of skin-minus-lips other than the outer surface that borders the lips and is mostly occluded) |
| b | part id, stored as the byte itself: `Math.round(b * 255)` is 0 skin, 1 teeth, 2 tongue | MakeHuman's helper groups |
| a | calm, how much the water may move the vertex: 0 on the teeth and tongue, 0.35 on and around the eyes and the mouth, 1 elsewhere | 0.35 within 6 mm of an eyeball's surface or 4 mm of the lips and mouth interior, easing to 1 at 18 mm and 16 mm |

The plan's rule for the lips (the vertices mouthRollUpper, mouthRollLower or mouthPucker move by more than 2 mm)
is only counted in `build-report.json` (`moved_over_2mm_by_lip_keys`): on this mesh it marks the whole lower face,
cheeks, chin and the tip of the nose included, because pucker moves the skin around the mouth as well.

### The seam

`Head` and `Body` meet on one loop of 46 vertices around the neck, vertex for vertex: the same positions in the
file, the same skin weights, and a zero offset in every morph, so the runtime can weld them with a 0.1 mm
tolerance in any pose and with any expression. `build.mjs` quantises the positions of both meshes on one 16-bit
grid for the whole figure (about 0.03 mm over 1.75 m; separate grids per mesh, the default, would put the two
copies of a seam vertex up to 0.05 mm apart). With one grid the two skins become identical, and gltf-transform's
own clean-up would fold them into one; it is turned off so the file keeps its two skins.

`lib/seams.mjs` measures the seam on the encoded bytes, through the skin, before anything is written: it pairs
every boundary vertex of the Head's skin (the teeth and tongue are left out) with the nearest Body boundary
vertex, and fails the build when a pair is more than 0.1 mm apart at rest, with jawOpen at 1 or with any one of
the 74 morphs at 1, or when a Body boundary vertex has no partner. Today every one of those gaps is 0; loaded
through three.js's own `GLTFLoader` and deformed with `getVertexPosition`, the seam also stays shut with all 74
morphs at 1 together and with the head turned and the neck bent. `lib/seams.test.ts` covers the report.

### Licences

| Part | Licence | Notes |
| --- | --- | --- |
| MakeHuman base mesh (via MPFB) | CC0 | [makehumancommunity.org](http://www.makehumancommunity.org/); the skin plus its teeth and tongue helpers ship |
| `faceunits01`, `visemes01` targets | CC0 | Mika Suominen, MakeHuman community asset packs |
| MPFB extension (tool, not shipped) | GPL-3.0-or-later | only runs at build time; nothing of it is in the GLB |
| MPFB's Mixamo rig definition and weights | part of MPFB's bundled data (MakeHuman data, CC0) | bone names only; no Mixamo animation data is used |
| MPFB's `lips_solid` UV layer | part of MPFB's bundled data | read at build time only, to choose which faces get the lips tone; none of its data ships |
| Clips, decimation, scripts | this repository | procedural, no third-party motion capture |
| Kokoro-82M voice (tool, not shipped as a model) | Apache-2.0 | the audio it produces is ours |
| `@breezystack/lamejs` (tool) | LGPL-3.0 | build-time encoder only, nothing of it ships |

No Mixamo clip is embedded, so nothing depends on Adobe's terms.

## Current numbers

Filled in by the last successful runs: the figure on 2026-10-16 (Blender 4.2.2, gltf-transform 4.5.1, Node 24.18),
the tour on 2026-10-07.

| File | Size | Content |
| --- | --- | --- |
| `guide.glb` | 291.2 KB (budget 600 KB) | head 5,000 tris / 2,566 verts / 74 morphs (skin 4,360, teeth 2 x 96, tongue 448); body 8,000 tris / 4,024 verts; seam 46 vertices, gap 0; 54 bones, 2 skins; 5 clips, 9 animated channels each |
| `guide-lite.glb` | 177.5 KB (budget 250 KB) | head 2,400 tris / 1,266 verts / 74 morphs (skin 1,984, teeth 2 x 96, tongue 224); body 3,000 tris / 1,524 verts; seam 46 vertices, gap 0; 54 bones, 2 skins; 5 clips |
| `cloud-12k.bin` | 82.0 KB | 12,000 points, 12,360 skin triangles and 1.77 m2 of surface sampled (640 teeth and tongue triangles left out) |
| `cloud-6k.bin` | 41.0 KB | 6,000 points, the first half of the same shuffled sample |
| tour clips | 10 MP3s, 39.7 to 56.7 KB each at 48 kbps, 465 KB in total | 6.7 to 9.6 s per stop, 97 to 142 cues per timeline |

Both GLBs pass the Khronos validator with no errors (the only warning, `NODE_SKINNED_MESH_NON_ROOT`, is the
usual Blender layout of skinned meshes under the armature node, which three.js handles). The run prints the
exact figures; the table above is a snapshot.

## The tour voice

`bake-tour.mjs` reads every stop, synthesises the text with **kokoro-js 1.2.1** (Kokoro-82M, ONNX, q8 weights
on the CPU through onnxruntime-node) in the British female voice `bf_emma` (falls back to `af_heart` if a future
model drops it), trims leading and trailing silence, peak-normalises, and encodes mono MP3 with the pure-JS
LAME port `@breezystack/lamejs`. 24 kHz is an MPEG-2 rate, which LAME supports natively, so there is no
resampling. If a clip would exceed 90 KB at 48 kbps the script retries at 40 and then 32 kbps and fails
loudly if even that is too long (shorten the line). ffmpeg is not needed and is not installed.

The viseme timeline is derived offline the way the runtime's `EnergyVisemes` works on live audio, with the text
as the tie-breaker:

- every 50 ms: RMS on a decibel scale between the clip's floor and its peak gives the openness (the cue
  weight); a 1024-point FFT gives the spectral centroid and the share of energy above 2.5 kHz;
- the text is turned into graphemic units (`tables/graphemes.json`: vowel letters and digraphs to the vowel
  ids 1 to 11, consonant groups to 12 to 21, gaps to 0, longest match first, numbers read as words) and the
  units are spread over the voiced frames in reading order, so lip closures (`p`, `b`, `m`, `f`, `v`) land
  where the words have them;
- the spectrum only corrects the alignment locally: a consonant frame with a centroid above 4 kHz snaps to a
  sibilant the text places within one unit of it, and only an extreme, noise-like frame (centroid above 6 kHz,
  spectral flatness above 0.45) overrides the text outright. Measured on this voice, spectral features alone
  flagged a fifth of a sentence that contains no sibilant at all, so they are not trusted on their own;
  silent frames are `0`;
- a cue is emitted when the viseme changes, the weight moves by a tenth or 200 ms have passed, and the list is
  thinned to at most 400 cues by dropping the least significant weight-only updates. LAME puts 1105 samples
  of encoder and decoder delay in front of the audio (46 ms at 24 kHz) and lamejs writes no Xing/Info tag
  that would let a browser trim them, so every cue after the first is shifted by that constant and
  `durationMs` includes it; the timeline then lines up with what `<audio>` actually plays.

### Model cache and network

The first run downloads about 92 MB (`onnx/model_quantized.onnx` plus the tokenizer files) from Hugging Face
into `tools/avatar/cache/hf/` (gitignored, survives `npm ci`); the voice embeddings ship inside the kokoro-js
package. Two things learned on this machine, both handled by `lib/tts.mjs`:

- `huggingface.co` answers IPv6 first and the IPv6 route here resets the connection, so Node's `fetch` failed
  instantly with `ECONNRESET` while `curl -4` worked. The script sets `dns.setDefaultResultOrder('ipv4first')`.
- If the download still fails, the error message prints `curl -4` commands that place the four files under
  `tools/avatar/cache/hf-models/onnx-community/Kokoro-82M-v1.0-ONNX/`; the script uses that local copy first.

`--captions-only` (or a model that cannot be loaded, exit code 2) writes `<id>.json` timed from the text
alone (`lib/text-visemes.mjs`, about 70 ms per unit) and no MP3, which is the captions-only mode of the site.

## Notes for the integrator

- Morph names are on the `Head` mesh's primitive targets and in `extras.targetNames`; `tables/morphs.json`
  lists their order. `viseme_00` is an all-zero target (silence) on purpose.
- The skin's inverse bind matrices carry the dequantisation of the int16 positions (gltf-transform does this
  for skinned meshes), so read positions through the skin, as `lib/skinned.mjs` does, and never from the
  accessor alone. Head and Body share one quantisation grid. three.js's `GLTFLoader` with `MeshoptDecoder`
  handles all of this.
- `KHR_mesh_quantization` and `EXT_meshopt_compression` are both required extensions of the files.
- three.js names the Head mesh's object `Head_1`, because a bone is also called `Head` (the earlier files did the
  same); `loadAvatar` finds the head by its morphs, not by name.
- To weld Head and Body, match the Head's skin boundary vertices (part 0 in `_sculpt`) to the Body's boundary
  vertices by bind-pose position: the 46 pairs coincide exactly, and no morph moves them.
- The eye sockets are closed pockets of skin; no eyeballs ship. Draw them on the `LeftEye` and `RightEye` bones
  with the radius in `bone.userData.eyeRadius` (16.6 mm).
- `Head` carries the teeth and the tongue as separate islands inside the mouth (part 1 and 2 in `_sculpt`), and
  its morphs move them. The wire and cloud looks of today draw them like the rest of the head, and their morph
  texture grew with the vertex count: once de-indexed, the head is 15,000 vertices x 74 targets of float RGBA, about
  17 MB on the GPU (12 MB before; the lite head about 8 MB), until the sculpture draws the head itself.
- `guide-lite.glb` keeps all 74 morphs; if a phone budget ever needs trimming, dropping the optional face units
  (`tables/contract.json`) is the first lever and costs nothing at runtime.
- `src/guide.blend` (gitignored) can be written with `--save-blend` to inspect the figure in Blender's UI.
- `build.mjs` runs Biome's formatter on the JSON it generates (`tables/morphs.json`, `tables/rig.json` and
  `src/build-report.json`) so `npm run lint` stays green; run it after every `build.py`.
