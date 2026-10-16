"""Build the raw guide figure with Blender 4.2 and MPFB, headless.

    "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe" -b --python tools/avatar/build.py -- [options]

Writes tools/avatar/src/guide-raw.glb (head about 5k triangles with its teeth and tongue, body about 8k) and
guide-lite-raw.glb (head about 2.4k, body about 3k) plus build-report.json. tools/avatar/build.mjs turns them into
the shipped guide.glb and guide-lite.glb. See tools/avatar/README.md for the path taken and the licences involved.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
# No __pycache__ next to the sources: it is not gitignored and has no value for a script run this rarely.
sys.dont_write_bytecode = True

from blender import animation, export, figure, rigging, sculpt, topology  # noqa: E402


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build.py", description=__doc__)
    parser.add_argument("--out", default=os.path.join(HERE, "src"), help="directory for the raw GLBs")
    parser.add_argument("--cache", default=os.path.join(HERE, "cache"), help="where the CC0 target packs are kept")
    parser.add_argument("--height", type=float, default=1.75, help="figure height in metres")
    parser.add_argument("--head-tris", type=int, default=5000, help="head triangles, teeth and tongue included")
    parser.add_argument("--body-tris", type=int, default=8000)
    parser.add_argument("--lite-head-tris", type=int, default=2400, help="lite head triangles, teeth and tongue in")
    parser.add_argument("--lite-body-tris", type=int, default=3000)
    parser.add_argument("--lite-tongue-tris", type=int, default=224, help="the lite tongue's share (full keeps it all)")
    parser.add_argument("--save-blend", action="store_true", help="also save tools/avatar/src/guide.blend for inspection")
    return parser.parse_args(argv)


def build_variant(
    name: str,
    head: bpy.types.Object,
    body: bpy.types.Object,
    rig: bpy.types.Object,
    sizes: dict,
    seam: set[int],
    eyes: dict,
    occluders: list[bpy.types.Object],
    out_dir: str,
) -> dict:
    """Decimate copies of the full-resolution meshes with the seam pinned, carry the morphs, bake _SCULPT, export."""
    # The exporter names nodes after objects and meshes after their data blocks, and the contract wants
    # exactly Head and Body, so the full-resolution originals step aside while a variant is exported.
    head.name = head.data.name = "Head.full"
    body.name = body.data.name = "Body.full"
    tongue = {topology.TONGUE: sizes["tongue"]} if sizes.get("tongue") else None
    head_lo, head_passes = topology.decimated_copy(head, "Head", sizes["head"], True, tongue)
    body_lo, body_passes = topology.decimated_copy(body, "Body", sizes["body"], True)
    for obj, expected in ((head_lo, "Head"), (body_lo, "Body")):
        if obj.name != expected or obj.data.name != expected:
            raise SystemExit(f"could not name the {expected} mesh: got {obj.name}/{obj.data.name}")
    transfer = topology.transfer_shape_keys(head, head_lo)
    feather = topology.feather_seam(head_lo)
    weights = {obj.name: topology.clean_weights(obj, rig) for obj in (head_lo, body_lo)}
    seam_check = topology.check_seam(head_lo, body_lo, seam)
    sculpt_report = sculpt.write_sculpt(head_lo, body_lo, eyes, occluders)
    for obj in (head_lo, body_lo):
        topology.ensure_armature_modifier(obj, rig)
    path = os.path.join(out_dir, f"{name}.glb")
    size = export.export_glb(path, [rig, head_lo, body_lo])
    low, high = topology.bounds([head_lo, body_lo])
    report = {
        "file": path,
        "bytes": size,
        "head": {
            "vertices": len(head_lo.data.vertices),
            "triangles": topology.triangle_count(head_lo),
            "triangles_by_piece": topology.piece_triangles(head_lo),
            "morphs": transfer["morphs"],
            "decimation": head_passes,
        },
        "body": {
            "vertices": len(body_lo.data.vertices),
            "triangles": topology.triangle_count(body_lo),
            "decimation": body_passes,
        },
        "morph_transfer": transfer,
        "seam_feather": feather,
        "seam_blender": seam_check,
        "sculpt": sculpt_report,
        "weights": weights,
        "bounds_blender": {"min": [round(v, 4) for v in low], "max": [round(v, 4) for v in high]},
    }
    # Only the objects go; their meshes stay as unused data (renamed out of the way so the next variant can
    # take the contract names) because freeing a mesh leaves its shape-key block pointing nowhere, which
    # breaks saving the .blend. Unused data is simply not written to the file.
    for obj in (head_lo, body_lo):
        mesh = obj.data
        bpy.data.objects.remove(obj, do_unlink=True)
        mesh.name = f"unused.{name}.{mesh.name}"
    head.name = head.data.name = "Head"
    body.name = body.data.name = "Body"
    return report


def main() -> None:
    args = parse_args()
    started = time.time()
    bpy.ops.wm.read_homefile(use_empty=True)
    figure.enable_mpfb()
    packs = figure.ensure_packs(args.cache)

    human = figure.create_human()
    factor = figure.scale_to_height(human, args.height)
    targets = figure.load_face_targets(human, packs)
    rig = rigging.add_rig(human)
    eyes = figure.measure_eyes(human, rig)
    pieces = topology.tag_vertices(human)
    occluder = topology.eye_occluder(human)
    topology.delete_helpers(human)
    head, body, seam, split_info = topology.split(human, rig)
    bpy.data.objects.remove(human, do_unlink=True)
    clips = animation.build_clips(rig)

    os.makedirs(args.out, exist_ok=True)
    full = {"head": args.head_tris, "body": args.body_tris}
    lite = {"head": args.lite_head_tris, "body": args.lite_body_tris, "tongue": args.lite_tongue_tris}
    report = {
        "figure": "mpfb",
        "blender": bpy.app.version_string,
        "height_scale": round(factor, 5),
        "targets": targets,
        "bones": rigging.bone_names(rig),
        "clips": clips,
        "eyes": eyes,
        "pieces": pieces,
        "split": split_info,
        "full": build_variant("guide-raw", head, body, rig, full, seam, eyes, [occluder], args.out),
        "lite": build_variant("guide-lite-raw", head, body, rig, lite, seam, eyes, [occluder], args.out),
    }
    bpy.data.objects.remove(occluder, do_unlink=True)
    report["seconds"] = round(time.time() - started, 1)
    with open(os.path.join(args.out, "build-report.json"), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
    if args.save_blend:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(args.out, "guide.blend"))
    print(
        f"split: head {split_info['head_faces']} faces, body {split_info['body_faces']}, "
        f"seam {split_info['seam_vertices']} vertices "
        f"(moved at most {split_info['seam_motion_before_feather_mm']} mm before feathering)"
    )
    for variant in ("full", "lite"):
        info = report[variant]
        head_info, body_info = info["head"], info["body"]
        print(
            f"{variant}: {os.path.basename(info['file'])} {info['bytes'] / 1024:.0f} KB, "
            f"head {head_info['triangles']} tris {head_info['triangles_by_piece']} / {head_info['vertices']} verts / "
            f"{head_info['morphs']} morphs, body {body_info['triangles']} tris / {body_info['vertices']} verts; "
            f"morph transfer {info['morph_transfer']}; sculpt {info['sculpt']['head']['vertices']}"
        )
    print(
        f"eye radius {eyes['LeftEye']['radius'] * 1000:.1f} mm; bones {len(report['bones'])}, clips {clips}, "
        f"done in {report['seconds']} s"
    )


if __name__ == "__main__":
    main()
