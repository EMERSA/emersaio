"""Mesh surgery: keep the skin, teeth and tongue, split Head from Body, decimate with the seam pinned, carry the morphs.

The figure is one MakeHuman mesh: the skin (the "body" vertex group, which is watertight) plus helper pieces. Head
keeps the upper teeth, lower teeth and tongue helpers, because MakeHuman's face targets already move them (jawOpen
carries the lower teeth and the tongue, tongueOut the tongue). The eyes, eyelashes, hair, clothes and joint cubes go;
the runtime draws its own eyeballs on the eye bones.

Head and Body share one seam loop around the neck, vertex for vertex:

- the split normalises the skin weights over the rig's bone groups first (MPFB's weight file does not sum to one on
  almost half the skin, which is what used to leave Body patches inside the mouth and under the chin), then a skin
  face is Head when every corner has at least half its weight on Head, Neck or the eyes, or when any shape key moves
  one of its corners by more than half a millimetre; a Body island the Head encloses joins the Head;
- decimation runs in edit mode (bpy.ops.mesh.decimate) with a vertex-group weight of 0 on the seam vertices and
  their one-ring (and on the teeth and tongue during the skin pass): an edge with a zero-weight end never collapses,
  so neither half can move or merge a seam vertex. Everything stays selected, because the operator stops far short
  of its target when part of the mesh is deselected (measured: one deselected vertex left the body at 4,879
  triangles instead of 2,740), while zero weights cost nothing;
- the morph offsets fade to zero over the two rings next to the seam, so the seam never moves.

Each collapse interpolates every vertex attribute, integers included, so after decimation `orig_index` is exact only
on vertices no collapse touched. The seam is therefore marked by its own float attribute, `seam` (1 on the seam, 0
elsewhere): pinned vertices keep their 1, and a collapse of two unpinned vertices can only produce 0.

Edit-mode decimation keeps the shape keys (each collapse interpolates them along the collapsed edge). The offsets are
then re-sampled from the full-resolution surface through one BVH per piece (skin, upper teeth, lower teeth, tongue),
so no lip vertex can pick up a tooth's motion; where that nearest-point sample disagrees with the collapse-interpolated
offset by more than 3 mm in any key (a sign that it reached across the lip line), the interpolated offset is kept.
"""

from __future__ import annotations

import gzip
import importlib
import json
import os
from collections import deque

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree
from mathutils.bvhtree import BVHTree
from mathutils.interpolate import poly_3d_calc

from .figure import MPFB_MODULE

SKIN_GROUP = "body"
# MPFB's own lips region (the faces its "lips_solid" UV layer covers), used for the lips tone.
LIPS_LAYER = "lips_solid"
# Internal piece ids (0 is the skin). The exported part id in the _SCULPT attribute folds both teeth into one.
SKIN, UPPER_TEETH, LOWER_TEETH, TONGUE = 0, 1, 2, 3
PIECE_GROUPS = {"helper-upper-teeth": UPPER_TEETH, "helper-lower-teeth": LOWER_TEETH, "helper-tongue": TONGUE}
PIECE_NAMES = ("skin", "upper_teeth", "lower_teeth", "tongue")
PART_OF_PIECE = (0, 1, 1, 2)
EYE_GROUPS = ("helper-l-eye", "helper-r-eye")

SPLIT_BONES = ("Head", "Neck", "LeftEye", "RightEye")
MOVED_M = 0.0005
# A Body island smaller than this lies inside the Head (in the mouth, under the chin) and joins it.
ISLAND_FACES = 500
FEATHER_RINGS = 2
GUARD_M = 0.003
TRIANGLE_TOLERANCE = 0.02
MAX_INFLUENCES = 4

ORIG_ATTRIBUTE = "orig_index"
PIECE_ATTRIBUTE = "piece"
SEAM_ATTRIBUTE = "seam"
LIPS_ATTRIBUTE = "lips_region"
PIN_GROUP = "decimate_weight"


# --- attributes ------------------------------------------------------------------------------------------------


def int_attribute(obj: bpy.types.Object, name: str) -> list[int]:
    values = [0] * len(obj.data.vertices)
    obj.data.attributes[name].data.foreach_get("value", values)
    return values


def _set_int_attribute(mesh: bpy.types.Mesh, name: str, values: list[int]) -> None:
    attribute = mesh.attributes.get(name) or mesh.attributes.new(name, "INT", "POINT")
    attribute.data.foreach_set("value", values)


def seam_vertices(obj: bpy.types.Object) -> list[int]:
    """Local indices of the seam vertices, from the `seam` flag (exact, unlike orig_index after decimation)."""
    values = [0.0] * len(obj.data.vertices)
    obj.data.attributes[SEAM_ATTRIBUTE].data.foreach_get("value", values)
    return [index for index, value in enumerate(values) if value == 1.0]


def seam_partners(head: bpy.types.Object, body: bpy.types.Object) -> list[tuple[int, int]]:
    """(Head index, Body index) for each seam vertex, matched by original index (exact on the pinned seam)."""
    head_orig = int_attribute(head, ORIG_ATTRIBUTE)
    body_orig = int_attribute(body, ORIG_ATTRIBUTE)
    body_by_orig = {body_orig[index]: index for index in seam_vertices(body)}
    return [
        (index, body_by_orig[head_orig[index]]) for index in seam_vertices(head) if head_orig[index] in body_by_orig
    ]


def mpfb_face_set(layer: str) -> set[int]:
    """Base-mesh face indices that one of MPFB's bundled UV layers covers (data/uv_layers/<layer>.json.gz is keyed by
    face index, then loop index). MPFB's skin shader paints its regions through these layers."""
    module = importlib.import_module(MPFB_MODULE)
    path = os.path.join(os.path.dirname(module.__file__), "data", "uv_layers", f"{layer}.json.gz")
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return {int(face) for face in json.load(handle)}


def tag_vertices(human: bpy.types.Object) -> dict[str, int]:
    """Point attributes that every later bmesh operation carries along: the original vertex index and the piece
    (integers; piece -1 marks the helpers that are deleted; collapses never join two pieces, so the piece survives
    decimation exactly), and `lips_region`, 1 on the vertices of MPFB's lips region (lips_solid) and 0 elsewhere,
    which collapses interpolate. None of the names starts with "_", so none is exported. Call it on the untouched
    base mesh: the lips region is given by base-mesh face index."""
    mesh = human.data
    names = {group.index: group.name for group in human.vertex_groups}
    pieces = [-1] * len(mesh.vertices)
    for vertex in mesh.vertices:
        for group in vertex.groups:
            name = names[group.group]
            if name in PIECE_GROUPS:
                pieces[vertex.index] = PIECE_GROUPS[name]
            elif name == SKIN_GROUP and pieces[vertex.index] < 0:
                pieces[vertex.index] = SKIN
    lips_faces = mpfb_face_set(LIPS_LAYER)
    lips = [0.0] * len(mesh.vertices)
    for polygon in mesh.polygons:
        if polygon.index in lips_faces:
            for index in polygon.vertices:
                lips[index] = 1.0
    _set_int_attribute(mesh, ORIG_ATTRIBUTE, list(range(len(mesh.vertices))))
    _set_int_attribute(mesh, PIECE_ATTRIBUTE, pieces)
    mesh.attributes.new(LIPS_ATTRIBUTE, "FLOAT", "POINT").data.foreach_set("value", lips)
    counts = {name: pieces.count(piece) for piece, name in enumerate(PIECE_NAMES)}
    counts["lips_faces"] = len(lips_faces)
    counts["lips_vertices"] = int(sum(lips))
    return counts


# --- helpers out, eyes kept aside for the AO bake ----------------------------------------------------------------


def _copy(source: bpy.types.Object, name: str) -> bpy.types.Object:
    obj = source.copy()
    obj.data = source.data.copy()
    obj.name = obj.data.name = name
    obj.modifiers.clear()
    bpy.context.scene.collection.objects.link(obj)
    return obj


def _delete_vertices(obj: bpy.types.Object, doomed: list[bool]) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if doomed[vertex.index]], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def eye_occluder(human: bpy.types.Object) -> bpy.types.Object:
    """A static copy of the helper eyeballs (no armature modifier, never selected for export). The AO bake sees it,
    so the eyelids and sockets darken as they would around a real eye."""
    obj = _copy(human, "EyesForAO")
    obj.shape_key_clear()
    indices = {obj.vertex_groups[name].index for name in EYE_GROUPS}
    _delete_vertices(obj, [not any(group.group in indices for group in vertex.groups) for vertex in obj.data.vertices])
    return obj


def delete_helpers(human: bpy.types.Object) -> None:
    """Keep the skin, the teeth and the tongue: the eyes, eyelashes, hair, clothes and joint cubes are not her."""
    _delete_vertices(human, [piece < 0 for piece in int_attribute(human, PIECE_ATTRIBUTE)])
    for modifier in [m for m in human.modifiers if m.type == "MASK"]:
        human.modifiers.remove(modifier)


# --- split ---------------------------------------------------------------------------------------------------------


def head_vertex_mask(human: bpy.types.Object, rig: bpy.types.Object) -> list[bool]:
    """At least half of the vertex's bone weight, normalised over the rig's bone groups, is on the head bones."""
    bone_names = {bone.name for bone in rig.data.bones}
    bone_groups = {group.index for group in human.vertex_groups if group.name in bone_names}
    head_groups = {group.index for group in human.vertex_groups if group.name in SPLIT_BONES}
    mask = []
    for vertex in human.data.vertices:
        total = sum(group.weight for group in vertex.groups if group.group in bone_groups)
        head = sum(group.weight for group in vertex.groups if group.group in head_groups)
        mask.append(total > 1e-9 and head / total >= 0.5)
    return mask


def key_coords(block: bpy.types.ShapeKey) -> np.ndarray:
    co = np.empty(len(block.data) * 3, dtype=np.float32)
    block.data.foreach_get("co", co)
    return co.reshape(-1, 3).astype(np.float64)


def _set_key_coords(block: bpy.types.ShapeKey, coords: np.ndarray) -> None:
    block.data.foreach_set("co", coords.astype(np.float32).ravel())


def vertex_motion(obj: bpy.types.Object) -> np.ndarray:
    """The largest distance any shape key moves each vertex, in metres."""
    keys = obj.data.shape_keys
    motion = np.zeros(len(obj.data.vertices))
    if keys is None:
        return motion
    base = key_coords(keys.key_blocks[0])
    for block in keys.key_blocks[1:]:
        motion = np.maximum(motion, np.linalg.norm(key_coords(block) - base, axis=1))
    return motion


def _face_components(mesh: bpy.types.Mesh, member: list[bool]) -> list[list[int]]:
    """Edge-connected components of the faces flagged in `member`, as lists of face indices."""
    edge_faces: dict[tuple[int, int], list[int]] = {}
    for polygon in mesh.polygons:
        if member[polygon.index]:
            for key in polygon.edge_keys:
                edge_faces.setdefault(key, []).append(polygon.index)
    seen: set[int] = set()
    components = []
    for polygon in mesh.polygons:
        if not member[polygon.index] or polygon.index in seen:
            continue
        component = []
        queue = deque([polygon.index])
        seen.add(polygon.index)
        while queue:
            face = queue.popleft()
            component.append(face)
            for key in mesh.polygons[face].edge_keys:
                for other in edge_faces[key]:
                    if other not in seen:
                        seen.add(other)
                        queue.append(other)
        components.append(component)
    return components


def _keep_faces(obj: bpy.types.Object, keep: list[bool]) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[face for face in bm.faces if not keep[face.index]], context="FACES")
    bmesh.ops.delete(bm, geom=[vertex for vertex in bm.verts if not vertex.link_faces], context="VERTS")
    bm.to_mesh(obj.data)
    bm.free()


def split(human: bpy.types.Object, rig: bpy.types.Object) -> tuple[bpy.types.Object, bpy.types.Object, set[int], dict]:
    """Two independent copies: Head keeps the shape keys, Body loses them (the body never morphs). Returns the seam as
    the set of original vertex indices both halves keep."""
    mesh = human.data
    mask = head_vertex_mask(human, rig)
    motion = vertex_motion(human)
    pieces = int_attribute(human, PIECE_ATTRIBUTE)
    head_face = []
    moved_only = 0
    for polygon in mesh.polygons:
        corners = polygon.vertices
        by_weight = all(mask[i] for i in corners)
        moved = any(motion[i] > MOVED_M for i in corners)
        moved_only += int(moved and not by_weight and pieces[corners[0]] == SKIN)
        head_face.append(pieces[corners[0]] != SKIN or by_weight or moved)
    islands = sorted(_face_components(mesh, [not flag for flag in head_face]), key=len, reverse=True)
    absorbed = [island for island in islands[1:] if len(island) < ISLAND_FACES]
    for island in absorbed:
        for face in island:
            head_face[face] = True

    head = _copy(human, "Head")
    body = _copy(human, "Body")
    _keep_faces(head, head_face)
    _keep_faces(body, [not flag for flag in head_face])
    body.shape_key_clear()
    for obj in (head, body):
        obj.parent = rig
        obj.matrix_parent_inverse.identity()
    seam = set(int_attribute(head, ORIG_ATTRIBUTE)) & set(int_attribute(body, ORIG_ATTRIBUTE))
    for obj in (head, body):
        flag = obj.data.attributes.new(SEAM_ATTRIBUTE, "FLOAT", "POINT")
        flag.data.foreach_set("value", [1.0 if value in seam else 0.0 for value in int_attribute(obj, ORIG_ATTRIBUTE)])
    head_skin =[pieces[polygon.vertices[0]] == SKIN and head_face[polygon.index] for polygon in mesh.polygons]
    info = {
        "head_faces": sum(head_face),
        "body_faces": len(head_face) - sum(head_face),
        "faces_added_by_motion": moved_only,
        "body_islands_absorbed": [len(island) for island in absorbed],
        "head_skin_components": len(_face_components(mesh, head_skin)),
        "seam_vertices": len(seam),
        "seam_motion_before_feather_mm": round(float(max((motion[i] for i in seam), default=0.0)) * 1000, 3),
    }
    return head, body, seam, info


# --- decimation ----------------------------------------------------------------------------------------------------


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(len(polygon.vertices) - 2 for polygon in obj.data.polygons)


def piece_triangles(obj: bpy.types.Object) -> dict[str, int]:
    pieces = int_attribute(obj, PIECE_ATTRIBUTE)
    counts = dict.fromkeys(PIECE_NAMES, 0)
    for polygon in obj.data.polygons:
        counts[PIECE_NAMES[pieces[polygon.vertices[0]]]] += len(polygon.vertices) - 2
    return counts


def _triangulate(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.to_mesh(obj.data)
    bm.free()


def seam_ring(obj: bpy.types.Object) -> set[int]:
    """Local indices of the seam vertices and of their one-ring."""
    on_seam = set(seam_vertices(obj))
    ring = set(on_seam)
    for edge in obj.data.edges:
        a, b = edge.vertices
        if a in on_seam:
            ring.add(b)
        if b in on_seam:
            ring.add(a)
    return ring


def _edit_decimate(obj: bpy.types.Object, free: list[bool], ratio: float, symmetric: bool) -> None:
    """bpy.ops.mesh.decimate on the whole mesh, with weight 1 where `free` and 0 elsewhere: an edge with a
    zero-weight end never collapses, so those vertices keep their position, attributes and shape-key values."""
    group = obj.vertex_groups.new(name=PIN_GROUP)
    group.add([index for index, flag in enumerate(free) if flag], 1.0, "REPLACE")
    obj.vertex_groups.active_index = group.index
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if obj.data.shape_keys is not None:
        obj.active_shape_key_index = 0
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.context.tool_settings.mesh_select_mode = (True, False, False)
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.mesh.decimate(
            ratio=ratio,
            use_vertex_group=True,
            vertex_group_factor=1.0,
            invert_vertex_group=False,
            use_symmetry=symmetric,
            symmetry_axis="X",
        )
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        obj.vertex_groups.remove(obj.vertex_groups[PIN_GROUP])


def _decimate_pass(obj: bpy.types.Object, piece: int, target: int, symmetric: bool) -> dict:
    """Decimate one piece (the seam and its one-ring excepted) until it holds about `target` triangles.

    With everything selected the operator collapses until the whole mesh is down to ratio x its triangles, so the
    ratio counts the other pieces, which cannot shrink. A few attempts from the same starting mesh absorb what the
    pinned faces and the collapse checks leave over."""
    name = PIECE_NAMES[piece]
    start = piece_triangles(obj)[name]
    if target >= start:
        return {"piece": name, "from": start, "to": start, "target": target, "ratio": 1.0, "attempts": 0}
    pieces = int_attribute(obj, PIECE_ATTRIBUTE)
    pinned = seam_ring(obj)
    free = [pieces[i] == piece and i not in pinned for i in range(len(pieces))]
    total = triangle_count(obj)
    others = total - start
    ratio = (target + others) / total
    snapshot = obj.data.copy()
    snapshot.name = f"unused.{obj.name}.{name}.snapshot"
    got = start
    attempt = 0
    for attempt in range(1, 7):
        if attempt > 1:
            previous = obj.data
            obj.data = snapshot.copy()
            previous.name = f"unused.{obj.name}.{name}.try{attempt - 1}"
        _edit_decimate(obj, free, ratio, symmetric)
        _triangulate(obj)
        got = piece_triangles(obj)[name]
        if abs(got - target) <= TRIANGLE_TOLERANCE * target:
            break
        ratio = min(1.0, max(0.01, ratio * (target + others) / (got + others)))
    obj.data.name = obj.name
    return {"piece": name, "from": start, "to": got, "target": target, "ratio": round(ratio, 4), "attempts": attempt}


def decimated_copy(
    source: bpy.types.Object,
    name: str,
    total_triangles: int,
    symmetric: bool,
    piece_targets: dict[int, int] | None = None,
) -> tuple[bpy.types.Object, list[dict]]:
    """A triangulated, decimated copy of about `total_triangles`: first each helper piece listed in `piece_targets`
    (piece id to its own target), then the skin with whatever is left. The seam, its one-ring and every helper piece
    not listed stay exactly as they are. Shape keys and vertex groups ride through every collapse."""
    obj = _copy(source, name)
    obj.parent = source.parent
    obj.matrix_parent_inverse.identity()
    _triangulate(obj)
    passes = [_decimate_pass(obj, piece, target, symmetric) for piece, target in (piece_targets or {}).items()]
    helpers = sum(count for piece, count in piece_triangles(obj).items() if piece != PIECE_NAMES[SKIN])
    passes.append(_decimate_pass(obj, SKIN, total_triangles - helpers, symmetric))
    obj.name = obj.data.name = name
    return obj, passes


# --- morphs --------------------------------------------------------------------------------------------------------


def transfer_shape_keys(source: bpy.types.Object, target: bpy.types.Object) -> dict:
    """Re-sample every shape key of the full-resolution `source` onto the decimated `target`, one BVH per piece.

    `target` already carries the keys the collapse interpolated (same names, same order); a vertex keeps those when
    the nearest-point sample disagrees by more than GUARD_M in any key."""
    source_keys = source.data.shape_keys
    target_keys = target.data.shape_keys
    if source_keys is None:
        return {"morphs": 0}
    names = [block.name for block in source_keys.key_blocks]
    if target_keys is None or [block.name for block in target_keys.key_blocks] != names:
        raise SystemExit("the decimated head lost or reordered its shape keys")

    source_pieces = int_attribute(source, PIECE_ATTRIBUTE)
    target_pieces = int_attribute(target, PIECE_ATTRIBUTE)
    bm = bmesh.new()
    bm.from_mesh(source.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.verts.ensure_lookup_table()
    coords = [vertex.co.copy() for vertex in bm.verts]
    triangles: dict[int, list[list[int]]] = {piece: [] for piece in range(len(PIECE_NAMES))}
    for face in bm.faces:
        corners = [vertex.index for vertex in face.verts]
        triangles[source_pieces[corners[0]]].append(corners)
    bm.free()
    trees = {piece: BVHTree.FromPolygons(coords, tris, all_triangles=True) for piece, tris in triangles.items() if tris}

    count = len(target.data.vertices)
    corners = np.zeros((count, 3), dtype=np.int64)
    weights = np.zeros((count, 3))
    farthest = dict.fromkeys(PIECE_NAMES, 0.0)
    for vertex in target.data.vertices:
        piece = target_pieces[vertex.index]
        location, _normal, index, distance = trees[piece].find_nearest(vertex.co)
        triangle = triangles[piece][index]
        corners[vertex.index] = triangle
        weights[vertex.index] = poly_3d_calc([coords[i] for i in triangle], location)
        farthest[PIECE_NAMES[piece]] = max(farthest[PIECE_NAMES[piece]], distance)

    source_base = key_coords(source_keys.key_blocks[0])
    target_base = key_coords(target_keys.key_blocks[0])
    sampled = []
    collapsed = []
    disagreement = np.zeros(count)
    for block in source_keys.key_blocks[1:]:
        offsets = key_coords(block) - source_base
        sample = (offsets[corners] * weights[:, :, None]).sum(axis=1)
        interpolated = key_coords(target_keys.key_blocks[block.name]) - target_base
        disagreement = np.maximum(disagreement, np.linalg.norm(sample - interpolated, axis=1))
        sampled.append(sample)
        collapsed.append(interpolated)
    guarded = disagreement > GUARD_M
    for block, sample, interpolated in zip(source_keys.key_blocks[1:], sampled, collapsed):
        offsets = np.where(guarded[:, None], interpolated, sample)
        _set_key_coords(target_keys.key_blocks[block.name], target_base + offsets)
    return {
        "morphs": len(names) - 1,
        "nearest_surface_max_mm": {piece: round(distance * 1000, 3) for piece, distance in farthest.items()},
        "sample_vs_collapse_max_mm": round(float(disagreement.max(initial=0.0)) * 1000, 3),
        "sample_vs_collapse_mean_mm": round(float(disagreement.mean()) * 1000, 4) if count else 0.0,
        "guarded_vertices": int(guarded.sum()),
    }


def feather_seam(obj: bpy.types.Object, rings: int = FEATHER_RINGS) -> dict:
    """Scale every morph offset by ring / (rings + 1) on the seam (ring 0) and the `rings` rings next to it."""
    keys = obj.data.shape_keys
    count = len(obj.data.vertices)
    ring = np.full(count, rings + 1)
    neighbours: list[list[int]] = [[] for _ in range(count)]
    for edge in obj.data.edges:
        a, b = edge.vertices
        neighbours[a].append(b)
        neighbours[b].append(a)
    queue = deque(seam_vertices(obj))
    for index in queue:
        ring[index] = 0
    while queue:
        index = queue.popleft()
        if ring[index] >= rings:
            continue
        for other in neighbours[index]:
            if ring[other] > ring[index] + 1:
                ring[other] = ring[index] + 1
                queue.append(other)
    weight = np.minimum(ring, rings + 1) / (rings + 1)
    if keys is not None:
        base = key_coords(keys.key_blocks[0])
        for block in keys.key_blocks[1:]:
            _set_key_coords(block, base + (key_coords(block) - base) * weight[:, None])
    return {"rings": rings, "seam_vertices": int((ring == 0).sum()), "feathered_vertices": int((weight < 1).sum())}


# --- weights and checks ----------------------------------------------------------------------------------------------


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


def _groups_of(obj: bpy.types.Object, vertex: bpy.types.MeshVertex) -> dict[str, float]:
    return {obj.vertex_groups[group.group].name: group.weight for group in vertex.groups}


def check_seam(head: bpy.types.Object, body: bpy.types.Object, seam: set[int]) -> dict:
    """Head and Body must agree on every seam vertex (position and skin weights) and no morph may move it."""
    pairs = seam_partners(head, body)
    head_orig = int_attribute(head, ORIG_ATTRIBUTE)
    missing = len(seam) - len({head_orig[h] for h, _ in pairs})
    extra = len(seam_vertices(head)) + len(seam_vertices(body)) - 2 * len(pairs)
    gap = 0.0
    weights = 0.0
    for h, b in pairs:
        gap = max(gap, (head.data.vertices[h].co - body.data.vertices[b].co).length)
        hw = _groups_of(head, head.data.vertices[h])
        bw = _groups_of(body, body.data.vertices[b])
        for name in set(hw) | set(bw):
            weights = max(weights, abs(hw.get(name, 0.0) - bw.get(name, 0.0)))
    motion = vertex_motion(head)
    moved = float(max((motion[h] for h, _ in pairs), default=0.0))
    report = {
        "vertices": len(pairs),
        "missing": missing,
        "unpaired": extra,
        "gap_m": gap,
        "weight_difference": weights,
        "motion_m": moved,
    }
    if missing or extra or gap > 0.0 or weights > 1e-6 or moved > 0.0:
        raise SystemExit(f"the Head/Body seam does not hold in Blender: {report}")
    return report


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
