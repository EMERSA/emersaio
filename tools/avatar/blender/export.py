"""glTF export with exactly what the wire renderer needs: positions, skin, morph positions, clips. Nothing else."""

from __future__ import annotations

import os

import bpy

# No normals, tangents, UVs, colours, materials or images: the barycentric wire shader needs none of them and
# every attribute would cost bytes on a phone. Morph normals are off for the same reason.
EXPORT_SETTINGS = {
    "export_format": "GLB",
    "export_apply": False,
    "export_yup": True,
    "export_texcoords": False,
    "export_normals": False,
    "export_tangents": False,
    "export_attributes": False,
    "export_vertex_color": "NONE",
    "export_materials": "NONE",
    "export_image_format": "NONE",
    "export_skins": True,
    "export_influence_nb": 4,
    "export_all_influences": False,
    "export_def_bones": False,
    "export_hierarchy_flatten_bones": False,
    "export_leaf_bone": False,
    "export_rest_position_armature": True,
    "export_morph": True,
    "export_morph_normal": False,
    "export_morph_tangent": False,
    "export_morph_animation": False,
    "export_try_sparse_sk": False,
    "export_animations": True,
    "export_animation_mode": "ACTIONS",
    "export_force_sampling": True,
    "export_frame_step": 1,
    "export_frame_range": False,
    "export_optimize_animation_size": True,
    "export_anim_single_armature": True,
    "export_reset_pose_bones": True,
    "export_nla_strips": True,
    "export_bake_animation": False,
    "export_current_frame": False,
    "export_extras": False,
    "export_lights": False,
    "export_cameras": False,
    "use_selection": True,
    "use_visible": False,
    "use_active_scene": True,
    "use_mesh_edges": False,
    "use_mesh_vertices": False,
}


def export_glb(path: str, objects: list[bpy.types.Object]) -> int:
    """Export only `objects` (the armature and the two meshes) and return the file size in bytes."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.hide_viewport = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    available = {prop.identifier for prop in bpy.ops.export_scene.gltf.get_rna_type().properties}
    settings = {key: value for key, value in EXPORT_SETTINGS.items() if key in available}
    dropped = sorted(set(EXPORT_SETTINGS) - available)
    if dropped:
        print(f"export: this Blender does not know {dropped}; using its defaults for them")
    bpy.ops.export_scene.gltf(filepath=path, **settings)
    return os.path.getsize(path)
