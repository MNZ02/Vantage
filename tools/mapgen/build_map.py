"""Crossing visual mesh v3 — "Haven" art direction, generated from the sim's
LEVEL_BOXES (single source of truth; collision stays in @vg/sim, this GLB is
visual only).

Himalayan/Bhutanese dzong dressing off the Haven concept art: rubble-stone
lower courses under cream plaster, dark timber framing and a red kemar band
below the roofline, red-framed windows lit warm from inside, a snow-covered
flagstone courtyard, and a burning village skyline ringing the perimeter.

Gameplay-safe by construction, unchanged from v2 and enforced the same way:
every added element stays within ~2 cm of its collision surface, or lives
where it cannot fight the sim — floor inlays (4-8 mm), ankle-height skirting,
and scenery OUTSIDE the perimeter. Two rules earn specific mention:

  * Cover props are built INSIDE their box, never on top of it. A planter's
    stone rim is the collision box; its soil and foliage are recessed below
    the lid. Foliage sprouting above a crate would be cover you can see
    through but not shoot through.
  * Nothing is added above the 3 m wall tops. siteACrateTop / siteBCrateHigh
    stand at 2.4 m, so a player on them clears the walls and holds real
    sightlines over the map — eaves and roofs there would silently delete
    angles. The Haven roofline is carried by the backdrop village instead,
    which sits beyond the perimeter where nothing can be occluded.

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
from mathutils import Euler, Vector

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/vantage/tools/mapgen")
REPO = TOOLS.parents[1]
DATA = json.loads((TOOLS / "level_data.json").read_text())

PAL = {
    # ---- courtyard: dry snow over swept flagstone.
    # Snow is the brightest thing in the scene and everything else is spaced
    # well below it. The first pass had plaster at #E3DBCA against snow at
    # #E8E8E5 — a value apart — and the whole map read as one white mass.
    "snow":       ("#EDEDEA", 0.00, 0.94),
    "snow_dirty": ("#C4C6C2", 0.00, 0.93),
    "flag":       ("#9A968E", 0.00, 0.90),
    "flag_dk":    ("#7C7973", 0.00, 0.88),
    # ---- dzong walls: rubble base, lime plaster above
    "stone":      ("#6F6B64", 0.00, 0.92),
    "stone_dk":   ("#524F49", 0.00, 0.90),
    "plaster":    ("#CFC5AE", 0.00, 0.88),
    "plaster_dk": ("#B0A489", 0.00, 0.88),
    # ---- timber framing (posts, beams, lintels)
    "timber":     ("#3E2E20", 0.00, 0.80),
    "timber_dk":  ("#251B13", 0.00, 0.78),
    # ---- roofs + the red kemar band under them
    "slate":      ("#727880", 0.02, 0.82),
    "slate_dk":   ("#565C64", 0.02, 0.80),
    "red":        ("#A6382B", 0.00, 0.70),
    "ochre":      ("#C08A3E", 0.00, 0.70),
    # ---- windows. Emission strength is the 5th slot. Kept low: the client
    # renders these against its own dusk dome, and at anything higher a wall of
    # them turns into a row of glowing billboards rather than lit rooms.
    "window":     ("#241D18", 0.00, 0.35, "#FF9440", 0.45),
    "glass":      ("#1E2429", 0.10, 0.30),   # unlit pane, for variation
    # ---- props
    "green":      ("#7B8B73", 0.06, 0.72),
    "green_dk":   ("#586852", 0.06, 0.70),
    "foliage":    ("#5D6A46", 0.00, 0.85),
    "log":        ("#9A7A52", 0.00, 0.86),
    "metal":      ("#6A737E", 0.80, 0.45),
    # ---- gameplay markers. These are UI, not scenery: site paint, spawn pads
    # and orb rings keep their original hues so they stay readable against the
    # new palette instead of blending into it.
    "site_a":     ("#2FB7A8", 0.10, 0.75),
    "site_b":     ("#D9A441", 0.10, 0.75),
    "glowline":   ("#FFC98A", 0.00, 0.45, "#FF9440"),
    "floor_edge": ("#7E7A72", 0.05, 0.88),
    # ---- burning village beyond the perimeter
    "backdrop":   ("#4A4B52", 0.00, 0.92),
    "back_roof":  ("#3B3D44", 0.00, 0.90),
    "ember":      ("#FF7A3C", 0.00, 0.50, "#FF5A1E"),
    "tree":       ("#BCB5A8", 0.00, 0.88),
}


def hex_rgba(h):
    """sRGB hex -> linear, which is what a Principled base colour wants. The
    v2 palette fed raw hex in and was tuned around that; this one is authored
    in real sRGB values, so the conversion has to be honest or every dark
    timber and stone value lands about three stops too light."""
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out + [1.0]


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
            b.inputs["Emission Strength"].default_value = spec[4] if len(spec) > 4 else 2.0
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


class Slab:
    """A deferred box (or n-gon prism). The v3 dressing emits several thousand
    of these, and creating each one as a real object via
    bpy.ops.mesh.primitive_cube_add is quadratic — the operator re-evaluates the
    depsgraph over a scene that is already thousands of objects deep, and the
    final bpy.ops.object.join over them is worse. Collecting plain records and
    welding them into one mesh at the end turns a build that ran for half an
    hour into a couple of seconds."""

    __slots__ = ("center", "size", "material", "rotation_euler", "sides")

    def __init__(self, center, size, material, sides=0):
        self.center = center
        self.size = size
        self.material = material
        self.rotation_euler = (0.0, 0.0, 0.0)
        self.sides = sides          # 0 = box, >=3 = prism about local Y


def slab(name, center, size, material, sides=0):
    return Slab(center, size, material, sides)


_BOX_V = ((-.5, -.5, -.5), (.5, -.5, -.5), (.5, .5, -.5), (-.5, .5, -.5),
          (-.5, -.5, .5), (.5, -.5, .5), (.5, .5, .5), (-.5, .5, .5))
_BOX_F = ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
          (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7))


def _prism(sides):
    """Unit prism along local Y (radius .5 in XZ, length 1), for log rounds."""
    verts, faces = [], []
    for i in range(sides):
        a = 2 * math.pi * i / sides
        c, s = 0.5 * math.cos(a), 0.5 * math.sin(a)
        verts.append((c, -0.5, s))
        verts.append((c, 0.5, s))
    for i in range(sides):
        j = (i + 1) % sides
        faces.append((2 * i, 2 * j, 2 * j + 1, 2 * i + 1))
    faces.append(tuple(range(0, 2 * sides, 2))[::-1])
    faces.append(tuple(range(1, 2 * sides, 2)))
    return verts, faces


def bake_slabs(slabs, name="map_dressing"):
    """Weld every deferred Slab into a single mesh, one material slot per
    distinct material, material_index per face."""
    mats, slot = [], {}
    verts, faces, findex = [], [], []
    for sl in slabs:
        key = sl.material.name
        if key not in slot:
            slot[key] = len(mats)
            mats.append(sl.material)
        base = len(verts)
        v, f = (_BOX_V, _BOX_F) if sl.sides < 3 else _prism(sl.sides)
        rot = Euler(sl.rotation_euler, "XYZ").to_matrix()
        sx, sy, sz = sl.size
        cx, cy, cz = sl.center
        for p in v:
            q = rot @ Vector((p[0] * sx, p[1] * sy, p[2] * sz))
            verts.append((q.x + cx, q.y + cy, q.z + cz))
        for poly in f:
            faces.append(tuple(base + k for k in poly))
            findex.append(slot[key])
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", findex)
    me.update()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    return o


STONE_TOP = 1.15     # rubble course tops out here, plaster above
KEMAR_Z = 2.66       # the red band a dzong wears just under its roofline


def snow_and_bands(o, z_stone=STONE_TOP):
    """Rubble below, plaster above, snow on anything facing the sky. Pure
    material banding at zero geometric offset, so it cannot move a surface the
    sim thinks is flat. Driving the snow off the face NORMAL rather than a
    height threshold means crate lids and step treads get it for free."""
    me = o.data
    me.materials.clear()
    for k in ("stone", "plaster", "snow"):
        me.materials.append(mat(k))
    for p in me.polygons:
        z = sum(me.vertices[v].co.z for v in p.vertices) / len(p.vertices) + o.location.z
        if p.normal.z > 0.7:
            p.material_index = 2
        else:
            p.material_index = 1 if z > z_stone else 0


def rough_stone(o, z_max=STONE_TOP, amp=0.014, seed=3):
    """Break the lower course into rubble by nudging its verts out in
    half-metre blocks. Quantising to a cell makes it read as masonry rather
    than noise, and `amp` stays inside the file's 2 cm budget."""
    rng = random.Random(seed)
    me = o.data
    sx = max(v.co.x for v in me.vertices) - min(v.co.x for v in me.vertices)
    sy = max(v.co.y for v in me.vertices) - min(v.co.y for v in me.vertices)
    thin = 0 if sx < sy else 1          # push along the wall's thin axis
    for v in me.vertices:
        if v.co.z + o.location.z > z_max:
            continue
        along = v.co.y if thin == 0 else v.co.x
        cell = (int(math.floor(along / 0.5)), int(math.floor((v.co.z + o.location.z) / 0.28)))
        rng.seed((hash(cell) ^ seed) & 0xFFFFFFFF)
        d = rng.uniform(-amp, amp)
        if thin == 0:
            v.co.x += math.copysign(d, v.co.x) if abs(v.co.x) > 1e-6 else 0.0
        else:
            v.co.y += math.copysign(d, v.co.y) if abs(v.co.y) > 1e-6 else 0.0
    me.update()


def facade(made, c, s, seed=0):
    """Dress a wall box as a dzong facade: timber sill beam at the rubble
    line, framing posts, a red kemar band under the (implied) roof, and lit
    windows on the upper storey. Everything is a proud fin of <= 2.2 cm, the
    same budget v2's panel seams used."""
    cx, cy, cz = c
    sx, sy, sz = s
    axis = 0 if sx >= sy else 1          # 0 = runs along X, 1 = runs along Y
    L = sx if axis == 0 else sy
    T = sy if axis == 0 else sx
    rng = random.Random(seed * 977 + 13)

    def band(name, z, h, m, grow=0.022):
        made.append(slab(name, (cx, cy, z), (sx + grow, sy + grow, h), m))

    if sz < 2.2:                          # parapet / half wall: capstone only
        made.append(slab("cap", (cx, cy, sz - 0.03), (sx + 0.03, sy + 0.03, 0.06),
                         mat("stone_dk")))
        return
    # coursed rubble: horizontal joint lines do most of the work of reading as
    # masonry at range, where a 1.4 cm vertex nudge alone disappears
    for z in (0.36, 0.72, 1.06):
        band(f"course{z}", z, 0.035, mat("stone_dk"), grow=0.018)
    # timber beam capping the rubble course
    band("sill", STONE_TOP, 0.16, mat("timber"))
    # The red kemar band is what makes a dzong read, but running it unbroken
    # across every box turns the whole map into one continuous stripe. Give it
    # to most walls, at a slightly varied height, so the facades break up.
    if rng.random() < 0.72:
        band("kemar", KEMAR_Z + rng.uniform(-0.07, 0.07), 0.30, mat("red"))
    band("eaveline", 2.94, 0.10, mat("timber_dk"), grow=0.03)

    # vertical framing posts, upper storey only
    n = max(2, int(L / 4.4))
    for i in range(n + 1):
        t = -L / 2 + i * L / n
        if abs(t) > L / 2 - 0.12:
            t = math.copysign(L / 2 - 0.12, t)
        pos = (cx + t, cy, 1.92) if axis == 0 else (cx, cy + t, 1.92)
        size = (0.20, sy + 0.024, 1.42) if axis == 0 else (sx + 0.024, 0.20, 1.42)
        made.append(slab("post", pos, size, mat("timber")))

    # windows between the posts. Not every bay gets one and not every one is
    # lit — a fully lit facade is what made the perimeter read as a light strip.
    for i in range(n):
        if L / n < 1.9 or rng.random() < 0.3:
            continue
        t = -L / 2 + (i + 0.5) * L / n
        _window(made, (cx, cy), (sx, sy), axis, T, t, rng)

    # painted panel — the courtyard dragon mural from the concept art
    if L > 6.0 and rng.random() < 0.3:
        t = rng.uniform(-L / 2 + 2.0, L / 2 - 2.0)
        side = rng.choice((-1, 1))
        if axis == 0:
            p, sz_ = (cx + t, cy + side * (T / 2 + 0.012), 1.85), (1.9, 0.024, 1.15)
            b, bz = (cx + t, cy + side * (T / 2 + 0.008), 1.85), (2.1, 0.016, 1.35)
        else:
            p, sz_ = (cx + side * (T / 2 + 0.012), cy + t, 1.85), (0.024, 1.9, 1.15)
            b, bz = (cx + side * (T / 2 + 0.008), cy + t, 1.85), (0.016, 2.1, 1.35)
        made.append(slab("muralbg", b, bz, mat("red")))
        made.append(slab("mural", p, sz_, mat("ochre")))


def _window(made, c, s, axis, T, t, rng):
    """One red-framed, warm-lit window on both faces of a wall."""
    cx, cy = c
    w, h, z0 = 0.84, 1.00, 1.98
    pane_mat = mat("window" if rng.random() < 0.62 else "glass")
    for side in (-1, 1):
        off = T / 2
        if axis == 0:
            pane = ((cx + t, cy + side * (off + 0.007), z0), (w, 0.014, h))
            fr = lambda dx, dz, sw, sh: (  # noqa: E731 - local frame helper
                (cx + t + dx, cy + side * (off + 0.012), z0 + dz), (sw, 0.024, sh))
        else:
            pane = ((cx + side * (off + 0.007), cy + t, z0), (0.014, w, h))
            fr = lambda dy, dz, sw, sh: (  # noqa: E731
                (cx + side * (off + 0.012), cy + t + dy, z0 + dz), (0.024, sw, sh))
        made.append(slab("pane", pane[0], pane[1], pane_mat))
        for dx, dz, sw, sh in ((0, h / 2, w + 0.16, 0.10), (0, -h / 2, w + 0.16, 0.10),
                               (-w / 2, 0, 0.10, h), (w / 2, 0, 0.10, h)):
            p, sz_ = fr(dx, dz, sw, sh)
            made.append(slab("wfr", p, sz_, mat("red")))
        # timber lintel over the head and a sill under the cill
        p, sz_ = fr(0, h / 2 + 0.14, w + 0.42, 0.11)
        made.append(slab("lintel", p, sz_, mat("timber_dk")))
        p, sz_ = fr(0, -h / 2 - 0.12, w + 0.34, 0.09)
        made.append(slab("sill", p, sz_, mat("timber")))


def crate_details(made, c, s, idx=0):
    """Dress a cover box as courtyard clutter. Which prop it becomes is chosen
    from its size so the silhouette always suits the volume the sim already
    reserved — and every prop is built INSIDE that volume. Nothing sprouts
    above the lid: foliage you can see over but not shoot over is a lie the
    collision box will not back up."""
    sx, sy, sz = s
    if sz >= 1.8 and min(sx, sy) >= 1.5:
        _container(made, c, s)              # green utility box, as in the art
    elif sz >= 1.8:
        _stone_hut(made, c, s)              # low massing block
    elif min(sx, sy) >= 1.4 or idx % 3 == 0:
        _planter(made, c, s)                # stone planter, foliage recessed
    elif idx % 3 == 1:
        _log_stack(made, c, s)
    else:
        _timber_crate(made, c, s)


# Prop tops stop this far below the collision lid. The box itself already wears
# a snow cap (snow_and_bands drives it off the face normal); letting a prop's
# lid land at exactly the same height both hides that cap and z-fights it.
LID = 0.016


def _timber_crate(made, c, s):
    cx, cy, cz = c
    sx, sy, sz = s
    f = 0.07
    for dx in (-sx / 2 + f / 2, sx / 2 - f / 2):
        for dy in (-sy / 2 + f / 2, sy / 2 - f / 2):
            made.append(slab("cp", (cx + dx, cy + dy, cz - LID / 2),
                             (f, f, sz - LID), mat("timber")))
    for dz in (-sz / 2 + f / 2, sz / 2 - f / 2 - LID):
        made.append(slab("cf", (cx, cy, cz + dz), (sx + 0.014, sy + 0.014, f),
                         mat("timber")))
    made.append(slab("cband", (cx, cy, cz), (sx + 0.010, sy + 0.010, 0.05),
                     mat("timber_dk")))


def _log_stack(made, c, s):
    """Split firewood stacked under the eaves — the log piles in the art."""
    cx, cy, cz = c
    sx, sy, sz = s
    r = min(0.075, sz / 6)
    rows = max(2, int((sz - 0.04) / (2 * r)))
    cols = max(2, int((sx - 0.04) / (2 * r)))
    for iy in range(rows):
        z = cz - sz / 2 + r + iy * (2 * r) + 0.02
        if z + r > cz + sz / 2:
            break
        for ix in range(cols):
            x = cx - sx / 2 + r + ix * (2 * r) + 0.02 + (r if iy % 2 else 0)
            if x + r > cx + sx / 2:
                continue
            made.append(slab("log", (x, cy, z), (2 * r, sy + 0.012, 2 * r),
                             mat("log" if (ix + iy) % 3 else "timber"), sides=8))


def _planter(made, c, s):
    """Stone-rimmed planter. The rim IS the cover; soil and shrubs sit in a
    recess below the lid line so the readable top of the box is still the top
    of the box."""
    cx, cy, cz = c
    sx, sy, sz = s
    top = cz + sz / 2 - LID
    rim = 0.16
    for dx, dy, w, d in ((0, -sy / 2 + rim / 2, sx, rim), (0, sy / 2 - rim / 2, sx, rim),
                         (-sx / 2 + rim / 2, 0, rim, sy - 2 * rim),
                         (sx / 2 - rim / 2, 0, rim, sy - 2 * rim)):
        made.append(slab("prim", (cx + dx, cy + dy, top - 0.09),
                         (w + 0.012, d + 0.012, 0.18), mat("stone_dk")))
    made.append(slab("soil", (cx, cy, top - 0.16),
                     (sx - 2 * rim, sy - 2 * rim, 0.06), mat("timber_dk")))
    rng = random.Random(int(abs(cx) * 100 + abs(cy) * 7))
    for _ in range(7):
        bw = rng.uniform(0.16, 0.30)
        bh = rng.uniform(0.05, 0.11)
        px = cx + rng.uniform(-1, 1) * max(0.02, sx / 2 - rim - bw / 2)
        py = cy + rng.uniform(-1, 1) * max(0.02, sy / 2 - rim - bw / 2)
        made.append(slab("shrub", (px, py, top - 0.19 + bh / 2), (bw, bw, bh),
                         mat("foliage")))


def _container(made, c, s):
    """The pale-green utility container that anchors the courtyard in the art."""
    cx, cy, cz = c
    sx, sy, sz = s
    made.append(slab("cbody", (cx, cy, cz), (sx + 0.008, sy + 0.008, sz * 0.62),
                     mat("green")))
    made.append(slab("cbase", (cx, cy, cz - sz / 2 + sz * 0.17),
                     (sx + 0.012, sy + 0.012, sz * 0.34), mat("plaster_dk")))
    made.append(slab("credline", (cx, cy, cz - sz / 2 + sz * 0.34),
                     (sx + 0.016, sy + 0.016, 0.06), mat("red")))
    n = max(2, int(sx / 0.5))
    for i in range(n):
        t = -sx / 2 + (i + 0.5) * sx / n
        made.append(slab("crib", (cx + t, cy, cz + sz * 0.06),
                         (0.05, sy + 0.014, sz * 0.44), mat("green_dk")))
    made.append(slab("clid", (cx, cy, cz + sz / 2 - 0.05 - LID),
                     (sx + 0.016, sy + 0.016, 0.10), mat("green_dk")))


def _stone_hut(made, c, s):
    """Massing block read as a shed: rubble base, plaster top, timber door."""
    cx, cy, cz = c
    sx, sy, sz = s
    made.append(slab("hband", (cx, cy, cz - sz / 2 + 0.9),
                     (sx + 0.016, sy + 0.016, 0.14), mat("timber")))
    made.append(slab("hkem", (cx, cy, cz + sz / 2 - 0.22),
                     (sx + 0.016, sy + 0.016, 0.20), mat("red")))
    dw = min(0.8, sx * 0.35)
    made.append(slab("door", (cx - sx / 2 + dw, cy - sy / 2 - 0.010, cz - sz / 2 + 0.62),
                     (dw, 0.020, 1.24), mat("timber_dk")))


def flagstones(made, seed=17, count=260):
    """Swept flagstone showing through the snow. Inlays are 5 mm proud — the
    same order as v2's floor paint — so they never trip movement, and they
    skip the site zones so the painted A/B markings stay unambiguous."""
    rng = random.Random(seed)
    H = DATA["LEVEL_HALF_EXTENT"]
    zones = [z["box"] for z in DATA["SITE_ZONES"]]

    def in_zone(x, y):
        for b in zones:
            if b["minX"] - 1 <= x <= b["maxX"] + 1 and -b["maxZ"] - 1 <= y <= -b["minZ"] + 1:
                return True
        return False

    for _ in range(count):
        x = rng.uniform(-H + 2, H - 2)
        y = rng.uniform(-H + 2, H - 2)
        if in_zone(x, y):
            continue
        w = rng.uniform(0.7, 2.1)
        d = rng.uniform(0.6, 1.6)
        r = rng.random()
        key = "flag" if r < 0.45 else "flag_dk" if r < 0.72 else "snow_dirty"
        made.append(slab("flag", (x, y, 0.005), (w, d, 0.010), mat(key)))
        if r < 0.72:      # a sliver of joint shadow so it reads as a laid slab
            made.append(slab("joint", (x, y - d / 2 + 0.03, 0.006),
                             (w, 0.06, 0.012), mat("stone_dk")))
    # trodden slush along the two main lanes
    for cx in (-22, 22):
        made.append(slab("path", (cx, 0, 0.003), (5.0, 2 * H - 6, 0.006),
                         mat("snow_dirty")))
    made.append(slab("path", (0, 0, 0.003), (2 * H - 8, 4.0, 0.006), mat("snow_dirty")))


def floor_details(made):
    """Perimeter border, site paint, spawn pads, orb markers, mid line."""
    H = DATA["LEVEL_HALF_EXTENT"]
    flagstones(made)
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


def _pitched_roof(made, c, s, inward, seed):
    """Slate roof with a deep timber eave and snow on the pitch. Roof planes
    are two tilted slabs rather than a real gable — at backdrop distance the
    silhouette is the whole job."""
    cx, cy, h = c
    w, d = s
    rng = random.Random(seed)
    pitch = rng.uniform(0.55, 0.85)
    for sgn in (-1, 1):
        o = slab("roof", (cx, cy + sgn * d * 0.26, h + pitch * 0.45),
                 (w + 0.9, d * 0.62, 0.16), mat("slate" if sgn > 0 else "slate_dk"))
        o.rotation_euler = (sgn * math.radians(26), 0, 0)
        made.append(o)
        cap = slab("roofsnow", (cx, cy + sgn * d * 0.26, h + pitch * 0.45 + 0.10),
                   (w + 0.86, d * 0.55, 0.07), mat("snow"))
        cap.rotation_euler = (sgn * math.radians(26), 0, 0)
        made.append(cap)
    made.append(slab("eave", (cx, cy, h + 0.06), (w + 1.0, d + 0.7, 0.13), mat("timber_dk")))
    made.append(slab("ridge", (cx, cy, h + pitch * 0.9), (w + 0.5, 0.22, 0.14),
                     mat("slate_dk")))
    # burning roof timbers, straight off the concept art
    if rng.random() < 0.45:
        for _ in range(rng.randint(2, 4)):
            bx = cx + rng.uniform(-w / 2, w / 2)
            bh = rng.uniform(0.7, 1.6)
            b = slab("beam", (bx, cy + rng.uniform(-d / 3, d / 3),
                              h + pitch * 0.9 + bh / 2), (0.10, 0.10, bh), mat("timber_dk"))
            b.rotation_euler = (rng.uniform(-0.5, 0.5), rng.uniform(-0.4, 0.4), 0)
            made.append(b)
        made.append(slab("fire", (cx, cy, h + pitch * 0.95), (w * 0.5, d * 0.4, 0.10),
                         mat("ember")))
    made.append(slab("bkw", (cx, cy - inward * (d / 2 + 0.03), h * 0.62),
                     (w * 0.42, 0.05, 0.5), mat("window")))


def backdrop(made, seed=11):
    """The burning village ringing the courtyard — OUTSIDE the perimeter, so
    none of it can occlude a sightline no matter how tall it gets. This is
    where Haven's roofline lives; see the module docstring for why it cannot
    live on the playable walls."""
    rng = random.Random(seed)
    H = DATA["LEVEL_HALF_EXTENT"]
    ring = H + 4.5
    step = 8.0
    n = int((2 * ring) / step)
    for side in range(4):
        for i in range(n):
            t = -ring + (i + 0.5) * step + rng.uniform(-1.4, 1.4)
            h = rng.uniform(4.5, 9.5)
            w = rng.uniform(5.0, 7.5)
            d = rng.uniform(3.0, 5.0)
            off = ring + d / 2 + rng.uniform(0, 3.0)
            flip = side in (1, 3)
            if side < 2:
                c, s = (t, math.copysign(off, 1 if flip else -1), h / 2), (w, d, h)
            else:
                c, s = (math.copysign(off, 1 if flip else -1), t, h / 2), (d, w, h)
            body = slab("bk", c, s, mat("backdrop"))
            made.append(body)
            made.append(slab("bkstone", (c[0], c[1], h * 0.22),
                             (s[0] + 0.02, s[1] + 0.02, h * 0.44), mat("stone_dk")))
            made.append(slab("bkkem", (c[0], c[1], h - 0.45),
                             (s[0] + 0.03, s[1] + 0.03, 0.34), mat("red")))
            inward = 1 if (c[1] if side < 2 else c[0]) > 0 else -1
            if side < 2:
                _pitched_roof(made, (c[0], c[1], h), (w, d), inward, seed + i * 7 + side)
            else:
                r = slab("roof", (c[0], c[1], h + 0.4), (d + 0.8, w + 0.9, 0.16),
                         mat("slate"))
                made.append(r)
                made.append(slab("roofsnow", (c[0], c[1], h + 0.5),
                                 (d + 0.7, w + 0.8, 0.07), mat("snow")))
                made.append(slab("eave", (c[0], c[1], h + 0.06),
                                 (d + 0.9, w + 1.0, 0.13), mat("timber_dk")))
            # lit windows on the face turned toward the courtyard
            for k in range(rng.randint(1, 3)):
                gz = rng.uniform(1.4, max(1.6, h - 1.6))
                if side < 2:
                    made.append(slab("bkw", (c[0] + rng.uniform(-w / 3, w / 3),
                                             c[1] - inward * (s[1] / 2 + 0.03), gz),
                                     (0.7, 0.05, 0.9), mat("window")))
                else:
                    made.append(slab("bkw", (c[0] - inward * (s[0] / 2 + 0.03),
                                             c[1] + rng.uniform(-w / 3, w / 3), gz),
                                     (0.05, 0.7, 0.9), mat("window")))
    _dead_trees(made, ring + 3.0, rng)


def _dead_trees(made, ring, rng):
    """Bare white trunks breaking the skyline, as in the concept art."""
    for _ in range(26):
        side = rng.randrange(4)
        t = rng.uniform(-ring, ring)
        off = ring + rng.uniform(1.0, 7.0)
        x, y = (t, -off) if side == 0 else (t, off) if side == 1 else \
               (-off, t) if side == 2 else (off, t)
        h = rng.uniform(5.0, 10.0)
        made.append(slab("trunk", (x, y, h / 2), (0.26, 0.26, h), mat("tree")))
        for _ in range(rng.randint(2, 4)):
            bl = rng.uniform(1.2, 2.6)
            b = slab("branch", (x + rng.uniform(-0.4, 0.4), y + rng.uniform(-0.4, 0.4),
                                rng.uniform(h * 0.55, h * 0.95)), (0.14, 0.14, bl),
                     mat("tree"))
            b.rotation_euler = (rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0), 0)
            made.append(b)


def build(bake=True, export=True):
    """bake/export are split out so the look can be iterated on cheaply: the
    Cycles AO bake over this mesh costs well over a minute, which is a poor
    trade when you are only re-checking a material or a band height."""
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
            o = grid_cube(f"box{i}_floor", c, s, mat("snow"), cell=1.2, bevel=0.02)
            made.append(o)
        elif k == "perim":
            o = grid_cube(f"box{i}_perim", c, s, mat("plaster"), cell=1.0, bevel=0.03)
            snow_and_bands(o)
            rough_stone(o, seed=i)
            made.append(o)
            facade(made, c, s, seed=i)
        elif k == "wall":
            o = grid_cube(f"box{i}_wall", c, s, mat("plaster"), cell=0.9, bevel=0.03)
            snow_and_bands(o)
            rough_stone(o, seed=i)
            made.append(o)
            facade(made, c, s, seed=i)
        elif k == "crate":
            o = grid_cube(f"box{i}_crate", c, s, mat("stone"), cell=0.6, bevel=0.03)
            snow_and_bands(o, z_stone=1e9)   # props are stone all the way up
            made.append(o)
            crate_details(made, c, s, idx=i)
        else:  # ramp / heaven steps
            o = grid_cube(f"box{i}_ramp", c, s, mat("stone"), cell=0.6, bevel=0.025)
            snow_and_bands(o, z_stone=1e9)
            made.append(o)
            made.append(slab("nose", (c[0], c[1] + s[1] / 2 - 0.04, c[2] + s[2] / 2 + 0.004),
                             (s[0] + 0.01, 0.08, 0.012), mat("timber")))
    floor_details(made)
    backdrop(made)

    # Deferred Slabs weld into one mesh; only the real objects (the 49
    # LEVEL_BOXES shells, which carry modifiers and per-face banding, plus the
    # orb rings) go through an actual join.
    objs = [o for o in made if not isinstance(o, Slab)]
    dressing = [o for o in made if isinstance(o, Slab)]
    if dressing:
        objs.append(bake_slabs(dressing))
    for o in objs:
        for cc in o.users_collection:
            cc.objects.unlink(o)
        coll.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    m = bpy.context.object
    m.name = "map_crossing"

    if not bpy.data.objects.get("map_sun"):
        bpy.ops.object.light_add(type="SUN", location=(20, -20, 40))
        sun = bpy.context.object
        sun.name = "map_sun"
        sun.data.energy = 4
        sun.rotation_euler = (math.radians(35), math.radians(-15), math.radians(20))

    me = m.data
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    if bake:
        # vertex-AO bake (Cycles) into COLOR_0
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
    if not export:
        return {"glb": None, "tris": tris, "kb": 0}

    out = REPO / "assets/models/map_crossing.glb"
    bpy.ops.object.select_all(action="DESELECT")
    m.select_set(True)
    bpy.context.view_layer.objects.active = m
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True,
                              export_yup=True, export_vertex_color="ACTIVE")
    return {"glb": str(out), "tris": tris, "kb": out.stat().st_size // 1024}


if __name__ == "__main__":
    print(build())
