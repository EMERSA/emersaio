"""The MPFB figure: enable the extension, create the human, scale it and load the face targets.

Why MPFB: it ships the MakeHuman base mesh (CC0) and installs headlessly from extensions.blender.org, and the
MakeHuman community publishes the two CC0 target packs this pipeline needs (ARKit face units and the 22
Microsoft visemes), so the whole figure is licence-clean without any hand modelling.
"""

from __future__ import annotations

import json
import os
import urllib.request
import zipfile

import bpy
from mathutils import Vector

MPFB_MODULE = "bl_ext.blender_org.mpfb"

# Both mirrors serve the same CC0 packs. The index page says "shared under CC0" and every target inside the
# packs carries "license": "CC0" in packs/<pack>.json, which ensure_packs() verifies before anything loads.
PACKS = {
    "faceunits01": {
        "urls": [
            "https://files2.makehumancommunity.org/functional/faceunits01.zip",
            "https://files.makehumancommunity.org/functional/faceunits01.zip",
        ],
        "targets": os.path.join("targets", "faceunits"),
        "meta": os.path.join("packs", "faceunits01.json"),
    },
    "visemes01": {
        "urls": [
            "https://files2.makehumancommunity.org/functional/visemes01.zip",
            "https://files.makehumancommunity.org/functional/visemes01.zip",
        ],
        "targets": os.path.join("targets", "visemes"),
        "meta": os.path.join("packs", "visemes01.json"),
    },
}

# The ARKit face unit names, in Apple's order, so the morph dictionary is stable between builds.
ARKIT_52 = [
    "eyeBlinkLeft", "eyeLookDownLeft", "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeSquintLeft",
    "eyeWideLeft", "eyeBlinkRight", "eyeLookDownRight", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight",
    "eyeSquintRight", "eyeWideRight", "jawForward", "jawLeft", "jawRight", "jawOpen", "mouthClose", "mouthFunnel",
    "mouthPucker", "mouthLeft", "mouthRight", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft",
    "mouthFrownRight", "mouthDimpleLeft", "mouthDimpleRight", "mouthStretchLeft", "mouthStretchRight",
    "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper", "mouthPressLeft", "mouthPressRight",
    "mouthLowerDownLeft", "mouthLowerDownRight", "mouthUpperUpLeft", "mouthUpperUpRight", "browDownLeft",
    "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "cheekPuff", "cheekSquintLeft",
    "cheekSquintRight", "noseSneerLeft", "noseSneerRight", "tongueOut",
]

VISEME_COUNT = 22


def enable_mpfb() -> None:
    """Enable the extension through the preferences operator so its own preference lookups resolve."""
    try:
        bpy.ops.preferences.addon_enable(module=MPFB_MODULE)
    except Exception as error:  # noqa: BLE001 - Blender raises a plain RuntimeError here
        raise SystemExit(
            "MPFB is not installed in this Blender. Install it once, online, with:\n"
            '  "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe" -b --command extension install mpfb\n'
            f"(original error: {error})"
        ) from error
    if MPFB_MODULE not in bpy.context.preferences.addons:
        raise SystemExit("MPFB did not register; run blender -b --command extension list to check the install")


def ensure_packs(cache_dir: str) -> dict[str, str]:
    """Download and unpack the two target packs once, then verify that every target declares CC0."""
    folders: dict[str, str] = {}
    for name, pack in PACKS.items():
        root = os.path.join(cache_dir, name)
        meta_path = os.path.join(root, pack["meta"])
        if not os.path.isfile(meta_path):
            zip_path = os.path.join(cache_dir, f"{name}.zip")
            if not os.path.isfile(zip_path):
                _download(pack["urls"], zip_path)
            with zipfile.ZipFile(zip_path) as archive:
                archive.extractall(root)
        with open(meta_path, encoding="utf-8") as handle:
            meta = json.load(handle)
        bad = sorted(key for key, entry in meta.items() if str(entry.get("license", "")).upper() != "CC0")
        if bad:
            raise SystemExit(f"Pack {name} contains targets without a CC0 licence: {bad}")
        folders[name] = os.path.join(root, pack["targets"])
    return folders


def _download(urls: list[str], destination: str) -> None:
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    last_error: Exception | None = None
    for url in urls:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "emersa-avatar-build/1.0"})
            with urllib.request.urlopen(request, timeout=60) as response, open(destination, "wb") as handle:
                handle.write(response.read())
            return
        except Exception as error:  # noqa: BLE001 - try the next mirror
            last_error = error
    raise SystemExit(f"Could not download {os.path.basename(destination)} from any mirror: {last_error}")


def create_human() -> bpy.types.Object:
    """A female, regular-proportioned MakeHuman figure with the macro targets baked into the mesh."""
    from bl_ext.blender_org.mpfb.services.humanservice import HumanService
    from bl_ext.blender_org.mpfb.services.targetservice import TargetService

    macro = TargetService.get_default_macro_info_dict()
    macro["gender"] = 0.0
    macro["proportions"] = 0.5
    human = HumanService.create_human(
        mask_helpers=True,
        detailed_helpers=True,
        extra_vertex_groups=True,
        feet_on_ground=True,
        scale=0.1,
        macro_detail_dict=macro,
    )
    # The macro shape keys are only needed while the body is being designed; baking them keeps every later
    # shape key a pure face target and lets the decimation copies drop keys safely.
    TargetService.bake_targets(human)
    return human


def body_vertex_mask(human: bpy.types.Object) -> list[bool]:
    index = human.vertex_groups["body"].index
    return [any(group.group == index for group in vertex.groups) for vertex in human.data.vertices]


def scale_to_height(human: bpy.types.Object, height: float) -> float:
    """Uniformly scale the figure so the body spans exactly `height` metres with its feet on y=0."""
    from bl_ext.blender_org.mpfb.entities.objectproperties import GeneralObjectProperties

    mask = body_vertex_mask(human)
    zs = [vertex.co.z for vertex, keep in zip(human.data.vertices, mask) if keep]
    factor = height / (max(zs) - min(zs))
    human.scale = (factor, factor, factor)
    with bpy.context.temp_override(
        object=human, active_object=human, selected_objects=[human], selected_editable_objects=[human]
    ):
        bpy.ops.object.transform_apply(location=True, rotation=False, scale=True)
    offset = min(vertex.co.z for vertex, keep in zip(human.data.vertices, mask) if keep)
    for vertex in human.data.vertices:
        vertex.co.z -= offset
    # Targets are stored in MakeHuman decimetres; MPFB multiplies them by this property when it loads them,
    # so it has to follow the figure's new scale or every morph would be too small.
    previous = GeneralObjectProperties.get_value("scale_factor", entity_reference=human) or 0.1
    GeneralObjectProperties.set_value("scale_factor", previous * factor, entity_reference=human)
    return factor


def load_face_targets(human: bpy.types.Object, folders: dict[str, str]) -> list[str]:
    """Load the 22 visemes then the 52 ARKit units as zero-weight shape keys with the contract names."""
    from bl_ext.blender_org.mpfb.services.targetservice import TargetService

    loaded: list[str] = []
    viseme_files = sorted(
        (int(name[:-7].rsplit("_", 1)[1]), name)
        for name in os.listdir(folders["visemes01"])
        if name.endswith(".target")
    )
    if [number for number, _ in viseme_files] != list(range(VISEME_COUNT)):
        raise SystemExit(f"visemes01 does not contain exactly ids 0..{VISEME_COUNT - 1}: {viseme_files}")
    for number, name in viseme_files:
        TargetService.load_target(human, os.path.join(folders["visemes01"], name), weight=0.0, name=f"viseme_{number:02d}")
        loaded.append(f"viseme_{number:02d}")
    for name in ARKIT_52:
        path = os.path.join(folders["faceunits01"], f"{name}.target")
        if not os.path.isfile(path):
            raise SystemExit(f"faceunits01 is missing {name}.target")
        TargetService.load_target(human, path, weight=0.0, name=name)
        loaded.append(name)
    return loaded


def joint_centre(human: bpy.types.Object, group_name: str) -> Vector:
    """Centre of one of the base mesh's joint helper cubes, used to place bones the rig does not define."""
    index = human.vertex_groups[group_name].index
    points = [vertex.co for vertex in human.data.vertices if any(group.group == index for group in vertex.groups)]
    if not points:
        raise SystemExit(f"Vertex group {group_name} is empty")
    return sum(points, Vector()) / len(points)
