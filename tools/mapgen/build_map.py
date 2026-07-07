"""Crossing visual mesh: generated from the sim's LEVEL_BOXES (single source
of truth — regenerate level_data.json via:
  node --input-type=module -e "const m=await import('./packages/sim/dist/levels.js');
  ... fs.writeFileSync('tools/mapgen/level_data.json', ...)"  (see repo history)

Builds beveled, subdivided architecture + bakes AO into vertex colors
(COLOR_0), the baked-GI lever for the graybox: collision stays in @vg/sim,
this GLB is visual-only and swaps in over the procedural graybox meshes.

Coordinate note: sim/Three.js are Y-up right-handed; Blender is Z-up. We build
at Blender (x, -z_sim, y_sim) and export with +Y-up so glTF == sim coords.
"""
import json
import math
import sys
from pathlib import Path

import bpy
import bmesh
import numpy as np

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone/tools/mapgen")
REPO = TOOLS.parents[1]
DATA = json.loads((TOOLS / "level_data.json").read_text())

PAL = {
    "floor":  ("#8E8A80", 0.0, 0.95),
    "wall":   ("#B8B2A6", 0.0, 0.9),
    "perim":  ("#9BA3AD", 0.1, 0.85),
    "crate":  ("#8A6A45", 0.0, 0.85),
    "ramp":   ("#6E6659", 0.0, 0.9),
    "trim":   ("#33C6B5", 0.2, 0.6),
}


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(key):
    name = f"map_{key}"
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    c, met, rough = PAL[key]
    b.inputs["Base Color"].default_value = hex_rgba(c)
    b.inputs["Metallic"].default_value = met
    b.inputs["Roughness"].default_value = rough
    # multiply baked vertex AO into base color (also makes the exporter emit COLOR_0)
    attr = m.node_tree.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mix = m.node_tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    mix.inputs[6].default_value = hex_rgba(c)
    m.node_tree.links.new(attr.outputs["Color"], mix.inputs[7])
    m.node_tree.links.new(mix.outputs[2], b.inputs["Base Color"])
    return m


def kind_for(i):
    if i == 0:
        return "floor"
    if DATA["PERIMETER_START"] <= i < DATA["PERIMETER_END"]:
        return "perim"
    if DATA["WALLS_START"] <= i < DATA["WALLS_END"]:
        return "wall"
    if DATA["COVER_START"] <= i < DATA["COVER_END"]:
        return "crate"
    if DATA["STAIRS_START"] <= i < DATA["STAIRS_END"]:
        return "ramp"
    return "wall"


def grid_cube(name, center, size, material, cell=0.75, bevel=0.03):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    o.location = center
    # subdivide long edges for vertex-AO resolution
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for axis in range(1):  # one pass; subdivide_edges handles all
        edges = list(bm.edges)
        cuts = {}
        for e in edges:
            length = (e.verts[0].co - e.verts[1].co).length
            n = int(length / cell)
            if n > 0:
                cuts.setdefault(n, []).append(e)
        for n, es in cuts.items():
            bmesh.ops.subdivide_edges(bm, edges=es, cuts=min(n, 24), use_grid_fill=True)
    bm.to_mesh(o.data)
    bm.free()
    if bevel:
        md = o.modifiers.new("bv", "BEVEL")
        md.width = bevel
        md.segments = 1
        md.limit_method = "ANGLE"
        md.angle_limit = math.radians(40)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier="bv")
    o.data.materials.append(material)
    return o


def build():
    coll = bpy.data.collections.get("map_crossing")
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        coll = bpy.data.collections.new("map_crossing")
        bpy.context.scene.collection.children.link(coll)

    made = []
    for i, b in enumerate(DATA["LEVEL_BOXES"]):
        cx = (b["minX"] + b["maxX"]) / 2
        cy = (b["minY"] + b["maxY"]) / 2
        cz = (b["minZ"] + b["maxZ"]) / 2
        sx = b["maxX"] - b["minX"]
        sy = b["maxY"] - b["minY"]
        sz = b["maxZ"] - b["minZ"]
        k = kind_for(i)
        cell = 1.5 if k in ("floor", "perim") else 0.75
        made.append(grid_cube(f"box{i}_{k}", (cx, -cz, cy), (sx, sz, sy), mat(k),
                              cell=cell, bevel=0.04 if k == "crate" else 0.03))
    for o in made:
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)

    # join
    bpy.ops.object.select_all(action="DESELECT")
    for o in made:
        o.select_set(True)
    bpy.context.view_layer.objects.active = made[0]
    bpy.ops.object.join()
    m = bpy.context.object
    m.name = "map_crossing"

    # sun for future combined bakes + AO bake to vertex colors
    if not bpy.data.objects.get("map_sun"):
        bpy.ops.object.light_add(type="SUN", location=(20, -20, 40))
        sun = bpy.context.object
        sun.name = "map_sun"
        sun.data.energy = 4
        sun.rotation_euler = (math.radians(35), math.radians(-15), math.radians(20))

    me = m.data
    if "Col" in me.color_attributes:
        me.color_attributes.remove(me.color_attributes["Col"])
    me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    me.color_attributes.active_color = me.color_attributes["Col"]
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    scn = bpy.context.scene
    prev = scn.render.engine
    scn.render.engine = "CYCLES"
    scn.cycles.samples = 8
    scn.render.bake.target = "VERTEX_COLORS"
    bpy.ops.object.bake(type="AO")
    scn.render.bake.target = "IMAGE_TEXTURES"
    scn.render.engine = prev

    # lift AO
    col = me.color_attributes["Col"]
    buf = np.empty(len(col.data) * 4, dtype=np.float32)
    col.data.foreach_get("color", buf)
    buf = buf.reshape(-1, 4)
    buf[:, :3] = buf[:, :3] * 0.7 + 0.3
    col.data.foreach_set("color", buf.reshape(-1))
    me.update()

    out = REPO / "assets/models/map_crossing.glb"
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True,
                              export_yup=True, export_vertex_color="ACTIVE")
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    return {"glb": str(out), "tris": tris, "kb": out.stat().st_size // 1024}


if __name__ == "__main__":
    print(build())
