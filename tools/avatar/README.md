# The guide figure and the baked tour

Everything under `tools/avatar/` produces four kinds of asset for the site:

| Output | Produced by | Contract |
| --- | --- | --- |
| `apps/web/src/assets/being/guide.glb` (<= 600 KB) and `guide-lite.glb` (<= 250 KB) | `build.py` (Blender) then `build.mjs` (gltf-transform) | one skinned humanoid, Y up, 1.75 m, feet at y=0, facing +Z, meshes `Head` (74 morphs) and `Body`, Mixamo bone names, clip `Idle` plus `Nod`, `PointLeft`, `PointRight`, `Wave`, meshopt-compressed, no materials |
| `apps/web/src/assets/being/cloud-12k.bin` and `cloud-6k.bin` | `sample-points.mjs` | EMCL point clouds sampled from `guide.glb` |
| `apps/web/src/assets/tour/<id>.mp3` and `<id>.json` for every stop in `apps/web/src/content/tour/*.yaml` | `bake-tour.mjs` | mono MP3 at 48 kbps (<= 90 KB each) and `{ durationMs, visemes: [[offsetMs, visemeId, weight], ...] }` |
| `tables/morphs.json` and `tables/rig.json` | `build.mjs` | the morph, bone and clip names actually present in `guide.glb` |

Run the whole chain from the repository root:

```sh
"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe" -b --python tools/avatar/build.py
node tools/avatar/build.mjs && node tools/avatar/sample-points.mjs
npm ci --prefix tools/avatar && node tools/avatar/bake-tour.mjs
```

The Blender step is only needed when the figure itself changes; its outputs (`src/guide-raw.glb`,
`src/guide-lite-raw.glb`, `src/build-report.json`) are committed so the three Node scripts run on any machine.

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
   from the base mesh's joint helpers (there is no eyeball geometry, the bones exist so look-at has a target).
5. **Surgery**: the helper geometry (eyes, eyelashes, teeth, tongue, hair, clothes and joint cubes) is deleted,
   the figure is split into `Head` (vertices with at least half their weight on Head or Neck, so the throat
   that `jawOpen` moves stays on the morphing mesh) and `Body`, and each is decimated by Blender's collapse
   decimator (X-symmetric for the head). Blender cannot apply a decimate modifier on a mesh with shape keys, so
   the head is decimated as a key-less copy and every target is re-sampled onto it by nearest-point barycentric
   lookup on the full-resolution head (the Surface Deform idea, without its bind restrictions). Weights are
   limited to four influences, normalised, and any vertex the decimation left unweighted copies its nearest
   neighbour's weights.
6. **Clips** are keyed procedurally in `blender/animation.py` at 24 fps: `Idle` (6 s loop: breathing on the
   spine and neck, a slow sway and head drift), `Nod` (1.4 s), `PointLeft` and `PointRight` (2 s, with a glance
   towards the target) and `Wave` (2.4 s). `PointLeft` and `PointRight` are viewer-relative: `PointLeft` raises
   the figure's right arm towards screen left. All clips start and end at the rest pose. `Breathing` and
   `Talking` from the contract's optional list are not produced; `Idle` already breathes.
7. **Export**: glTF with positions, skin weights and morph positions only (no normals, tangents, UVs,
   colours, materials or images). Blender's Z-up to glTF Y-up conversion turns the MakeHuman -Y facing into +Z.

`build.mjs` then: strips any attribute that is not `POSITION`, `JOINTS_0` or `WEIGHTS_0` (and any morph
attribute other than position), drops materials, checks the contract (`tables/contract.json`: required names
fail the build, optional ones only warn), keeps only the animation channels that actually move in some clip
(Blender writes translation, rotation and scale for all 54 bones in every clip, which was 155 KB of JSON),
runs `dedup`, `prune`, `resample` and `meshopt` (reorder, int16 quantisation, `EXT_meshopt_compression`,
level high), encodes both dense and sparse morph storage and keeps the smaller, re-reads the written file
through the meshopt decoder, and checks height, floor and facing from the rest pose through the skin.

### Licences

| Part | Licence | Notes |
| --- | --- | --- |
| MakeHuman base mesh (via MPFB) | CC0 | [makehumancommunity.org](http://www.makehumancommunity.org/) |
| `faceunits01`, `visemes01` targets | CC0 | Mika Suominen, MakeHuman community asset packs |
| MPFB extension (tool, not shipped) | GPL-3.0-or-later | only runs at build time; nothing of it is in the GLB |
| MPFB's Mixamo rig definition and weights | part of MPFB's bundled data (MakeHuman data, CC0) | bone names only; no Mixamo animation data is used |
| Clips, decimation, scripts | this repository | procedural, no third-party motion capture |
| Kokoro-82M voice (tool, not shipped as a model) | Apache-2.0 | the audio it produces is ours |
| `@breezystack/lamejs` (tool) | LGPL-3.0 | build-time encoder only, nothing of it ships |

No Mixamo clip is embedded, so nothing depends on Adobe's terms.

## Current numbers

Filled in by the last successful run on 2026-10-07 (Blender 4.2.2, gltf-transform 4.5.1, Node 24.18).

| File | Size | Content |
| --- | --- | --- |
| `guide.glb` | 245.9 KB (budget 600 KB) | head 3,498 tris / 1,825 verts / 74 morphs; body 7,998 tris / 4,088 verts; 54 bones; 5 clips, 9 animated channels each |
| `guide-lite.glb` | 169.7 KB (budget 250 KB) | head 1,999 tris / 1,063 verts / 74 morphs; body 3,000 tris / 1,561 verts; 54 bones; 5 clips |
| `cloud-12k.bin` | 82.0 KB | 12,000 points, 11,496 triangles and 1.77 m2 of surface sampled |
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
  accessor alone. three.js's `GLTFLoader` with `MeshoptDecoder` handles all of this.
- `KHR_mesh_quantization` and `EXT_meshopt_compression` are both required extensions of the files.
- Eye sockets are open (the eyeballs were separate MakeHuman assets and are deliberately not shipped); the
  wire shader's back faces fill them visually.
- `guide-lite.glb` keeps all 74 morphs; if a phone budget ever needs trimming, dropping the optional face units
  (`tables/contract.json`) is the first lever and costs nothing at runtime.
- `src/guide.blend` (gitignored) can be written with `--save-blend` to inspect the figure in Blender's UI.
- `build.mjs` runs Biome's formatter on the JSON it generates (`tables/morphs.json`, `tables/rig.json` and
  `src/build-report.json`) so `npm run lint` stays green; run it after every `build.py`.
