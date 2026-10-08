"""Mesh surgery: drop the helper geometry, split Head from Body, decimate, and carry the morphs across.

Blender refuses to apply a Decimate modifier on a mesh that has shape keys, so the head is decimated as a
key-less copy and every target is re-sampled onto it by barycentric lookup on the full-resolution surface.
That is what the Surface Deform modifier would do, without its bind restrictions and without a depsgraph
round trip per target.
"""

from __future__ import annotations

import bmesh
import bpy
from mathutils import Vector, kdtree
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

HEAD_BONES = ("Head", "Neck", "LeftEye", "RightEye")
MAX_INFLUENCES = 4


def delete_helpers(human: bpy.types.Object) -> None:
    """Keep only the "body" vertex group: eyes, teeth, tongue, hair and clothes helpers are not skin."""
    mesh = human.data
    body = human.vertex_groups["body"].index
    bm = bmesh.new()
    bm.from_mesh(mesh)
    deform = bm.verts.layers.deform.verify()
    doomed = [vertex for vertex in bm.verts if body not in vertex[deform]]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()
    for modifier in [m for m in human.modifiers if m.type == "MASK"]:
        human.modifiers.remove(modifier)


def head_vertex_mask(human: bpy.types.Object) -> list[bool]:
    """A vertex belongs to the head when at least half its skin weight sits on the head or neck bones."""
    indices = {human.vertex_groups[name].index for name in HEAD_BONES if name in human.vertex_groups}
    mask = []
    for vertex in human.data.vertices:
        weight = sum(group.weight for group in vertex.groups if group.group in indices)
        mask.append(weight >= 0.5)
    return mask


def split(human: bpy.types.Object, rig: bpy.types.Object) -> tuple[bpy.types.Object, bpy.types.Object]:
    """Two independent copies: Head keeps the shape keys, Body loses them (the body never morphs)."""
    mask = head_vertex_mask(human)
    head = _copy(human, "Head")
    body = _copy(human, "Body")
    _keep_faces(head, lambda face: all(mask[i] for i in face.verts_indices))
    _keep_faces(body, lambda face: not all(mask[i] for i in face.verts_indices))
    body.shape_key_clear()
    for obj in (head, body):
        obj.parent = rig
        obj.matrix_parent_inverse.identity()
    return head, body


def _copy(source: bpy.types.Object, name: str) -> bpy.types.Object:
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = obj.data.name = name
    obj.modifiers.clear()
    bpy.context.scene.collection.objects.link(obj)
    return obj


class _FaceView:
    __slots__ = ("verts_indices",)

    def __init__(self, face: bmesh.types.BMFace) -> None:
        self.verts_indices = [vertex.index for vertex in face.verts]


def _keep_faces(obj: bpy.types.Object, keep) -> None:
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.index_update()
    doomed = [face for face in bm.faces if not keep(_FaceView(face))]
    bmesh.ops.delete(bm, geom=doomed, context="FACES")
    loose = [vertex for vertex in bm.verts if not vertex.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(mesh)
    bm.free()


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)


def decimated_copy(source: bpy.types.Object, name: str, target_triangles: int, symmetric: bool) -> bpy.types.Object:
    """A key-less, collapse-decimated copy; vertex groups survive the collapse so the skin weights do too."""
    obj = _copy(source, name)
    obj.parent = source.parent
    obj.matrix_parent_inverse.identity()
    obj.shape_key_clear()
    ratio = min(1.0, target_triangles / max(1, triangle_count(obj)))
    modifier = obj.modifiers.new("Decimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = ratio
    modifier.use_collapse_triangulate = True
    modifier.use_symmetry = symmetric
    modifier.symmetry_axis = "X"
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


def transfer_shape_keys(source: bpy.types.Object, target: bpy.types.Object) -> int:
    """Re-sample every shape key of `source` onto `target` through the nearest point on the source surface."""
    source_keys = source.data.shape_keys
    if source_keys is None:
        return 0
    basis = source_keys.key_blocks[0]
    bm = bmesh.new()
    bm.from_mesh(source.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    coords = [vertex.co.copy() for vertex in bm.verts]
    triangles = [[vertex.index for vertex in face.verts] for face in bm.faces]
    bm.free()
    tree = BVHTree.FromPolygons(coords, triangles, all_triangles=True)

    # One lookup per target vertex, reused for every key: (source triangle, barycentric weights).
    samples = []
    for vertex in target.data.vertices:
        location, _normal, index, _distance = tree.find_nearest(vertex.co)
        corners = triangles[index]
        weights = poly_3d_calc([coords[i] for i in corners], location)
        samples.append((corners, weights))

    count = len(basis.data)
    base = [0.0] * (count * 3)
    basis.data.foreach_get("co", base)
    target_count = len(target.data.vertices)
    target_base = [0.0] * (target_count * 3)
    target.data.vertices.foreach_get("co", target_base)

    target.shape_key_add(name="Basis", from_mix=False)
    transferred = 0
    for key in source_keys.key_blocks[1:]:
        shape = [0.0] * (count * 3)
        key.data.foreach_get("co", shape)
        out = list(target_base)
        for i, (corners, weights) in enumerate(samples):
            dx = dy = dz = 0.0
            for corner, weight in zip(corners, weights):
                j = corner * 3
                dx += weight * (shape[j] - base[j])
                dy += weight * (shape[j + 1] - base[j + 1])
                dz += weight * (shape[j + 2] - base[j + 2])
            out[i * 3] += dx
            out[i * 3 + 1] += dy
            out[i * 3 + 2] += dz
        block = target.shape_key_add(name=key.name, from_mix=False)
        block.data.foreach_set("co", out)
        block.slider_min = 0.0
        block.slider_max = 1.0
        transferred += 1
    return transferred


def clean_weights(obj: bpy.types.Object, rig: bpy.types.Object) -> dict[str, int]:
    """Only bone groups, at most four influences per vertex, normalised, and no unweighted vertex left behind."""
    bone_names = {bone.name for bone in rig.data.bones}
    for group in list(obj.vertex_groups):
        if group.name not in bone_names:
            obj.vertex_groups.remove(group)
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    deform = bm.verts.layers.deform.verify()
    weighted = []
    orphans = []
    for vertex in bm.verts:
        entries = sorted(vertex[deform].items(), key=lambda item: item[1], reverse=True)[:MAX_INFLUENCES]
        total = sum(weight for _, weight in entries)
        if total < 1e-6:
            orphans.append(vertex)
            continue
        vertex[deform].clear()
        for index, weight in entries:
            vertex[deform][index] = weight / total
        weighted.append(vertex)
    if orphans and weighted:
        # A vertex the decimation left without weights takes its nearest weighted neighbour's weights, so the
        # exporter never has to invent a "neutral bone" for it.
        tree = kdtree.KDTree(len(weighted))
        for i, vertex in enumerate(weighted):
            tree.insert(vertex.co, i)
        tree.balance()
        for vertex in orphans:
            _co, i, _d = tree.find(vertex.co)
            vertex[deform].clear()
            for index, weight in weighted[i][deform].items():
                vertex[deform][index] = weight
    bm.to_mesh(mesh)
    bm.free()
    return {"vertices": len(mesh.vertices), "orphans_fixed": len(orphans)}


def ensure_armature_modifier(obj: bpy.types.Object, rig: bpy.types.Object) -> None:
    modifier = obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_vertex_groups = True


def bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    low = Vector((float("inf"),) * 3)
    high = Vector((float("-inf"),) * 3)
    for obj in objects:
        for vertex in obj.data.vertices:
            co = obj.matrix_world @ vertex.co
            low = Vector(min(a, b) for a, b in zip(low, co))
            high = Vector(max(a, b) for a, b in zip(high, co))
    return low, high
