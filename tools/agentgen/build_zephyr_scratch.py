"""Fresh Zephyr character builder.

This intentionally does not reuse the retired v4/v5 Zephyr costume.  It starts
from the CC0 realistic female base and its fitted eyes, then builds an original
athletic wind-runner silhouette: swept pearl hair, sleeveless layered shell,
loose tactical trousers, low shoes, forearm wraps and two cloth streamers.

Blender coordinates are meters, Z-up, face +Y.  The output collection is named
``agent_zephyr`` so ``rig_export.rig_and_export('zephyr')`` can consume it.
"""

import math
import sys
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/vantage/tools/agentgen")
WEAPONS = TOOLS.parent / "weapongen"
for p in (str(TOOLS), str(WEAPONS)):
    if p not in sys.path:
        sys.path.insert(0, p)
import build_weapons as W  # noqa: E402


VENDOR_BLEND = (TOOLS.parents[1] / "assets/blender/vendor/"
                "human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend")
BODY_NAME = "GEO-body_female_realistic"
EYE_NAMES = (f"{BODY_NAME}.eye.L", f"{BODY_NAME}.eye.R")

PALETTE = {
    "skin":        ("#B9785D", 0.00, 0.72),
    "eye_white":   ("#E8ECE8", 0.00, 0.55),
    "iris":        ("#3B8D8B", 0.00, 0.40),
    "pupil":       ("#10242A", 0.00, 0.42),
    "brow":        ("#52666A", 0.00, 0.70),
    "hair":        ("#EEF1EC", 0.00, 0.62),
    "hair_shadow": ("#A9C2C4", 0.00, 0.68),
    "suit":        ("#172832", 0.00, 0.78),
    "ivory":       ("#ECEAE2", 0.00, 0.74),
    "pants":       ("#344753", 0.00, 0.82),
    "gear":        ("#16212A", 0.02, 0.76),
    "accent":      ("#3DB9A5", 0.00, 0.68),
    "warm":        ("#D58A58", 0.00, 0.68),
    "glow":        ("#9BE7D5", 0.00, 0.45, "#65D7C1"),
}


def _rgba(value):
    value = value.lstrip("#")
    return [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def material(key):
    name = f"ag_zephyr_{key}"
    old = bpy.data.materials.get(name)
    if old:
        return old
    spec = PALETTE[key]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = _rgba(spec[0])
    bsdf.inputs["Metallic"].default_value = spec[1]
    bsdf.inputs["Roughness"].default_value = spec[2]
    if len(spec) > 3:
        for n in ("Emission Color", "Emission"):
            if n in bsdf.inputs:
                bsdf.inputs[n].default_value = _rgba(spec[3])
                break
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 2.2
    return m


def _clear_build():
    coll = bpy.data.collections.get("agent_zephyr")
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    for o in list(bpy.data.objects):
        if o.name in (BODY_NAME, *EYE_NAMES, "zephyr_body"):
            bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.materials):
        if m.name.startswith("ag_zephyr_"):
            bpy.data.materials.remove(m)
    if not coll:
        coll = bpy.data.collections.new("agent_zephyr")
        bpy.context.scene.collection.children.link(coll)
    return coll


def _append_human(height=1.72):
    names = [BODY_NAME, *EYE_NAMES]
    with bpy.data.libraries.load(str(VENDOR_BLEND)) as (data_from, data_to):
        data_to.objects = names
    objs = {o.name: o for o in data_to.objects if o}
    for o in objs.values():
        if not o.users_collection:
            bpy.context.scene.collection.objects.link(o)
    # Force dependency evaluation before reading child world matrices; the eye
    # objects carry a parent inverse and otherwise appear at the origin.
    bpy.context.view_layer.update()
    for o in objs.values():
        world = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = world
        W._activate(o)
        for md in list(o.modifiers):
            bpy.ops.object.modifier_remove(modifier=md.name)
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    body = objs[BODY_NAME]
    coords = [v.co for v in body.data.vertices]
    cx = (min(v.x for v in coords) + max(v.x for v in coords)) * 0.5
    cy = (min(v.y for v in coords) + max(v.y for v in coords)) * 0.5
    z0, z1 = min(v.z for v in coords), max(v.z for v in coords)
    scale = height / (z1 - z0)

    # Rotate 180 degrees around Z while centering/scaling every component with
    # exactly the same affine transform, so the fitted eyes stay fitted.
    for o in objs.values():
        for v in o.data.vertices:
            v.co.x = -(v.co.x - cx) * scale
            v.co.y = -(v.co.y - cy) * scale
            v.co.z = (v.co.z - z0) * scale
        o.data.update()

    body.name = "zephyr_body"
    # Push the realistic donor toward a lean athletic runner: trim leg and hip
    # volume, narrow the torso, and reduce the bust projection. The face,
    # shoulders, hands and feet remain untouched.
    for v in body.data.vertices:
        x, y, z = v.co
        if 0.18 < z < 0.95 and abs(x) < 0.25:
            center = math.copysign(0.095, x if abs(x) > 1e-5 else 1.0)
            v.co.x = center + (x - center) * 0.87
            v.co.y *= 0.91
        elif 0.95 <= z < 1.15 and abs(x) < 0.28:
            v.co.x *= 0.90
            v.co.y *= 0.92
        elif 1.15 <= z < 1.45 and abs(x) < 0.25:
            v.co.x *= 0.94
            if y > 0.025:
                v.co.y = 0.025 + (y - 0.025) * 0.72
    body.data.update()
    body.data.materials.clear()
    body.data.materials.append(material("skin"))
    W._smooth(body, 58)

    eyes = []
    for side, old_name in (("L", EYE_NAMES[0]), ("R", EYE_NAMES[1])):
        o = objs[old_name]
        o.name = f"zephyr_eye.{side}"
        o.data.materials.clear()
        o.data.materials.append(material("eye_white"))
        W._smooth(o, 60)
        eyes.append(o)
    return body, eyes


def ellipsoid(name, loc, scale, mat, segments=20, rings=12, rot=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings,
                                         radius=1.0, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    if rot:
        o.rotation_euler = [math.radians(v) for v in rot]
    bpy.ops.object.transform_apply(rotation=True, scale=True)
    o.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return o


def shell_from_body(body, name, predicate, offset, thick, mat,
                    boundary_smooth=2):
    """Extract a coordinate-masked garment shell from the realistic body."""
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.faces.ensure_lookup_table()
    keep = [f for f in bm.faces if predicate(f.calc_center_median())]
    if not keep:
        bm.free()
        raise ValueError(f"empty shell: {name}")
    keep_set = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep_set],
                     context="FACES")
    bm.verts.ensure_lookup_table()
    for v in bm.verts:
        v.co += v.normal * offset
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)

    if boundary_smooth:
        bm = bmesh.new()
        bm.from_mesh(me)
        boundary = [v for v in bm.verts
                    if any(len(e.link_faces) == 1 for e in v.link_edges)]
        bset = set(boundary)
        for _ in range(boundary_smooth):
            moved = {}
            for v in boundary:
                near = [e.other_vert(v) for e in v.link_edges
                        if e.other_vert(v) in bset and len(e.link_faces) == 1]
                if len(near) >= 2:
                    avg = sum((n.co for n in near), Vector()) / len(near)
                    moved[v] = v.co * 0.55 + avg * 0.45
            for v, co in moved.items():
                v.co = co
        bm.to_mesh(me)
        bm.free()

    W._activate(o)
    md = o.modifiers.new("cloth_thickness", "SOLIDIFY")
    md.thickness = thick
    md.offset = 1.0
    bpy.ops.object.modifier_apply(modifier=md.name)
    W._smooth(o, 55)
    return o


def tube_loft(name, points, widths, depths, mat, up_hint=(0, 0, 1),
              ring=8, subsurf=1):
    """Tangent-framed elliptical loft for hair, shoes and cloth strips."""
    pts = [Vector(p) for p in points]
    if isinstance(widths, (int, float)):
        widths = [float(widths)] * len(pts)
    if isinstance(depths, (int, float)):
        depths = [float(depths)] * len(pts)
    if not (len(pts) == len(widths) == len(depths)):
        raise ValueError("tube_loft point/width/depth lengths differ")
    up = Vector(up_hint).normalized()
    bm = bmesh.new()
    loops = []
    for i, (p, width, depth) in enumerate(zip(pts, widths, depths)):
        tangent = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        tangent.normalize()
        side = tangent.cross(up)
        if side.length < 1e-5:
            fallback = Vector((1, 0, 0)) if abs(tangent.x) < 0.8 else Vector((0, 1, 0))
            side = tangent.cross(fallback)
        side.normalize()
        vertical = tangent.cross(side).normalized()
        loop = []
        for j in range(ring):
            a = 2 * math.pi * j / ring
            loop.append(bm.verts.new(p + side * math.cos(a) * width +
                                     vertical * math.sin(a) * depth))
        loops.append(loop)
    for a, b in zip(loops, loops[1:]):
        for j in range(ring):
            k = (j + 1) % ring
            bm.faces.new((a[j], a[k], b[k], b[j]))
    bm.faces.new(reversed(loops[0]))
    bm.faces.new(loops[-1])
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(mat)
    if subsurf:
        W._activate(o)
        md = o.modifiers.new("soft_form", "SUBSURF")
        md.levels = subsurf
        bpy.ops.object.modifier_apply(modifier=md.name)
    W._smooth(o, 55)
    return o


def panel(name, outline_xz, y, mat, thick=0.004, bevel=0.002):
    verts = [(x, y, z) for x, z in outline_xz]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], [tuple(range(len(verts)))])
    me.materials.append(mat)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    W._activate(o)
    md = o.modifiers.new("panel_thickness", "SOLIDIFY")
    md.thickness = thick
    md.offset = 0
    bpy.ops.object.modifier_apply(modifier=md.name)
    if bevel:
        W.bevel(o, bevel, segs=2, deg=20)
    W._smooth(o, 45)
    return o


def hair_cap(mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=1.0,
                                         location=(0, -0.004, 1.625))
    o = bpy.context.object
    o.name = "z_hair_cap"
    o.scale = (0.094, 0.086, 0.112)
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    remove = []
    for f in bm.faces:
        c = f.calc_center_median()
        # Clean face opening with a slightly asymmetric forehead line.
        front_line = 1.654 + c.x * 0.12
        if c.z < 1.540 or (c.y > 0.020 and c.z < front_line):
            remove.append(f)
    bmesh.ops.delete(bm, geom=remove, context="FACES")
    bm.to_mesh(o.data)
    bm.free()
    o.data.materials.append(mat)
    W._activate(o)
    md = o.modifiers.new("hair_thickness", "SOLIDIFY")
    md.thickness = 0.008
    md.offset = 1.0
    bpy.ops.object.modifier_apply(modifier=md.name)
    W._smooth(o, 60)
    return o


def _eye_details(eyes, made, mats):
    centers = []
    for side, eye in zip(("L", "R"), eyes):
        xs = [v.co.x for v in eye.data.vertices]
        ys = [v.co.y for v in eye.data.vertices]
        zs = [v.co.z for v in eye.data.vertices]
        c = Vector(((min(xs) + max(xs)) * 0.5,
                    max(ys) + 0.0005,
                    (min(zs) + max(zs)) * 0.5))
        centers.append(c)
        made.append(ellipsoid(f"z_iris.{side}", c, (0.0062, 0.0018, 0.0062),
                              mats["iris"], segments=16, rings=10))
        made.append(ellipsoid(f"z_pupil.{side}", c + Vector((0, 0.0018, 0)),
                              (0.0027, 0.0010, 0.0027), mats["pupil"],
                              segments=14, rings=8))
        made.append(ellipsoid(f"z_eye_glint.{side}",
                              c + Vector((0.0016, 0.0026, 0.0020)),
                              (0.0011, 0.0006, 0.0011), mats["glow"],
                              segments=10, rings=6))
    for side, c, flip in zip(("L", "R"), centers, (1, -1)):
        made.append(tube_loft(f"z_brow.{side}", [
            (c.x - 0.018 * flip, c.y + 0.006, c.z + 0.026),
            (c.x, c.y + 0.008, c.z + 0.030),
            (c.x + 0.020 * flip, c.y + 0.004, c.z + 0.025),
        ], [0.0013, 0.0018, 0.0007], [0.0010, 0.0012, 0.0006],
            mats["brow"], up_hint=(0, 1, 0), ring=6, subsurf=1))


def build():
    coll = _clear_build()
    mats = {k: material(k) for k in PALETTE}
    body, eyes = _append_human()
    made = [body, *eyes]
    _eye_details(eyes, made, mats)

    # Fitted petrol undersuit; its upper edge sits below the neck so the face
    # and jaw remain completely untouched.
    top = shell_from_body(
        body, "z_top_base",
        lambda c: 1.035 < c.z < 1.430 and abs(c.x) < 0.215,
        0.005, 0.006, mats["suit"], boundary_smooth=3)
    made.append(top)

    # Clean sea-glass sleeveless wind shell over the dark compression torso.
    jacket = shell_from_body(
        body, "z_wind_shell",
        lambda c: (1.190 + 0.030 * ((c.x + 0.18) / 0.36)) < c.z < 1.425
                  and abs(c.x) < 0.195,
        0.012, 0.007, mats["accent"], boundary_smooth=4)
    made.append(jacket)
    made.append(tube_loft("z_front_hem", [
        (-0.170, 0.068, 1.192), (-0.090, 0.120, 1.188),
        (0.000, 0.142, 1.190), (0.090, 0.120, 1.195),
        (0.170, 0.068, 1.202),
    ], 0.006, 0.004, mats["accent"], up_hint=(0, 0, 1), ring=6,
        subsurf=1))
    for side, x in (("L", 1.0), ("R", -1.0)):
        made.append(tube_loft(f"z_armhole_trim.{side}", [
            (x * 0.150, 0.078, 1.397), (x * 0.182, 0.022, 1.425),
            (x * 0.190, -0.050, 1.392), (x * 0.165, -0.088, 1.340),
        ], [0.005, 0.006, 0.006, 0.003], [0.003, 0.004, 0.004, 0.002],
            mats["gear"], up_hint=(0, 0, 1), ring=6, subsurf=1))

    collar = shell_from_body(
        body, "z_mock_neck",
        lambda c: 1.425 < c.z < 1.505 and abs(c.x) < 0.088 and abs(c.y) < 0.075,
        0.008, 0.006, mats["suit"], boundary_smooth=2)
    made.append(collar)

    pants = shell_from_body(
        body, "z_loose_pants",
        lambda c: 0.185 < c.z < 1.055 and abs(c.x) < 0.245,
        0.012, 0.008, mats["pants"], boundary_smooth=3)
    for v in pants.data.vertices:
        if 0.24 < v.co.z < 0.94 and abs(v.co.x) > 0.025:
            center = math.copysign(0.092, v.co.x)
            fullness = 1.16 if v.co.z > 0.52 else 1.13
            v.co.x = center + (v.co.x - center) * fullness
            v.co.y *= 1.12
    pants.data.update()
    made.append(pants)

    # One compact thigh pocket keeps the tactical read without armor stacking.
    made.append(W.plate("z_cargo_pocket", (0.020, 0.078, 0.115),
                        (0.188, 0.000, 0.805), mats["gear"],
                        rot=(0, 0, -4), taper=(0.90, 0.88), bevel_w=0.004))
    made.append(W.plate("z_cargo_tab", (0.022, 0.050, 0.018),
                        (0.199, 0.025, 0.855), mats["warm"],
                        rot=(0, 0, -4), bevel_w=0.002))

    # Matte forearm wraps and short fingerless palm shells.
    wraps = shell_from_body(
        body, "z_forearm_wraps",
        lambda c: abs(c.x) > 0.220 and 0.850 < c.z < 1.165,
        0.009, 0.006, mats["gear"], boundary_smooth=2)
    made.append(wraps)
    palms = shell_from_body(
        body, "z_palm_wraps",
        lambda c: abs(c.x) > 0.325 and 0.755 < c.z < 0.915,
        0.008, 0.005, mats["gear"], boundary_smooth=2)
    made.append(palms)
    made.append(panel("z_bracer_glyph", [
        (0.351, 1.055), (0.365, 1.030), (0.354, 1.008),
        (0.370, 0.982), (0.350, 1.002), (0.360, 1.030),
    ], 0.028, mats["glow"], thick=0.002, bevel=0.001))

    # Low runner shoes follow the actual feet; a rounded midsole replaces the
    # flat slabs used by the discarded blockout.
    shoe_cuffs = shell_from_body(
        body, "z_shoe_cuffs",
        lambda c: 0.120 < c.z < 0.225 and abs(c.x) > 0.035,
        0.011, 0.007, mats["gear"], boundary_smooth=2)
    made.append(shoe_cuffs)
    for side, x in (("L", 0.110), ("R", -0.110)):
        # Closed rounded runner volume: a raised instep at the ankle, broad
        # midfoot and a tapered low nose. The donor feet are removed below.
        made.append(tube_loft(f"z_shoe_upper.{side}", [
            (x, -0.125, 0.070), (x, -0.065, 0.100),
            (x, 0.000, 0.075), (x, 0.070, 0.056),
            (x, 0.130, 0.041),
        ], [0.072, 0.085, 0.105, 0.105, 0.090],
            [0.055, 0.080, 0.060, 0.045, 0.030], mats["gear"],
            up_hint=(0, 0, 1), ring=8, subsurf=1))
        made.append(tube_loft(f"z_shoe_midsole.{side}", [
            (x, -0.125, 0.026), (x, -0.025, 0.024),
            (x, 0.065, 0.023), (x, 0.145, 0.026),
        ], [0.072, 0.095, 0.098, 0.070],
            [0.014, 0.016, 0.015, 0.010], mats["accent"],
            up_hint=(0, 0, 1), ring=8, subsurf=1))
        made.append(tube_loft(f"z_shoe_lace.{side}", [
            (x - 0.065, 0.010, 0.126), (x, 0.035, 0.133),
            (x + 0.065, 0.010, 0.126),
        ], [0.004, 0.006, 0.004], [0.003, 0.004, 0.003],
            mats["ivory"], up_hint=(0, 0, 1), ring=6, subsurf=1))

    # The new shoes are complete volumes, so the donor feet would only create
    # toe-shaped bumps through them. Remove the hidden lower-foot geometry;
    # the cut is safely concealed by the raised heel/instep sections.
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < 0.135],
                     context="VERTS")
    bm.to_mesh(body.data)
    bm.free()
    body.data.update()

    # Flat partial waist strap and two narrow cloth tails from the right hip.
    made.append(tube_loft("z_waist_strap", [
        (-0.165, 0.028, 1.032), (-0.115, 0.112, 1.038),
        (0.000, 0.145, 1.040), (0.115, 0.112, 1.035),
        (0.165, 0.028, 1.026),
    ], 0.010, 0.005, mats["gear"], up_hint=(0, 0, 1), ring=8, subsurf=1))
    made.append(W.plate("z_waist_clasp", (0.032, 0.014, 0.025),
                        (-0.118, 0.120, 1.037), mats["warm"],
                        rot=(0, 0, 12), bevel_w=0.003))
    made.append(tube_loft("z_streamer_ivory", [
        (-0.190, -0.030, 1.018), (-0.250, -0.100, 0.915),
        (-0.280, -0.155, 0.790), (-0.255, -0.175, 0.650),
    ], [0.026, 0.030, 0.022, 0.003], [0.004, 0.004, 0.003, 0.001],
        mats["ivory"], up_hint=(0, 1, 0), ring=8, subsurf=1))
    made.append(tube_loft("z_streamer_teal", [
        (-0.165, -0.035, 1.010), (-0.210, -0.110, 0.900),
        (-0.235, -0.165, 0.775), (-0.215, -0.185, 0.690),
    ], [0.020, 0.024, 0.017, 0.0025], [0.004, 0.004, 0.003, 0.001],
        mats["accent"], up_hint=(0, 1, 0), ring=8, subsurf=1))

    # Fresh hair: fitted cap, three broad swept clumps, high knot and a long
    # directional ponytail. The silhouette evokes speed without copying the
    # reference character's exact bun and bang arrangement.
    made.append(hair_cap(mats["hair"]))
    made.append(tube_loft("z_forelock_main", [
        (-0.060, 0.018, 1.710), (-0.030, 0.080, 1.700),
        (0.020, 0.112, 1.675), (0.078, 0.090, 1.630),
    ], [0.030, 0.032, 0.025, 0.003], [0.012, 0.012, 0.009, 0.002],
        mats["hair"], up_hint=(0, 1, 0), ring=8, subsurf=1))
    made.append(tube_loft("z_forelock_shadow", [
        (-0.025, 0.030, 1.728), (0.018, 0.088, 1.710),
        (0.070, 0.095, 1.670), (0.098, 0.064, 1.625),
    ], [0.024, 0.024, 0.017, 0.002], [0.010, 0.010, 0.007, 0.001],
        mats["hair_shadow"], up_hint=(0, 1, 0), ring=8, subsurf=1))
    made.append(tube_loft("z_forelock_short", [
        (-0.082, 0.030, 1.680), (-0.090, 0.070, 1.640),
        (-0.085, 0.064, 1.590),
    ], [0.017, 0.014, 0.002], [0.008, 0.006, 0.001],
        mats["hair"], up_hint=(0, 1, 0), ring=8, subsurf=1))
    made.append(ellipsoid("z_hair_knot", (0.025, -0.078, 1.726),
                          (0.060, 0.052, 0.055), mats["hair_shadow"],
                          segments=24, rings=14, rot=(8, 0, -12)))
    made.append(tube_loft("z_ponytail", [
        (0.028, -0.112, 1.720), (0.070, -0.175, 1.680),
        (0.105, -0.220, 1.585), (0.100, -0.225, 1.475),
        (0.070, -0.205, 1.385), (0.045, -0.175, 1.335),
    ], [0.050, 0.054, 0.046, 0.034, 0.018, 0.003],
        [0.034, 0.036, 0.030, 0.022, 0.012, 0.002],
        mats["hair"], up_hint=(0, 1, 0), ring=8, subsurf=1))
    made.append(tube_loft("z_ponytail_streak", [
        (0.055, -0.165, 1.690), (0.095, -0.220, 1.590),
        (0.090, -0.230, 1.485), (0.068, -0.205, 1.410),
    ], [0.010, 0.011, 0.007, 0.0015], [0.006, 0.006, 0.004, 0.001],
        mats["hair_shadow"], up_hint=(0, 1, 0), ring=6, subsurf=1))
    made.append(tube_loft("z_hair_tie", [
        (-0.010, -0.115, 1.730), (0.030, -0.132, 1.715),
        (0.070, -0.120, 1.700),
    ], 0.007, 0.005, mats["accent"], up_hint=(0, 0, 1), ring=8, subsurf=1))

    # Move every generated mesh into the required source collection.
    for o in made:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    return {"objects": [o.name for o in made],
            "source_tris": sum(sum(len(p.vertices) - 2 for p in o.data.polygons)
                               for o in made if o.type == "MESH")}


if __name__ == "__main__":
    print(build())
