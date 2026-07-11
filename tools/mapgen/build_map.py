"""Crossing visual mesh v2 — generated from the sim's LEVEL_BOXES (single
source of truth; collision stays in @vg/sim, this GLB is visual only).

v2 detail pass, gameplay-safe by construction: every added element stays
within ~2 cm of the collision surface, or lives where it can't fight the sim
— floor paint (3-6 mm), skirting at ankle height, light strips above head
height, and a cosmetic skyline OUTSIDE the perimeter. Walls get wainscot /
plaster banding via material splits (zero geometry offset), panel seams as
2 mm-proud fins, crates get flush edge frames + shallow face panels, heaven
steps get metal nose strips.

Coordinate note: sim/Three.js are Y-up right-handed; Blender is Z-up. We
build at Blender (x, -z_sim, y_sim) and export +Y-up so glTF == sim coords.

Live: import build_map; build_map.build()
Headless: blender --background --python tools/mapgen/build_map.py
"""
import json
import math
import random
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
    "floor":      ("#8E8A80", 0.02, 0.92),
    "floor_edge": ("#6E6A62", 0.05, 0.88),
    "wall_lo":    ("#7E8894", 0.08, 0.80),   # wainscot band
    "wall_hi":    ("#C2BBAD", 0.02, 0.88),   # plaster
    "wall_seam":  ("#4A5058", 0.20, 0.70),
    "perim":      ("#9BA3AD", 0.10, 0.85),
    "trim":       ("#33C6B5", 0.25, 0.55),
    "glowline":   ("#5FF2DE", 0.00, 0.40, "#33E0CC"),
    "site_a":     ("#2FB7A8", 0.10, 0.75),
    "site_b":     ("#D9A441", 0.10, 0.75),
    "metal":      ("#6A737E", 0.85, 0.40),
    "crate":      ("#A5825A", 0.02, 0.85),
    "crate_dk":   ("#6E5238", 0.05, 0.82),
    "ramp":       ("#6E6659", 0.05, 0.88),
    "skirt":      ("#3A4048", 0.15, 0.75),
    "backdrop":   ("#39414E", 0.05, 0.90),
    "back_glow":  ("#8AB6C9", 0.00, 0.60, "#6FA5BC"),
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
    spec = PAL[key]
    b.inputs["Base Color"].default_value = hex_rgba(spec[0])
    b.inputs["Metallic"].default_value = spec[1]
    b.inputs["Roughness"].default_value = spec[2]
    if len(spec) > 3:
        for n in ("Emission Color", "Emission"):
            if n in b.inputs:
                b.inputs[n].default_value = hex_rgba(spec[3])
                break
        if "Emission Strength" in b.inputs:
            b.inputs["Emission Strength"].default_value = 2.0
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


def grid_cube(name, center, size, material, cell=0.75, bevel=0.02):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    o.location = center
    bm = bmesh.new()
    bm.from_mesh(o.data)
    edges = list(bm.edges)
    cuts = {}
    for e in edges:
        length = (e.verts[0].co - e.verts[1].co).length
        n = int(length / cell)
        if n > 0:
            cuts.setdefault(n, []).append(e)
    for n, es in cuts.items():
        bmesh.ops.subdivide_edges(bm, edges=es, cuts=min(n, 40), use_grid_fill=True)
    bm.to_mesh(o.data)
    bm.free()
    if bevel:
        md = o.modifiers.new("bv", "BEVEL")
        md.width = bevel
        md.segments = 1
        md.limit_method = "ANGLE"
        md.angle_limit = math.radians(40)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.ops.object.modifier_apply(modifier="bv")
    o.data.materials.append(material)
    return o


def slab(name, center, size, material):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    o.location = center
    o.data.materials.append(material)
    return o


def band_wall_materials(o, z_split=0.9, z_top=2.85):
    """Assign wainscot / plaster / top-cap materials by face height (zero
    geometry offset — pure material banding)."""
    me = o.data
    me.materials.clear()
    me.materials.append(mat("wall_lo"))
    me.materials.append(mat("wall_hi"))
    me.materials.append(mat("wall_seam"))
    for p in me.polygons:
        z = sum(me.vertices[v].co.z for v in p.vertices) / len(p.vertices) + o.location.z
        if z > z_top:
            p.material_index = 2
        elif z > z_split:
            p.material_index = 1
        else:
            p.material_index = 0


def wall_details(made, c, s, glow=True):
    """Skirt (ankle), seam fins (2 mm), glow light-line above head height on
    the two long faces of a wall box centered c, size s (Blender coords)."""
    cx, cy, cz = c
    sx, sy, sz = s
    long_axis = 0 if sx >= sy else 1
    L = (sx if long_axis == 0 else sy)
    T = (sy if long_axis == 0 else sx)
    if sz < 2.2:  # low cover/half wall: just a skirt
        made.append(slab("skirt", (cx, cy, 0.06), (sx + 0.03, sy + 0.03, 0.12), mat("skirt")))
        return
    made.append(slab("skirt", (cx, cy, 0.075), (sx + 0.04, sy + 0.04, 0.15), mat("skirt")))
    if glow:
        made.append(slab("lightline", (cx, cy, 2.86), (sx + 0.022, sy + 0.022, 0.05),
                         mat("glowline")))
        made.append(slab("capline", (cx, cy, 2.96), (sx + 0.016, sy + 0.016, 0.045),
                         mat("wall_seam")))
    n = max(1, int(L / 3.2))
    for i in range(1, n + 1):
        t = -L / 2 + i * L / (n + 1)
        if long_axis == 0:
            made.append(slab("seam", (cx + t, cy, 1.45), (0.05, T + 0.004, 2.72),
                             mat("wall_seam")))
        else:
            made.append(slab("seam", (cx, cy + t, 1.45), (T + 0.004, 0.05, 2.72),
                             mat("wall_seam")))


def crate_details(made, c, s):
    cx, cy, cz = c
    sx, sy, sz = s
    f = 0.05  # frame width, flush-proud 6 mm
    for dz in (-sz / 2 + f / 2, sz / 2 - f / 2):
        for ax in range(2):
            if ax == 0:
                made.append(slab("cf", (cx, cy - sy / 2 + f / 2, cz + dz),
                                 (sx + 0.012, f, f), mat("metal")))
                made.append(slab("cf", (cx, cy + sy / 2 - f / 2, cz + dz),
                                 (sx + 0.012, f, f), mat("metal")))
            else:
                made.append(slab("cf", (cx - sx / 2 + f / 2, cy, cz + dz),
                                 (f, sy + 0.012, f), mat("metal")))
                made.append(slab("cf", (cx + sx / 2 - f / 2, cy, cz + dz),
                                 (f, sy + 0.012, f), mat("metal")))
    # vertical corner posts
    for dx in (-sx / 2 + f / 2, sx / 2 - f / 2):
        for dy in (-sy / 2 + f / 2, sy / 2 - f / 2):
            made.append(slab("cp", (cx + dx, cy + dy, cz), (f, f, sz + 0.012), mat("metal")))
    # face panels (6 mm proud, inset from frame)
    if sx > 0.7 and sz > 0.7:
        made.append(slab("panel", (cx, cy - sy / 2 - 0.004, cz),
                         (sx - 2.6 * f, 0.012, sz - 2.6 * f), mat("crate_dk")))
        made.append(slab("panel", (cx, cy + sy / 2 + 0.004, cz),
                         (sx - 2.6 * f, 0.012, sz - 2.6 * f), mat("crate_dk")))
    if sy > 0.7 and sz > 0.7:
        made.append(slab("panel", (cx - sx / 2 - 0.004, cy, cz),
                         (0.012, sy - 2.6 * f, sz - 2.6 * f), mat("crate_dk")))
        made.append(slab("panel", (cx + sx / 2 + 0.004, cy, cz),
                         (0.012, sy - 2.6 * f, sz - 2.6 * f), mat("crate_dk")))
    # hazard corner ticks on the top face
    made.append(slab("tick", (cx - sx / 2 + 0.14, cy - sy / 2 + 0.14, cz + sz / 2 + 0.004),
                     (0.22, 0.06, 0.008), mat("trim")))
    made.append(slab("tick", (cx + sx / 2 - 0.14, cy + sy / 2 - 0.14, cz + sz / 2 + 0.004),
                     (0.22, 0.06, 0.008), mat("trim")))


def floor_details(made):
    """Perimeter border, site paint, spawn pads, orb markers, mid line."""
    H = DATA["LEVEL_HALF_EXTENT"]
    # border ring just inside the perimeter walls
    for sx, sy, cx, cy in ((2 * H - 1.0, 0.5, 0, -(H - 0.75)), (2 * H - 1.0, 0.5, 0, H - 0.75),
                           (0.5, 2 * H - 1.0, -(H - 0.75), 0), (0.5, 2 * H - 1.0, H - 0.75, 0)):
        made.append(slab("border", (cx, cy, 0.004), (sx, sy, 0.008), mat("floor_edge")))
    # site zones: painted borders + corner chevrons
    for z in DATA["SITE_ZONES"]:
        b = z["box"]
        m = mat("site_a") if z["name"] == "A" else mat("site_b")
        cx = (b["minX"] + b["maxX"]) / 2
        cyz = -(b["minZ"] + b["maxZ"]) / 2
        w = b["maxX"] - b["minX"]
        d = b["maxZ"] - b["minZ"]
        t = 0.22
        made.append(slab("sb", (cx, cyz - d / 2 + t / 2, 0.005), (w, t, 0.01), m))
        made.append(slab("sb", (cx, cyz + d / 2 - t / 2, 0.005), (w, t, 0.01), m))
        made.append(slab("sb", (cx - w / 2 + t / 2, cyz, 0.005), (t, d - 2 * t, 0.01), m))
        made.append(slab("sb", (cx + w / 2 - t / 2, cyz, 0.005), (t, d - 2 * t, 0.01), m))
        made.append(slab("sbc", (cx, cyz, 0.005), (1.4, 0.16, 0.01), m))
        made.append(slab("sbc2", (cx, cyz, 0.005), (0.16, 1.4, 0.01), m))
    # mid line (attacker/defender halves)
    made.append(slab("midline", (0, -DATA["SITE_LINE_Z"], 0.004), (2 * H - 2.0, 0.14, 0.008),
                     mat("floor_edge")))
    # spawn pads
    for spawns, m in ((DATA["ATTACKER_SPAWNS"], mat("site_a")),
                      (DATA["DEFENDER_SPAWNS"], mat("site_b"))):
        for sp in spawns:
            made.append(slab("pad", (sp["x"], -sp["z"], 0.004), (1.1, 1.1, 0.008), m))
    # orb spots: rings
    for ob in DATA["ORB_SPOTS"]:
        bpy.ops.mesh.primitive_torus_add(major_radius=0.55, minor_radius=0.05,
                                         major_segments=28, minor_segments=8,
                                         location=(ob["x"], -ob["z"], 0.02))
        t = bpy.context.object
        t.scale = (1, 1, 0.35)
        bpy.ops.object.transform_apply(scale=True)
        t.data.materials.append(mat("glowline"))
        made.append(t)


def backdrop(made, seed=11):
    """Cosmetic skyline OUTSIDE the perimeter — silhouette + lit strips."""
    rng = random.Random(seed)
    H = DATA["LEVEL_HALF_EXTENT"]
    ring = H + 4.5
    step = 7.0
    n = int((2 * ring) / step)
    for side in range(4):
        for i in range(n):
            t = -ring + (i + 0.5) * step + rng.uniform(-1.2, 1.2)
            h = rng.uniform(3.5, 8.5)
            w = rng.uniform(4.0, 6.5)
            d = rng.uniform(2.0, 4.0)
            off = ring + d / 2 + rng.uniform(0, 2.5)
            if side == 0:
                c, s = (t, -off, h / 2), (w, d, h)
            elif side == 1:
                c, s = (t, off, h / 2), (w, d, h)
            elif side == 2:
                c, s = (-off, t, h / 2), (d, w, h)
            else:
                c, s = (off, t, h / 2), (d, w, h)
            made.append(slab("bk", c, s, mat("backdrop")))
            if rng.random() < 0.45:
                gz = rng.uniform(1.5, h - 0.8)
                if side < 2:
                    made.append(slab("bkw", (c[0], c[1] - math.copysign(s[1] / 2 + 0.02, c[1]), gz),
                                     (w * 0.55, 0.04, 0.18), mat("back_glow")))
                else:
                    made.append(slab("bkw", (c[0] - math.copysign(s[0] / 2 + 0.02, c[0]), c[1], gz),
                                     (0.04, w * 0.55, 0.18), mat("back_glow")))


def build():
    coll = bpy.data.collections.get("map_crossing")
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    else:
        coll = bpy.data.collections.new("map_crossing")
        bpy.context.scene.collection.children.link(coll)
    for m in list(bpy.data.materials):
        if m.name.startswith("map_"):
            bpy.data.materials.remove(m)

    made = []
    for i, b in enumerate(DATA["LEVEL_BOXES"]):
        cx = (b["minX"] + b["maxX"]) / 2
        cy = (b["minY"] + b["maxY"]) / 2
        cz = (b["minZ"] + b["maxZ"]) / 2
        sx = b["maxX"] - b["minX"]
        sy = b["maxY"] - b["minY"]
        sz = b["maxZ"] - b["minZ"]
        k = kind_for(i)
        c = (cx, -cz, cy)          # Blender coords
        s = (sx, sz, sy)
        if k == "floor":
            o = grid_cube(f"box{i}_floor", c, s, mat("floor"), cell=1.2, bevel=0.02)
            made.append(o)
        elif k == "perim":
            o = grid_cube(f"box{i}_perim", c, s, mat("perim"), cell=1.0, bevel=0.03)
            band_wall_materials(o)
            made.append(o)
            wall_details(made, c, s, glow=True)
        elif k == "wall":
            o = grid_cube(f"box{i}_wall", c, s, mat("wall_hi"), cell=0.9, bevel=0.03)
            band_wall_materials(o)
            made.append(o)
            wall_details(made, c, s, glow=s[2] > 2.2)
        elif k == "crate":
            o = grid_cube(f"box{i}_crate", c, s, mat("crate"), cell=0.6, bevel=0.03)
            made.append(o)
            crate_details(made, c, s)
        else:  # ramp / heaven steps
            o = grid_cube(f"box{i}_ramp", c, s, mat("ramp"), cell=0.6, bevel=0.025)
            made.append(o)
            made.append(slab("nose", (c[0], c[1] + s[1] / 2 - 0.04, c[2] + s[2] / 2 + 0.004),
                             (s[0] + 0.01, 0.08, 0.012), mat("metal")))
    floor_details(made)
    backdrop(made)

    for o in made:
        for cc in o.users_collection:
            cc.objects.unlink(o)
        coll.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in made:
        o.select_set(True)
    bpy.context.view_layer.objects.active = made[0]
    bpy.ops.object.join()
    m = bpy.context.object
    m.name = "map_crossing"

    if not bpy.data.objects.get("map_sun"):
        bpy.ops.object.light_add(type="SUN", location=(20, -20, 40))
        sun = bpy.context.object
        sun.name = "map_sun"
        sun.data.energy = 4
        sun.rotation_euler = (math.radians(35), math.radians(-15), math.radians(20))

    # vertex-AO bake (Cycles) into COLOR_0
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
    scn.cycles.samples = 10
    scn.render.bake.target = "VERTEX_COLORS"
    bpy.ops.object.bake(type="AO")
    scn.render.bake.target = "IMAGE_TEXTURES"
    scn.render.engine = prev

    col = me.color_attributes["Col"]
    buf = np.empty(len(col.data) * 4, dtype=np.float32)
    col.data.foreach_get("color", buf)
    buf = buf.reshape(-1, 4)
    buf[:, :3] = buf[:, :3] * 0.72 + 0.28
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
