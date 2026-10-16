"""The _SCULPT point attribute: what the sculpture runtime needs to know about each vertex, baked at build time.

Four channels, each 0..1 here (build.mjs stores them as normalised bytes):

- R, ambient occlusion: a Cycles AO bake (64 samples, 5 cm) of a welded copy of Head and Body, so the neck seam bakes
  as one continuous surface and both copies of a seam vertex get the same value, with the helper eyeballs in place as
  occluders, so the eyelids and sockets darken as they would around a real eye. The skin is baked at rest; the
  teeth, the tongue and the inside of the mouth with jawOpen at 1, because they are only ever seen with the mouth
  open.
- G, tone: skin 1, lips 0.8, teeth 0.92, tongue 0.55, mouth interior 0.3. The lips are MPFB's own lips region
  (the base-mesh faces its lips_solid UV layer covers, carried through the decimation); the vertices mouthRollUpper,
  mouthRollLower or mouthPucker move by more than 2 mm would cover the whole lower face of this mesh, so that rule is
  only reported. The mouth interior is the skin the lips cut off from the rest of the figure: cut the lips out of
  the skin's vertex graph, and every piece other than the outer surface that borders the lips and is mostly occluded
  is inside the mouth.
- B, part id: 0 skin, 1 teeth, 2 tongue. build.mjs stores the id itself in the byte, so a reader takes
  round(b * 255).
- A, calm, how much the water may move the vertex: 0 on the teeth and tongue, 0.35 on and around the eyes and the
  mouth (easing up to 1 over about a centimetre), 1 elsewhere.
"""

from __future__ import annotations

import math
from collections import deque

import bmesh
import bpy
import numpy as np
from mathutils import Vector, kdtree
from mathutils.bvhtree import BVHTree

from . import topology

SCULPT_ATTRIBUTE = "_SCULPT"
TONE = {"skin": 1.0, "lips": 0.8, "teeth": 0.92, "tongue": 0.55, "mouth": 0.3}
CALM_STILL = 0.0
CALM_FACE = 0.35
LIP_KEYS = ("mouthRollUpper", "mouthRollLower", "mouthPucker")
LIP_MOTION_M = 0.002
OPEN_KEY = "jawOpen"
# Calm eases from CALM_FACE to 1 between these distances: from the eyeball's surface, and from the lips and the mouth.
EYE_CALM_M = (0.006, 0.018)
MOUTH_CALM_M = (0.004, 0.016)
# A piece of skin-minus-lips that borders the lips is the mouth interior when its mean rest AO is below this.
MOUTH_MAX_AO = 0.35
AO_SAMPLES = 64
AO_DISTANCE_M = 0.05
AO_ATTRIBUTE = "ao_bake"
WELD_M = 1e-6


# --- ambient occlusion ---------------------------------------------------------------------------------------------


def _world_positions(mesh: bpy.types.Mesh, matrix) -> np.ndarray:
    co = np.empty(len(mesh.vertices) * 3, dtype=np.float32)
    mesh.vertices.foreach_get("co", co)
    local = co.reshape(-1, 3).astype(np.float64)
    m = np.array(matrix)
    return local @ m[:3, :3].T + m[:3, 3]


def _evaluated_positions(obj: bpy.types.Object) -> np.ndarray:
    """World positions of the evaluated mesh (shape keys at their current values)."""
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        return _world_positions(mesh, obj.matrix_world)
    finally:
        evaluated.to_mesh_clear()


def _joined_copy(objects: list[bpy.types.Object], name: str) -> bpy.types.Object:
    """One mesh object from the evaluated `objects`, in world space, with coincident vertices welded."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    bm = bmesh.new()
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        start = len(bm.verts)
        bm.from_mesh(mesh)
        evaluated.to_mesh_clear()
        bm.verts.ensure_lookup_table()
        bmesh.ops.transform(bm, matrix=obj.matrix_world, verts=bm.verts[start:])
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=WELD_M)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    joined = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(joined)
    return joined


def _cycles_ao(target: bpy.types.Object, visible: list[bpy.types.Object]) -> np.ndarray:
    """Bake AO into a temporary colour attribute of `target`, with only `visible` in the render."""
    scene = bpy.context.scene
    engine, world = scene.render.engine, scene.world
    hidden = {obj.name: obj.hide_render for obj in scene.objects}
    bake_world = bpy.data.worlds.new("AO bake")
    bake_world.light_settings.distance = AO_DISTANCE_M
    try:
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.samples = AO_SAMPLES
        scene.world = bake_world
        for obj in scene.objects:
            obj.hide_render = obj not in visible
        mesh = target.data
        mesh.shade_smooth()
        attribute = mesh.color_attributes.new(AO_ATTRIBUTE, "FLOAT_COLOR", "POINT")
        mesh.color_attributes.active_color = attribute
        mesh.attributes.active_color = attribute
        bpy.ops.object.select_all(action="DESELECT")
        target.select_set(True)
        bpy.context.view_layer.objects.active = target
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS", use_clear=True)
        data = np.empty(len(mesh.vertices) * 4, dtype=np.float32)
        mesh.color_attributes[AO_ATTRIBUTE].data.foreach_get("color", data)
        return data[0::4].astype(np.float64)
    finally:
        for obj in scene.objects:
            if obj.name in hidden:
                obj.hide_render = hidden[obj.name]
        scene.world = world
        scene.render.engine = engine
        bpy.data.worlds.remove(bake_world)


def _hemisphere(count: int) -> list[Vector]:
    """Cosine-weighted directions around +Z on a golden-angle spiral: deterministic and evenly spread."""
    directions = []
    for i in range(count):
        r = math.sqrt((i + 0.5) / count)
        phi = i * math.pi * (3.0 - math.sqrt(5.0))
        directions.append(Vector((r * math.cos(phi), r * math.sin(phi), math.sqrt(max(0.0, 1.0 - r * r)))))
    return directions


def _raycast_ao(target: bpy.types.Object, visible: list[bpy.types.Object]) -> np.ndarray:
    """The same quantity without Cycles: the share of AO_SAMPLES cosine-weighted rays that travel AO_DISTANCE_M."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    coords: list[Vector] = []
    triangles: list[tuple[int, ...]] = []
    for obj in visible:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        base = len(coords)
        coords.extend(obj.matrix_world @ vertex.co for vertex in mesh.vertices)
        triangles.extend(tuple(base + i for i in tri.vertices) for tri in mesh.loop_triangles)
        evaluated.to_mesh_clear()
    tree = BVHTree.FromPolygons(coords, triangles, all_triangles=True)
    directions = _hemisphere(AO_SAMPLES)
    mesh = target.data
    out = np.zeros(len(mesh.vertices))
    rotation = target.matrix_world.to_3x3()
    for vertex in mesh.vertices:
        normal = (rotation @ vertex.normal).normalized()
        origin = target.matrix_world @ vertex.co + normal * 1e-4
        frame = normal.to_track_quat("Z", "Y")
        free = sum(1 for d in directions if tree.ray_cast(origin, frame @ d, AO_DISTANCE_M)[0] is None)
        out[vertex.index] = free / len(directions)
    return out


def ambient_occlusion(objects: list[bpy.types.Object], occluders: list[bpy.types.Object]) -> tuple[dict, str]:
    """AO per vertex of each object, baked on one welded copy of them all (in their current shape-key state)."""
    bpy.context.view_layer.update()
    joined = _joined_copy(objects, "AOBake")
    visible = [joined, *occluders]
    try:
        try:
            values = _cycles_ao(joined, visible)
            method = f"cycles ao bake, {AO_SAMPLES} samples, {AO_DISTANCE_M} m, welded copy"
        except Exception as error:  # noqa: BLE001 - any Cycles failure falls back to the same measure by ray casting
            print(f"sculpt: the Cycles AO bake failed ({error}); ray casting instead")
            values = _raycast_ao(joined, visible)
            method = f"bvh ray cast, {AO_SAMPLES} rays, {AO_DISTANCE_M} m, welded copy"
        positions = _world_positions(joined.data, joined.matrix_world)
        tree = kdtree.KDTree(len(positions))
        for index, point in enumerate(positions):
            tree.insert(Vector(point), index)
        tree.balance()
        result = {}
        for obj in objects:
            lookup = [tree.find(Vector(point))[1] for point in _evaluated_positions(obj)]
            result[obj.name] = values[np.array(lookup, dtype=np.int64)]
    finally:
        mesh = joined.data
        bpy.data.objects.remove(joined, do_unlink=True)
        bpy.data.meshes.remove(mesh)
    return result, method


# --- masks ---------------------------------------------------------------------------------------------------------


def lips_mask(head: bpy.types.Object, pieces: np.ndarray) -> np.ndarray:
    """MPFB's lips region, carried through the decimation as the `lips` attribute (a collapse averages it)."""
    values = np.empty(len(pieces), dtype=np.float32)
    head.data.attributes[topology.LIPS_ATTRIBUTE].data.foreach_get("value", values)
    return (values >= 0.5) & (pieces == topology.SKIN)


def lip_motion_mask(head: bpy.types.Object, pieces: np.ndarray) -> np.ndarray:
    """The vertices mouthRollUpper, mouthRollLower or mouthPucker move by more than 2 mm. Reported only: on this mesh
    they cover the whole lower face (pucker moves the cheeks and the chin too), so they are not the lips."""
    blocks = head.data.shape_keys.key_blocks
    base = topology.key_coords(blocks[0])
    motion = np.zeros(len(pieces))
    for name in LIP_KEYS:
        motion = np.maximum(motion, np.linalg.norm(topology.key_coords(blocks[name]) - base, axis=1))
    return (motion > LIP_MOTION_M) & (pieces == topology.SKIN)


def mouth_interior(
    head: bpy.types.Object, pieces: np.ndarray, lips: np.ndarray, ao: np.ndarray
) -> tuple[np.ndarray, dict]:
    """The skin the lips enclose: cut the lips out of the skin's vertex graph; every piece but the largest (the outer
    surface) that borders the lips and is mostly occluded is inside the mouth."""
    count = len(pieces)
    free = (pieces == topology.SKIN) & ~lips
    neighbours: list[list[int]] = [[] for _ in range(count)]
    borders = np.zeros(count, dtype=bool)
    for edge in head.data.edges:
        a, b = edge.vertices
        if free[a] and free[b]:
            neighbours[a].append(b)
            neighbours[b].append(a)
        elif free[a] and lips[b]:
            borders[a] = True
        elif free[b] and lips[a]:
            borders[b] = True
    seen = np.zeros(count, dtype=bool)
    groups: list[list[int]] = []
    for start in range(count):
        if not free[start] or seen[start]:
            continue
        members = [start]
        seen[start] = True
        queue = deque([start])
        while queue:
            vertex = queue.popleft()
            for other in neighbours[vertex]:
                if not seen[other]:
                    seen[other] = True
                    members.append(other)
                    queue.append(other)
        groups.append(members)
    mask = np.zeros(count, dtype=bool)
    candidates = []
    for members in sorted(groups, key=len, reverse=True)[1:]:
        touches = bool(borders[members].any())
        shade = float(ao[members].mean())
        inside = touches and shade < MOUTH_MAX_AO
        candidates.append(
            {"vertices": len(members), "borders_lips": touches, "mean_ao": round(shade, 3), "inside": inside}
        )
        if inside:
            mask[members] = True
    return mask, {"pieces_after_cutting_the_lips": len(groups), "candidates": candidates[:8]}


def _smoothstep(edges: tuple[float, float], x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edges[0]) / (edges[1] - edges[0]), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _calm(positions: np.ndarray, parts: np.ndarray, eyes: dict, mouth_tree: kdtree.KDTree | None) -> np.ndarray:
    eye_distance = np.full(len(positions), np.inf)
    for eye in eyes.values():
        centre = np.array(eye["centre_blender"])
        from_surface = np.maximum(0.0, np.linalg.norm(positions - centre, axis=1) - eye["radius"])
        eye_distance = np.minimum(eye_distance, from_surface)
    calm = CALM_FACE + (1.0 - CALM_FACE) * _smoothstep(EYE_CALM_M, eye_distance)
    if mouth_tree is not None:
        mouth_distance = np.array([mouth_tree.find(Vector(p))[2] for p in positions])
        calm = np.minimum(calm, CALM_FACE + (1.0 - CALM_FACE) * _smoothstep(MOUTH_CALM_M, mouth_distance))
    calm[parts != 0] = CALM_STILL
    return calm


def _summary(values: np.ndarray) -> dict:
    if not len(values):
        return {}
    return {key: round(float(getattr(values, key)()), 3) for key in ("min", "mean", "max")}


# --- the attribute -------------------------------------------------------------------------------------------------


def write_sculpt(head: bpy.types.Object, body: bpy.types.Object, eyes: dict, occluders: list[bpy.types.Object]) -> dict:
    """Bake and write _SCULPT on Head and Body. Head carries its final (transferred, feathered) shape keys."""
    rest, method = ambient_occlusion([head, body], occluders)
    blocks = head.data.shape_keys.key_blocks
    blocks[OPEN_KEY].value = 1.0
    try:
        opened, _ = ambient_occlusion([head, body], occluders)
    finally:
        blocks[OPEN_KEY].value = 0.0
        bpy.context.view_layer.update()

    pieces = np.array(topology.int_attribute(head, topology.PIECE_ATTRIBUTE))
    parts = np.array([topology.PART_OF_PIECE[piece] for piece in pieces])
    lips = lips_mask(head, pieces)
    mouth, mouth_info = mouth_interior(head, pieces, lips, rest[head.name])

    head_ao = rest[head.name].copy()
    inside = mouth | (parts != 0)
    head_ao[inside] = opened[head.name][inside]
    body_ao = rest[body.name]
    pairs = topology.seam_partners(head, body)
    seam_spread = max((abs(head_ao[h] - body_ao[b]) for h, b in pairs), default=0.0)

    tone = np.full(len(pieces), TONE["skin"])
    tone[lips] = TONE["lips"]
    tone[mouth] = TONE["mouth"]
    tone[parts == 1] = TONE["teeth"]
    tone[parts == 2] = TONE["tongue"]

    head_positions = _world_positions(head.data, head.matrix_world)
    mouth_points = head_positions[lips | mouth]
    tree = None
    if len(mouth_points):
        tree = kdtree.KDTree(len(mouth_points))
        for i, point in enumerate(mouth_points):
            tree.insert(Vector(point), i)
        tree.balance()
    head_calm = _calm(head_positions, parts, eyes, tree)
    body_positions = _world_positions(body.data, body.matrix_world)
    body_parts = np.zeros(len(body_positions), dtype=np.int64)
    body_calm = _calm(body_positions, body_parts, eyes, tree)

    _write(head, np.column_stack([head_ao, tone, parts, head_calm]))
    _write(body, np.column_stack([body_ao, np.full(len(body_parts), TONE["skin"]), body_parts, body_calm]))
    return {
        "ao_method": method,
        "seam_ao_difference": round(float(seam_spread), 6),
        "head": {
            "ao": _summary(head_ao),
            "calm": _summary(head_calm),
            "vertices": {
                "lips": int(lips.sum()),
                "moved_over_2mm_by_lip_keys": int(lip_motion_mask(head, pieces).sum()),
                "mouth_interior": int(mouth.sum()),
                "teeth": int((parts == 1).sum()),
                "tongue": int((parts == 2).sum()),
                "calmed": int(((head_calm > 0) & (head_calm < 0.999)).sum()),
            },
            "mouth": mouth_info,
        },
        "body": {"ao": _summary(body_ao), "calm": _summary(body_calm)},
    }


def _write(obj: bpy.types.Object, rows: np.ndarray) -> None:
    mesh = obj.data
    existing = mesh.attributes.get(SCULPT_ATTRIBUTE)
    if existing is not None:
        mesh.attributes.remove(existing)
    attribute = mesh.attributes.new(SCULPT_ATTRIBUTE, "FLOAT_COLOR", "POINT")
    attribute.data.foreach_set("color", rows.astype(np.float32).ravel())
