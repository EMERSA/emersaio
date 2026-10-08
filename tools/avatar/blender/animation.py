"""Procedural clips keyed in bpy: Idle (mandatory), Nod, PointLeft, PointRight and Wave.

Rotations are described on world axes (the figure faces -Y in Blender, her left is +X, up is +Z) and converted
into each bone's local frame from its rest matrix, so the curves do not depend on MPFB's bone rolls. Every clip
starts and ends at the rest pose, and Idle is periodic so it loops without a seam.
"""

from __future__ import annotations

import math
from collections.abc import Callable

import bpy
from mathutils import Matrix, Quaternion, Vector

FPS = 24


def _rest_rotation(rig: bpy.types.Object, name: str) -> Matrix:
    return rig.data.bones[name].matrix_local.to_3x3()


def _local_from_world(rig: bpy.types.Object, name: str, world: Matrix) -> Quaternion:
    """Pose basis for a bone whose parent is at rest: basis = rest^-1 * world * rest."""
    rest = _rest_rotation(rig, name)
    return (rest.inverted() @ world @ rest).to_quaternion()


def _aim(rig: bpy.types.Object, name: str, direction: Vector, parent_world: Matrix | None) -> tuple[Quaternion, Matrix]:
    """Rotate a bone so it points along `direction` (world), accounting for an already-aimed parent."""
    bone = rig.data.bones[name]
    rest = bone.matrix_local.to_3x3()
    rest_dir = bone.vector.normalized()
    world = rest_dir.rotation_difference(direction.normalized()).to_matrix() @ rest
    if parent_world is None:
        basis = rest.inverted() @ world
    else:
        parent_rest = bone.parent.matrix_local.to_3x3()
        basis = (parent_world @ parent_rest.inverted() @ rest).inverted() @ world
    return basis.to_quaternion(), world


def _smoothstep(t: float) -> float:
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def _envelope(t: float, rise: float, hold: float, fall: float) -> float:
    """0 -> 1 -> 0 over rise, hold and fall seconds; smooth at both ends so gestures never snap."""
    if t < rise:
        return _smoothstep(t / rise)
    if t < rise + hold:
        return 1.0
    return 1.0 - _smoothstep((t - rise - hold) / fall)


def _slerp_rest(q: Quaternion, amount: float) -> Quaternion:
    return Quaternion((1.0, 0.0, 0.0, 0.0)).slerp(q, amount)


PoseFn = Callable[[float], dict[str, Quaternion]]


def _bake(rig: bpy.types.Object, name: str, seconds: float, pose: PoseFn) -> bpy.types.Action:
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    frames = int(round(seconds * FPS))
    for frame in range(frames + 1):
        t = frame / FPS
        for bone_name, quaternion in pose(t).items():
            bone = rig.pose.bones[bone_name]
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = quaternion
            bone.keyframe_insert("rotation_quaternion", frame=frame + 1)
    for curve in action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = "LINEAR"
    rig.animation_data.action = None
    for bone in rig.pose.bones:
        bone.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
    return action


def _idle(rig: bpy.types.Object) -> PoseFn:
    def pose(t: float) -> dict[str, Quaternion]:
        breath = math.sin(2 * math.pi * t / 3.0)
        sway = math.sin(2 * math.pi * t / 6.0)
        drift = math.sin(2 * math.pi * t / 6.0 + 1.3)
        rad = math.radians
        return {
            "Spine": _local_from_world(rig, "Spine", Matrix.Rotation(rad(0.7) * sway, 3, "Y")),
            "Spine1": _local_from_world(rig, "Spine1", Matrix.Rotation(rad(-0.8) * breath, 3, "X")),
            "Spine2": _local_from_world(rig, "Spine2", Matrix.Rotation(rad(-0.6) * breath, 3, "X")),
            "Neck": _local_from_world(rig, "Neck", Matrix.Rotation(rad(0.5) * breath, 3, "X")),
            "Head": _local_from_world(
                rig, "Head", Matrix.Rotation(rad(1.6) * drift, 3, "Z") @ Matrix.Rotation(rad(0.6) * breath, 3, "X")
            ),
            "LeftArm": _local_from_world(rig, "LeftArm", Matrix.Rotation(rad(-0.5) * breath, 3, "Y")),
            "RightArm": _local_from_world(rig, "RightArm", Matrix.Rotation(rad(0.5) * breath, 3, "Y")),
        }

    return pose


def _nod(rig: bpy.types.Object) -> PoseFn:
    def pose(t: float) -> dict[str, Quaternion]:
        # Down, slight overshoot up, settle: positive rotation about world X tips the face towards -Y and down.
        angle = math.radians(7.0) * _envelope(t, 0.3, 0.1, 0.35) - math.radians(1.5) * _envelope(t - 0.55, 0.25, 0.0, 0.4)
        return {"Head": _local_from_world(rig, "Head", Matrix.Rotation(angle, 3, "X"))}

    return pose


def _point(rig: bpy.types.Object, side: str) -> PoseFn:
    """PointLeft is viewer-relative: the right arm points to screen left (the figure's -X); PointRight mirrors it."""
    sign = -1.0 if side == "left" else 1.0
    arm = "RightArm" if side == "left" else "LeftArm"
    fore = "RightForeArm" if side == "left" else "LeftForeArm"
    arm_dir = Vector((0.85 * sign, -0.45, 0.28))
    fore_dir = Vector((0.75 * sign, -0.62, 0.22))
    arm_q, arm_world = _aim(rig, arm, arm_dir, None)
    fore_q, _ = _aim(rig, fore, fore_dir, arm_world)
    head_world = Matrix.Rotation(math.radians(10.0 * sign), 3, "Z")

    def pose(t: float) -> dict[str, Quaternion]:
        amount = _envelope(t, 0.45, 0.9, 0.55)
        return {
            arm: _slerp_rest(arm_q, amount),
            fore: _slerp_rest(fore_q, amount),
            "Head": _slerp_rest(_local_from_world(rig, "Head", head_world), amount),
        }

    return pose


def _wave(rig: bpy.types.Object) -> PoseFn:
    arm_q, arm_world = _aim(rig, "RightArm", Vector((-0.6, -0.2, 0.78)), None)
    left_q, _ = _aim(rig, "RightForeArm", Vector((-0.42, -0.2, 0.88)), arm_world)
    right_q, _ = _aim(rig, "RightForeArm", Vector((0.12, -0.2, 0.97)), arm_world)

    def pose(t: float) -> dict[str, Quaternion]:
        amount = _envelope(t, 0.4, 1.4, 0.5)
        swing = 0.5 + 0.5 * math.sin(2 * math.pi * 2.0 * (t - 0.4))
        fore = left_q.slerp(right_q, swing)
        return {"RightArm": _slerp_rest(arm_q, amount), "RightForeArm": _slerp_rest(fore, amount)}

    return pose


def build_clips(rig: bpy.types.Object) -> list[str]:
    """Bake every clip into its own NLA track so the glTF exporter writes each as a named animation."""
    bpy.context.scene.render.fps = FPS
    bpy.context.scene.render.fps_base = 1.0
    if rig.animation_data is None:
        rig.animation_data_create()
    clips = [
        ("Idle", 6.0, _idle(rig)),
        ("Nod", 1.4, _nod(rig)),
        ("PointLeft", 2.0, _point(rig, "left")),
        ("PointRight", 2.0, _point(rig, "right")),
        ("Wave", 2.4, _wave(rig)),
    ]
    names = []
    for name, seconds, pose in clips:
        action = _bake(rig, name, seconds, pose)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        names.append(name)
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = int(6.0 * FPS) + 1
    return names
