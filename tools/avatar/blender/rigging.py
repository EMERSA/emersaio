"""The Mixamo-named skeleton: MPFB's game rig, renamed to the contract, plus the two eye bones."""

from __future__ import annotations

import bpy
from mathutils import Vector

from . import figure

MIXAMO_PREFIX = "mixamorig:"

# Bones the runtime looks up by exact name (apps/web and packages/being rely on these).
REQUIRED_BONES = [
    "Hips", "Spine", "Spine1", "Spine2", "Neck", "Head", "LeftEye", "RightEye",
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
]


def add_rig(human: bpy.types.Object) -> bpy.types.Object:
    from bl_ext.blender_org.mpfb.services.humanservice import HumanService

    rig = HumanService.add_builtin_rig(human, "mixamo", import_weights=True)
    if rig is None:
        raise SystemExit("MPFB could not find its mixamo rig definition")
    rig.name = rig.data.name = "Armature"
    _strip_prefix(rig, human)
    _add_eye_bones(rig, human)
    missing = [name for name in REQUIRED_BONES if name not in rig.data.bones]
    if missing:
        raise SystemExit(f"Rig is missing contract bones: {missing}")
    return rig


def _strip_prefix(rig: bpy.types.Object, human: bpy.types.Object) -> None:
    """Mixamo names without the "mixamorig:" prefix are what the runtime and the contract use."""
    for bone in rig.data.bones:
        if bone.name.startswith(MIXAMO_PREFIX):
            bone.name = bone.name[len(MIXAMO_PREFIX):]
    # Renaming a bone normally renames the matching vertex groups too; do it by hand in case it did not.
    for group in human.vertex_groups:
        if group.name.startswith(MIXAMO_PREFIX):
            group.name = group.name[len(MIXAMO_PREFIX):]


def _add_eye_bones(rig: bpy.types.Object, human: bpy.types.Object) -> None:
    """Two leaf bones under Head at the eyeball centres, so look-at can aim the eyes without eyeball geometry."""
    centres = {
        "LeftEye": figure.joint_centre(human, "joint-l-eye"),
        "RightEye": figure.joint_centre(human, "joint-r-eye"),
    }
    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        head = rig.data.edit_bones["Head"]
        for name, centre in centres.items():
            bone = rig.data.edit_bones.new(name)
            bone.head = centre
            # The figure faces -Y in Blender, so the eye bones point forward out of the face.
            bone.tail = centre + Vector((0.0, -0.025, 0.0))
            bone.parent = head
            bone.use_connect = False
            bone.use_deform = True
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def bone_names(rig: bpy.types.Object) -> list[str]:
    return [bone.name for bone in rig.data.bones]
