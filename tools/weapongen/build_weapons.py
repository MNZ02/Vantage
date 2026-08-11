"""v3 weapons — high-detail procedural builds (rifle / pistol / sniper / knife).

Replaces the hand-authored v2 weapons in assets_v2.blend with fully
regenerable geometry. Same conventions as v2: meters, authored Blender Z-up
with the muzzle down +Y (exports to glTF -Z via export_yup), origin at the
grip anchor, overall footprints matched to the v2 bounding boxes so the
client's weapon anchor, held-weapon offsets and SMG rescale keep working.

Detail language: angular two-tone receivers, real rail slots, vented
handguards, fluted barrels + cut muzzle devices, grooved grips, ribbed
curved mags, skeleton stocks. Accent materials keep their v2 names
(v2_teal / v2_glow_teal) because the client retints by material name.

Live (MCP): import build_weapons; build_weapons.build_all()
Headless: blender --background --python tools/weapongen/build_weapons.py
"""
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/vantage")

PAL = {
    "gunmetal":  ("#3A414E", 0.80, 0.45),
    "dark":      ("#262B34", 0.55, 0.55),
    "polymer":   ("#20242C", 0.05, 0.80),
    "steel":     ("#9AA4B0", 0.95, 0.28),
    "rubber":    ("#15181D", 0.00, 0.95),
    "teal":      ("#2FB7A8", 0.25, 0.50),
    "glow_teal": ("#5FF2DE", 0.00, 0.35, "#33E0CC"),
    "blade":     ("#C9D4DE", 1.00, 0.18),
}
MAT_NAME = {"teal": "v2_teal", "glow_teal": "v2_glow_teal"}  # client IFF contract


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(key):
    name = MAT_NAME.get(key, f"v3_{key}")
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
            b.inputs["Emission Strength"].default_value = 3.0
    return m


# ------------------------------------------------------------------ helpers
def _link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def _activate(o):
    if bpy.context.mode != "OBJECT":
        try:
            bpy.ops.object.mode_set(mode="OBJECT")
        except RuntimeError:
            pass
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def _apply(o, mod):
    _activate(o)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def _smooth(o, deg=42):
    _activate(o)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(deg))
    except Exception:
        bpy.ops.object.shade_auto_smooth(angle=math.radians(deg))


def bevel(o, w=0.0018, segs=2, deg=40):
    md = o.modifiers.new("bv", "BEVEL")
    md.width = w
    md.segments = segs
    md.limit_method = "ANGLE"
    md.angle_limit = math.radians(deg)
    md.miter_outer = "MITER_ARC"
    _apply(o, md)
    return o


def plate(name, dims, loc, material, rot=None, bevel_w=0.0015, taper=None, shear_y=0.0):
    """Beveled cuboid. taper=(sx_top, sy_top) scales the +Z end; shear_y skews
    +Z end along Y (angled grips/stocks)."""
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    if taper or shear_y:
        tx, ty = taper or (1.0, 1.0)
        for v in o.data.vertices:
            if v.co.z > 0:
                v.co.x *= tx
                v.co.y *= ty
                v.co.y += shear_y
    if rot:
        o.rotation_euler = [math.radians(d) for d in rot]
        bpy.ops.object.transform_apply(rotation=True)
    o.location = loc
    o.data.materials.append(material)
    if bevel_w:
        bevel(o, bevel_w)
    _smooth(o)
    return o


def prism(name, profile_yz, width_x, material, bevel_w=0.002, at=(0, 0, 0)):
    """Side-profile polygon (list of (y, z), CCW seen from +X) extruded to a
    slab of width_x — the workhorse for receiver/stock silhouettes."""
    bm = bmesh.new()
    half = width_x / 2
    top = [bm.verts.new((half, y, z)) for y, z in profile_yz]
    f = bm.faces.new(top)
    f.normal_update()
    if f.normal.x < 0:
        bmesh.ops.reverse_faces(bm, faces=[f])
    r = bmesh.ops.extrude_face_region(bm, geom=[f])
    verts = [g for g in r["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, verts=verts, vec=(-width_x, 0, 0))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    _link(o)
    o.location = at
    me.materials.append(material)
    if bevel_w:
        bevel(o, bevel_w)
    _smooth(o)
    return o


def cyl(name, r, depth, loc, material, axis="Y", segs=24, r2=None, rot_extra=None, bevel_w=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=segs, radius1=r, radius2=r if r2 is None else r2,
                                    depth=depth) if r2 is not None else \
        bpy.ops.mesh.primitive_cylinder_add(vertices=segs, radius=r, depth=depth)
    o = bpy.context.object
    o.name = name
    rots = {"Y": (90, 0, 0), "X": (0, 90, 0), "Z": (0, 0, 0)}[axis]
    o.rotation_euler = [math.radians(d) for d in rots]
    bpy.ops.object.transform_apply(rotation=True)
    if rot_extra:
        o.rotation_euler = [math.radians(d) for d in rot_extra]
        bpy.ops.object.transform_apply(rotation=True)
    o.location = loc
    o.data.materials.append(material)
    if bevel_w:
        bevel(o, bevel_w, segs=1)
    _smooth(o, 30)
    return o


def loft(name, sections, material, ring=8, round_k=0.35, subsurf=1, cap=True):
    """Loft rounded-rect rings. sections: (center(3), half_w, half_d, tilt_deg)
    — tilt rotates the ring about X. Used for grips, cheek risers, mag bodies."""
    bm = bmesh.new()
    rings = []
    base = []
    n = max(ring, 8)
    for i in range(n):
        a = 2 * math.pi * i / n
        c, s = math.cos(a), math.sin(a)
        # squarish superellipse
        k = round_k
        x = math.copysign(abs(c) ** k, c)
        y = math.copysign(abs(s) ** k, s)
        base.append((x, y))
    for ctr, hw, hd, tilt in sections:
        R = Matrix.Rotation(math.radians(tilt), 4, "X")
        ring_v = []
        for x, y in base:
            p = R @ Vector((x * hw, y * hd, 0))
            ring_v.append(bm.verts.new(Vector(ctr) + p))
        rings.append(ring_v)
    for i in range(len(rings) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            bm.faces.new((rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]))
    if cap:
        bm.faces.new(reversed(rings[0]))
        bm.faces.new(rings[-1])
    bm.normal_update()
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    _link(o)
    me.materials.append(material)
    if subsurf:
        md = o.modifiers.new("ss", "SUBSURF")
        md.levels = subsurf
        _apply(o, md)
    # ring direction can wind inward depending on the sweep axis — fix
    _activate(o)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    _smooth(o, 46)
    return o


def cut(target, cutters):
    """Boolean-difference a list of cutter objects (joined first) out of target."""
    if not cutters:
        return target
    if len(cutters) > 1:
        _activate(cutters[0])
        for c in cutters[1:]:
            c.select_set(True)
        bpy.ops.object.join()
        cutter = bpy.context.object
    else:
        cutter = cutters[0]
    md = target.modifiers.new("cut", "BOOLEAN")
    md.operation = "DIFFERENCE"
    md.solver = "EXACT"
    md.object = cutter
    _apply(target, md)
    bpy.data.objects.remove(cutter, do_unlink=True)
    _smooth(target)
    return target


def rail(name, length, loc, material, slot_w=0.006, pitch=0.0155, width=0.021, base_h=0.008):
    """Picatinny-ish rail: base bar + chamfered slot cuts along Y."""
    o = plate(name, (width, length, base_h), loc, material, bevel_w=0.0012)
    cutters = []
    n = int(length / pitch) - 1
    y0 = loc[1] - (n - 1) * pitch / 2
    for i in range(n):
        bpy.ops.mesh.primitive_cube_add(size=1)
        c = bpy.context.object
        c.scale = (width + 0.004, slot_w, base_h * 0.55)
        bpy.ops.object.transform_apply(scale=True)
        # 45° chamfer on slot walls
        for v in c.data.vertices:
            if v.co.z < 0:
                v.co.y *= 1.9
        c.location = (loc[0], y0 + i * pitch, loc[2] + base_h * 0.30)
        cutters.append(c)
    cut(o, cutters)
    bevel(o, 0.0006, segs=1)
    return o


def screws(positions, material, r=0.0028, depth=0.003, axis="X"):
    out = []
    for i, p in enumerate(positions):
        out.append(cyl(f"screw{i}", r, depth, p, material, axis=axis, segs=6))
    return out


def finalize(objs, name, collection="v3_weapons"):
    coll = bpy.data.collections.get(collection)
    if not coll:
        coll = bpy.data.collections.new(collection)
        bpy.context.scene.collection.children.link(coll)
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    _activate(objs[0])
    for o in objs[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    for c in list(o.users_collection):
        c.objects.unlink(o)
    coll.objects.link(o)
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    return o, tris


def export(o, filename):
    out = REPO / "assets/models" / filename
    _activate(o)
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True)
    return {"glb": str(out), "kb": out.stat().st_size // 1024}


# ------------------------------------------------------------------ RIFLE
def build_rifle():
    A = []
    gm, dk, pol, st, rb, tl, gl = (mat("gunmetal"), mat("dark"), mat("polymer"),
                                   mat("steel"), mat("rubber"), mat("teal"), mat("glow_teal"))
    # ---- upper receiver: side profile, muzzle +Y, top rail plane z=.042
    A.append(prism("upper", [
        (-0.175, 0.006), (-0.175, 0.034), (-0.16, 0.042), (0.10, 0.042),
        (0.30, 0.038), (0.30, 0.006), (0.10, -0.004), (-0.10, -0.004),
    ], 0.036, gm))
    # ---- lower receiver + magwell (flared) + trigger area
    A.append(prism("lower", [
        (-0.185, 0.010), (-0.185, -0.030), (-0.145, -0.056), (-0.10, -0.060),
        (-0.075, -0.052), (0.015, -0.052), (0.065, -0.078), (0.10, -0.078),
        (0.115, -0.020), (0.115, 0.010),
    ], 0.034, dk))
    # ejection port (+X side): inset dark plate + steel bolt hint + deflector
    A.append(plate("port", (0.002, 0.085, 0.020), (0.0185, 0.06, 0.016), pol, bevel_w=0.0008))
    A.append(cyl("bolt", 0.0085, 0.08, (0.012, 0.06, 0.016), st, segs=16))
    A.append(plate("deflector", (0.006, 0.014, 0.020), (0.019, 0.012, 0.016),
                   gm, rot=(0, 0, 14)))
    # charging handle (-X side, back-top)
    A.append(plate("chandle_bar", (0.006, 0.05, 0.008), (-0.020, -0.135, 0.030), st))
    A.append(plate("chandle_knob", (0.020, 0.022, 0.013), (-0.033, -0.155, 0.030), pol,
                   bevel_w=0.0025))
    # selector levers + mag release + pins
    for sx in (0.019, -0.019):
        A.append(cyl("sel_pivot", 0.006, 0.004, (sx, -0.055, -0.006), st, axis="X", segs=12))
        A.append(plate("sel_lever", (0.004, 0.030, 0.007), (sx, -0.042, -0.004), pol,
                       rot=(0, 0, 0)))
    A.append(cyl("magrel", 0.007, 0.005, (0.019, 0.035, -0.012), pol, axis="X", segs=12))
    A.append(screws([(0.0185, -0.16, 0.012), (-0.0185, -0.16, 0.012),
                     (0.0185, 0.10, -0.030), (-0.0185, 0.10, -0.030)], st)[0])
    A += screws([(0.0185, -0.10, 0.030), (-0.0185, -0.10, 0.030)], st)
    # ---- top rail (receiver) + rear/front sights with glow dots
    A.append(rail("rail_top", 0.35, (0, 0.015, 0.047), gm))
    A.append(plate("rsight_base", (0.024, 0.022, 0.010), (0, -0.125, 0.056), dk))
    A.append(plate("rsight_ring", (0.020, 0.008, 0.018), (0, -0.125, 0.0655), dk, bevel_w=0.002))
    A.append(cyl("rsight_ap", 0.0055, 0.010, (0, -0.125, 0.068), pol, segs=16))
    A.append(plate("fsight_post", (0.007, 0.012, 0.046), (0, 0.51, 0.043), dk, taper=(0.55, 0.75)))
    A.append(plate("fsight_dot", (0.004, 0.004, 0.005), (0, 0.51, 0.0685), gl, bevel_w=0.0008))
    A.append(plate("rsight_dot", (0.010, 0.003, 0.0035), (0, -0.1285, 0.059), gl, bevel_w=0.0006))
    # ---- handguard: octagonal, vented, teal facet inserts, top rail continues
    hg = cyl("handguard", 0.030, 0.30, (0, 0.315, 0.010), pol, segs=8, rot_extra=(0, 22.5, 0))
    hg.scale = (1.0, 1.0, 0.92)
    bpy.ops.object.transform_apply(scale=True)
    vents = []
    for side in (1, -1):
        for i in range(5):
            bpy.ops.mesh.primitive_cube_add(size=1)
            c = bpy.context.object
            c.scale = (0.02, 0.032, 0.011)
            bpy.ops.object.transform_apply(scale=True)
            c.location = (side * 0.026, 0.21 + i * 0.052, 0.010)
            c.rotation_euler = (0, math.radians(side * 30), 0)
            vents.append(c)
        for i in range(4):
            bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.006, depth=0.02)
            c = bpy.context.object
            c.rotation_euler = (0, math.radians(90), 0)
            c.location = (side * 0.024, 0.235 + i * 0.052, -0.014)
            vents.append(c)
    cut(hg, vents)
    bevel(hg, 0.0008, segs=1)
    A.append(hg)
    A.append(rail("rail_hg", 0.26, (0, 0.33, 0.0455), gm))
    for side in (1, -1):
        A.append(plate("hg_inlay", (0.0025, 0.20, 0.009),
                       (side * 0.0295, 0.30, 0.032), tl, rot=(0, side * -22, 0), bevel_w=0.0008))
    # ---- barrel: fluted steel + gas block + muzzle brake with port cuts
    br = cyl("barrel", 0.0105, 0.22, (0, 0.545, 0.010), st, segs=20)
    flutes = []
    for i in range(6):
        a = math.radians(i * 60)
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.0032, depth=0.16)
        c = bpy.context.object
        c.rotation_euler = (math.radians(90), 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        c.location = (math.cos(a) * 0.0105, 0.52, 0.010 + math.sin(a) * 0.0105)
        flutes.append(c)
    cut(br, flutes)
    A.append(br)
    A.append(cyl("gasblock", 0.014, 0.024, (0, 0.50, 0.010), dk, segs=12, bevel_w=0.001))
    mb = cyl("brake", 0.0165, 0.075, (0, 0.625, 0.010), gm, segs=16)
    ports = []
    for side in (1, -1):
        for i in range(3):
            bpy.ops.mesh.primitive_cube_add(size=1)
            c = bpy.context.object
            c.scale = (0.04, 0.012, 0.018)
            bpy.ops.object.transform_apply(scale=True)
            c.location = (side * 0.014, 0.607 + i * 0.021, 0.016)
            c.rotation_euler = (0, 0, math.radians(side * -8))
            ports.append(c)
    cut(mb, ports)
    bevel(mb, 0.0008, segs=1)
    A.append(mb)
    A.append(cyl("crown", 0.009, 0.006, (0, 0.664, 0.010), pol, segs=16))
    # ---- grip: lofted, finger grooves, raked back, teal base cap
    grip_secs = []
    g0 = Vector((0, -0.095, -0.050))
    axis = Vector((0, -0.34, -1.0)).normalized()  # raked toward the stock
    rake = math.degrees(math.atan2(-axis.y, -axis.z))
    prof = [(0.0, 0.019, 0.027), (0.016, 0.0185, 0.028), (0.040, 0.0160, 0.0250),
            (0.062, 0.0150, 0.0235), (0.086, 0.0160, 0.0245), (0.108, 0.0180, 0.026),
            (0.120, 0.0190, 0.0275), (0.128, 0.0195, 0.028)]
    groove = {2: 0.0030, 3: 0.0042, 4: 0.0030}
    for i, (t, hw, hd) in enumerate(prof):
        c = g0 + axis * t
        g = groove.get(i, 0.0)
        grip_secs.append(((c.x, c.y + g, c.z), hw, hd - g * 0.5, rake))
    A.append(loft("grip", grip_secs, pol, ring=10, subsurf=1))
    gcap = g0 + axis * 0.129
    A.append(plate("grip_cap", (0.0165, 0.0245, 0.008), (gcap.x, gcap.y, gcap.z), tl,
                   rot=(rake, 0, 0), bevel_w=0.0015))
    # receiver side interest: inset panel line + dust plate
    for side in (1, -1):
        A.append(plate("side_panel", (0.0018, 0.11, 0.014), (side * 0.0175, -0.03, 0.016),
                       pol, bevel_w=0.0006))
    A.append(plate("dust_plate", (0.0018, 0.05, 0.016), (-0.0178, 0.045, -0.020), gm,
                   rot=(0, 0, -6), bevel_w=0.0006))
    # ---- trigger + guard
    A.append(plate("trigger", (0.006, 0.007, 0.026), (0, -0.028, -0.036), st,
                   rot=(12, 0, 0), taper=(0.8, 0.7)))
    tg = cyl("tguard", 0.030, 0.006, (0, -0.020, -0.052), dk, axis="X", segs=18)
    tg.scale = (1, 1.35, 1)
    bpy.ops.object.transform_apply(scale=True)
    inner = cyl("tg_in", 0.024, 0.02, (0, -0.020, -0.052), dk, axis="X", segs=18)
    inner.scale = (1, 1.35, 1)
    bpy.ops.object.transform_apply(scale=True)
    cut(tg, [inner])
    # keep only lower half of the guard ring
    half = plate("tg_half", (0.05, 0.12, 0.06), (0, -0.020, -0.022), dk, bevel_w=0)
    cut(tg, [half])
    A.append(tg)
    # ---- magazine: curved loft (sweeping down-forward) + rib bands + teal base
    mag_secs = []
    m0 = Vector((0, 0.080, -0.080))
    ang0, arc, L, nseg = math.radians(6), math.radians(40), 0.165, 7
    p = m0.copy()
    d = Vector((0, math.sin(ang0), -math.cos(ang0)))  # down, slightly forward
    for i in range(nseg + 1):
        tilt = math.degrees(math.atan2(d.y, -d.z))
        mag_secs.append(((p.x, p.y, p.z), 0.0160, 0.0230, tilt))
        d = (Matrix.Rotation(-arc / nseg, 4, "X") @ d).normalized()  # curve forward
        p += d * (L / nseg)
    mag = loft("mag", mag_secs, dk, ring=10, round_k=0.45, subsurf=1)
    A.append(mag)
    for i in range(1, nseg, 2):
        c, hw, hd, tilt = mag_secs[i]
        A.append(plate(f"mag_rib{i}", (hw * 2 + 0.0025, 0.009, hd * 2 + 0.0025),
                       c, gm, rot=(tilt, 0, 0), bevel_w=0.0010))
    bp, hw, hd, tilt = mag_secs[-1]
    A.append(plate("mag_base", (hw * 2 + 0.006, hd * 2 + 0.008, 0.012),
                   (bp[0], bp[1], bp[2]), tl, rot=(tilt, 0, 0), bevel_w=0.002))
    # ---- stock: skeleton profile + cheek riser + rubber buttpad + teal insert
    stock = prism("stock", [
        (-0.185, 0.030), (-0.36, 0.024), (-0.375, 0.014), (-0.375, -0.070),
        (-0.355, -0.078), (-0.335, -0.020), (-0.20, -0.008), (-0.185, -0.008),
    ], 0.030, pol)
    hole = cyl("s_hole", 0.021, 0.05, (0, -0.305, -0.028), pol, axis="X", segs=16)
    hole.scale = (1, 1.7, 1)
    bpy.ops.object.transform_apply(scale=True)
    hole.rotation_euler = (math.radians(-12), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    cut(stock, [hole])
    A.append(stock)
    A.append(loft("cheek", [((0, -0.30, 0.024), 0.014, 0.007, 0),
                            ((0, -0.26, 0.028), 0.016, 0.010, 0),
                            ((0, -0.215, 0.026), 0.015, 0.008, 0)], pol, subsurf=1))
    A.append(plate("buttpad", (0.017, 0.010, 0.092), (0, -0.381, -0.026), rb,
                   rot=(4, 0, 0), bevel_w=0.002))
    for i in range(3):
        A.append(plate(f"bp_rib{i}", (0.018, 0.003, 0.010),
                       (0, -0.3835, -0.052 + i * 0.026), rb, rot=(4, 0, 0), bevel_w=0.0006))
    A.append(plate("stock_inlay", (0.0025, 0.10, 0.014), (0.0155, -0.27, 0.010), tl,
                   rot=(0, 0, 0), bevel_w=0.0008))
    A.append(plate("stock_inlay2", (0.0025, 0.10, 0.014), (-0.0155, -0.27, 0.010), tl,
                   bevel_w=0.0008))
    # QD sockets
    for side in (1, -1):
        A.append(cyl("qd", 0.006, 0.003, (side * 0.0158, -0.20, -0.002), st, axis="X", segs=14))
        A.append(cyl("qd2", 0.006, 0.003, (side * 0.024, 0.185, 0.010), st, axis="X", segs=14))
    # receiver teal accent line
    A.append(plate("rcv_inlay", (0.0025, 0.16, 0.006), (0.0185, -0.02, 0.036), tl, bevel_w=0.0006))
    A.append(plate("rcv_inlay_l", (0.0025, 0.16, 0.006), (-0.0185, -0.02, 0.036), tl, bevel_w=0.0006))
    # brand chevrons on magwell
    for side in (1, -1):
        A.append(plate("chevron", (0.0022, 0.024, 0.007), (side * 0.018, 0.075, -0.045), tl,
                       rot=(0, 0, side * 28), bevel_w=0.0006))
    flat = [x for it in A for x in (it if isinstance(it, list) else [it])]
    return finalize(flat, "weapon_rifle_v3")


# ------------------------------------------------------------------ PISTOL
def build_pistol():
    A = []
    gm, dk, pol, st, tl, gl = (mat("gunmetal"), mat("dark"), mat("polymer"),
                               mat("steel"), mat("teal"), mat("glow_teal"))
    # ---- slide with serrations + port
    slide = prism("slide", [
        (-0.088, 0.004), (-0.088, 0.027), (0.098, 0.027), (0.112, 0.020),
        (0.112, 0.010), (0.098, 0.004),
    ], 0.028, gm)
    serr = []
    for i in range(6):
        bpy.ops.mesh.primitive_cube_add(size=1)
        c = bpy.context.object
        c.scale = (0.034, 0.0035, 0.020)
        bpy.ops.object.transform_apply(scale=True)
        c.location = (0, -0.075 + i * 0.0085, 0.024)
        c.rotation_euler = (0, 0, math.radians(14))
        serr.append(c)
    for i in range(4):
        bpy.ops.mesh.primitive_cube_add(size=1)
        c = bpy.context.object
        c.scale = (0.034, 0.0035, 0.016)
        bpy.ops.object.transform_apply(scale=True)
        c.location = (0, 0.070 + i * 0.0085, 0.026)
        c.rotation_euler = (0, 0, math.radians(14))
        serr.append(c)
    bpy.ops.mesh.primitive_cube_add(size=1)
    port = bpy.context.object
    port.scale = (0.012, 0.035, 0.012)
    bpy.ops.object.transform_apply(scale=True)
    port.location = (0.012, 0.052, 0.024)
    serr.append(port)
    cut(slide, serr)
    bevel(slide, 0.0008, segs=1)
    A.append(slide)
    A.append(cyl("barrel_in", 0.0075, 0.036, (0, 0.055, 0.0155), st, segs=16))
    A.append(plate("slide_plate", (0.0285, 0.0035, 0.022), (0, -0.0875, 0.0155), tl,
                   bevel_w=0.0008))
    # sights
    A.append(plate("rsight", (0.022, 0.007, 0.0075), (0, -0.082, 0.0305), dk, bevel_w=0.001))
    for sx in (0.006, -0.006):
        A.append(plate("rdot", (0.0028, 0.0028, 0.0028), (sx, -0.0855, 0.0315), gl, bevel_w=0))
    A.append(plate("fsight", (0.006, 0.007, 0.007), (0, 0.098, 0.0305), dk, taper=(0.7, 0.9)))
    A.append(plate("fdot", (0.0032, 0.0032, 0.0032), (0, 0.098, 0.0325), gl, bevel_w=0))
    # ---- muzzle: threaded stub
    A.append(cyl("thread", 0.0085, 0.016, (0, 0.118, 0.0155), st, segs=16))
    for i in range(3):
        A.append(cyl(f"thr{i}", 0.0089, 0.0022, (0, 0.113 + i * 0.0045, 0.0155), dk, segs=16))
    # ---- frame + trigger guard + grip
    A.append(prism("frame", [
        (-0.075, -0.020), (-0.075, 0.006), (0.095, 0.006), (0.095, -0.012),
        (0.055, -0.020), (0.030, -0.020),
    ], 0.026, pol))
    A.append(plate("rail_p", (0.022, 0.045, 0.006), (0, 0.062, -0.017), pol, bevel_w=0.001))
    tg = cyl("tguard_p", 0.024, 0.005, (0, 0.004, -0.026), pol, axis="X", segs=18)
    tg.scale = (1, 1.3, 1)
    bpy.ops.object.transform_apply(scale=True)
    inner = cyl("tg_in_p", 0.019, 0.02, (0, 0.004, -0.026), pol, axis="X", segs=18)
    inner.scale = (1, 1.32, 1)
    bpy.ops.object.transform_apply(scale=True)
    cut(tg, [inner])
    half = plate("tg_half_p", (0.05, 0.10, 0.05), (0, 0.004, 0.006), pol, bevel_w=0)
    cut(tg, [half])
    A.append(tg)
    A.append(plate("trigger_p", (0.005, 0.006, 0.022), (0, 0.010, -0.028), st, rot=(10, 0, 0),
                   taper=(0.8, 0.7)))
    # grip: raked loft (embedded into the frame) + beavertail + panels + teal base
    g0 = Vector((0, -0.048, -0.008))
    axis = Vector((0, -0.42, -1.0)).normalized()
    rake = math.degrees(math.atan2(-axis.y, -axis.z))
    prof = [(0.0, 0.0140, 0.024), (0.018, 0.0138, 0.0245), (0.045, 0.0128, 0.0225),
            (0.072, 0.0132, 0.023), (0.092, 0.0142, 0.0250), (0.104, 0.0146, 0.0255)]
    A.append(loft("grip_p", [(tuple(g0 + axis * t), hw, hd, rake) for t, hw, hd in prof],
                  pol, ring=10, subsurf=1))
    A.append(plate("beavertail", (0.026, 0.034, 0.014), (0, -0.066, -0.014), pol,
                   rot=(rake, 0, 0), bevel_w=0.002))
    for side in (1, -1):
        c = g0 + axis * 0.050
        A.append(plate("gpanel", (0.0014, 0.014, 0.026), (side * 0.0130, c.y, c.z), dk,
                       rot=(rake, 0, 0), bevel_w=0.0006))
    gc = g0 + axis * 0.104
    A.append(plate("mag_base_p", (0.016, 0.026, 0.009), (gc.x, gc.y, gc.z), tl,
                   rot=(rake, 0, 0), bevel_w=0.0018))
    # controls
    A.append(plate("slide_stop", (0.0035, 0.024, 0.005), (-0.0145, -0.032, 0.002), dk,
                   bevel_w=0.0008))
    A.append(cyl("takedown", 0.004, 0.004, (-0.0145, 0.012, -0.004), st, axis="X", segs=10))
    A.append(cyl("magrel_p", 0.005, 0.004, (-0.0145, -0.038, -0.016), dk, axis="X", segs=10))
    A.append(plate("chevron_p", (0.0018, 0.014, 0.005), (0.0142, 0.03, -0.006), tl,
                   rot=(0, 0, 28), bevel_w=0.0005))
    flat = [x for it in A for x in (it if isinstance(it, list) else [it])]
    return finalize(flat, "weapon_pistol_v3")


# ------------------------------------------------------------------ SNIPER
def build_sniper():
    A = []
    gm, dk, pol, st, rb, tl, gl = (mat("gunmetal"), mat("dark"), mat("polymer"),
                                   mat("steel"), mat("rubber"), mat("teal"), mat("glow_teal"))
    # ---- chassis: receiver + forend + buttstock silhouette
    A.append(prism("recv_s", [
        (-0.15, -0.045), (-0.15, 0.030), (0.30, 0.030), (0.34, 0.018),
        (0.34, -0.030), (0.10, -0.045),
    ], 0.042, gm))
    # forend with vents
    fe = prism("forend", [(0.30, -0.036), (0.30, 0.022), (0.56, 0.016), (0.56, -0.020)],
               0.038, pol)
    vents = []
    for side in (1, -1):
        for i in range(4):
            bpy.ops.mesh.primitive_cube_add(size=1)
            c = bpy.context.object
            c.scale = (0.03, 0.030, 0.009)
            bpy.ops.object.transform_apply(scale=True)
            c.location = (side * 0.019, 0.345 + i * 0.052, -0.004)
            vents.append(c)
    cut(fe, vents)
    bevel(fe, 0.0008, segs=1)
    A.append(fe)
    # buttstock: skeleton + spacers + hook + pads
    A.append(prism("butt", [
        (-0.15, 0.030), (-0.44, 0.026), (-0.455, 0.012), (-0.455, -0.095),
        (-0.43, -0.105), (-0.40, -0.050), (-0.22, -0.052), (-0.15, -0.045),
    ], 0.034, pol))
    hole = cyl("b_hole", 0.026, 0.05, (0, -0.36, -0.030), pol, axis="X", segs=16)
    hole.scale = (1, 1.9, 1)
    bpy.ops.object.transform_apply(scale=True)
    hole.rotation_euler = (math.radians(-8), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    cut(A[-1], [hole])
    A.append(loft("cheek_s", [((0, -0.31, 0.030), 0.015, 0.008, 0),
                              ((0, -0.26, 0.036), 0.017, 0.011, 0),
                              ((0, -0.21, 0.032), 0.016, 0.009, 0)], rb, subsurf=1))
    A.append(plate("buttpad_s", (0.019, 0.012, 0.11), (0, -0.462, -0.040), rb, rot=(3, 0, 0),
                   bevel_w=0.002))
    for i in range(2):
        A.append(plate(f"spacer{i}", (0.018, 0.006, 0.10), (0, -0.447 + i * 0.009, -0.040),
                       tl if i == 0 else pol, rot=(3, 0, 0), bevel_w=0.0008))
    A.append(plate("monopod", (0.012, 0.010, 0.045), (0, -0.415, -0.115), gm, taper=(0.7, 0.8)))
    # ---- barrel: heavy, fluted + big brake
    br = cyl("barrel_s", 0.014, 0.42, (0, 0.72, 0.006), st, segs=20)
    flutes = []
    for i in range(8):
        a = math.radians(i * 45)
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.0038, depth=0.34)
        c = bpy.context.object
        c.rotation_euler = (math.radians(90), 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        c.location = (math.cos(a) * 0.014, 0.70, 0.006 + math.sin(a) * 0.014)
        flutes.append(c)
    cut(br, flutes)
    A.append(br)
    mb = cyl("brake_s", 0.023, 0.10, (0, 0.90, 0.006), gm, segs=16)
    ports = []
    for side in (1, -1):
        for i in range(3):
            bpy.ops.mesh.primitive_cube_add(size=1)
            c = bpy.context.object
            c.scale = (0.05, 0.016, 0.026)
            bpy.ops.object.transform_apply(scale=True)
            c.location = (side * 0.02, 0.874 + i * 0.028, 0.010)
            c.rotation_euler = (0, 0, math.radians(side * -10))
            ports.append(c)
    cut(mb, ports)
    bevel(mb, 0.0008, segs=1)
    A.append(mb)
    A.append(cyl("crown_s", 0.011, 0.008, (0, 0.951, 0.006), pol, segs=16))
    # ---- bolt (+X side) + handle
    A.append(cyl("boltbody", 0.011, 0.12, (0.014, -0.02, 0.022), st, segs=16))
    A.append(cyl("boltarm", 0.005, 0.042, (0.032, -0.050, 0.012), st, axis="X", segs=10,
                 rot_extra=(0, 0, -38)))
    A.append(cyl("boltknob", 0.010, 0.016, (0.047, -0.062, 0.000), pol, axis="X", segs=12,
                 bevel_w=0.002))
    # ---- rail + scope
    A.append(rail("rail_s", 0.22, (0, 0.08, 0.041), gm))
    for ry in (-0.03, 0.10):
        A.append(cyl(f"ring{ry}", 0.021, 0.014, (0, ry, 0.075), dk, segs=18))
        A.append(plate(f"ringbase{ry}", (0.020, 0.022, 0.018), (0, ry, 0.052), dk,
                       bevel_w=0.0012))
    A.append(cyl("scope_tube", 0.0165, 0.24, (0, 0.02, 0.075), gm, segs=20))
    A.append(cyl("scope_obj", 0.026, 0.075, (0, 0.16, 0.075), gm, segs=20, r2=0.029))
    A.append(cyl("scope_lens", 0.024, 0.004, (0, 0.199, 0.075), gl, segs=20))
    A.append(cyl("scope_ocu", 0.021, 0.055, (0, -0.115, 0.075), gm, segs=20, r2=0.019))
    A.append(cyl("scope_eye", 0.017, 0.003, (0, -0.1435, 0.075), pol, segs=20))
    A.append(cyl("turret_top", 0.010, 0.016, (0, 0.045, 0.100), dk, axis="Z", segs=12,
                 bevel_w=0.001))
    A.append(cyl("turret_side", 0.010, 0.016, (-0.028, 0.045, 0.075), dk, axis="X", segs=12,
                 bevel_w=0.001))
    A.append(cyl("magring", 0.019, 0.012, (0, -0.085, 0.075), tl, segs=20))
    # ---- box mag + trigger + guard + grip
    A.append(plate("mag_s", (0.034, 0.054, 0.064), (0, 0.043, -0.072), dk, rot=(-4, 0, 0),
                   taper=(0.94, 0.88), bevel_w=0.002))
    A.append(plate("mag_rib_s", (0.036, 0.008, 0.05), (0, 0.043, -0.070), gm, rot=(-4, 0, 0),
                   bevel_w=0.001))
    A.append(plate("mag_base_s", (0.037, 0.058, 0.010), (0, 0.046, -0.106), tl, rot=(-4, 0, 0),
                   bevel_w=0.002))
    tg = cyl("tguard_s", 0.028, 0.006, (0, -0.045, -0.052), dk, axis="X", segs=18)
    tg.scale = (1, 1.35, 1)
    bpy.ops.object.transform_apply(scale=True)
    inner = cyl("tg_in_s", 0.0225, 0.02, (0, -0.045, -0.052), dk, axis="X", segs=18)
    inner.scale = (1, 1.35, 1)
    bpy.ops.object.transform_apply(scale=True)
    cut(tg, [inner])
    half = plate("tg_half_s", (0.05, 0.12, 0.06), (0, -0.045, -0.022), dk, bevel_w=0)
    cut(tg, [half])
    A.append(tg)
    A.append(plate("trigger_s", (0.006, 0.007, 0.024), (0, -0.052, -0.036), st, rot=(12, 0, 0),
                   taper=(0.8, 0.7)))
    g0 = Vector((0, -0.115, -0.052))
    gaxis = Vector((0, -0.38, -1.0)).normalized()
    rake = math.degrees(math.atan2(-gaxis.y, -gaxis.z))
    prof = [(0.0, 0.019, 0.028), (0.02, 0.0185, 0.029), (0.045, 0.0165, 0.026),
            (0.07, 0.016, 0.025), (0.095, 0.017, 0.026), (0.115, 0.019, 0.028)]
    A.append(loft("grip_s", [(tuple(g0 + gaxis * t), hw, hd, rake) for t, hw, hd in prof],
                  pol, ring=10, subsurf=1))
    gc = g0 + gaxis * 0.118
    A.append(plate("grip_cap_s", (0.017, 0.025, 0.007), tuple(gc), tl, rot=(rake, 0, 0),
                   bevel_w=0.0015))
    # ---- folded bipod under forend
    for side in (1, -1):
        A.append(plate("bipod_mnt", (0.024, 0.030, 0.010), (0, 0.50, -0.026), gm, bevel_w=0.001))
        A.append(cyl(f"bipod{side}", 0.0045, 0.16, (side * 0.014, 0.425, -0.030), st,
                     segs=10, rot_extra=(2, 0, side * 4)))
        A.append(cyl(f"bipodfoot{side}", 0.006, 0.012, (side * 0.0195, 0.345, -0.0315), rb,
                     segs=10))
    # teal chassis inlays
    for side in (1, -1):
        A.append(plate("s_inlay", (0.0025, 0.16, 0.010), (side * 0.0215, 0.12, 0.012), tl,
                       bevel_w=0.0008))
    flat = [x for it in A for x in (it if isinstance(it, list) else [it])]
    return finalize(flat, "weapon_sniper_v3")


# ------------------------------------------------------------------ KNIFE
def build_knife():
    A = []
    dk, pol, st, rb, tl, gl, bl = (mat("dark"), mat("polymer"), mat("steel"),
                                   mat("rubber"), mat("teal"), mat("glow_teal"), mat("blade"))
    # ---- tanto blade: profile prism, angular tip, emissive edge strip
    A.append(prism("blade", [
        (0.005, 0.000), (0.150, 0.000), (0.192, 0.022), (0.150, 0.030),
        (0.005, 0.030),
    ], 0.0045, bl))
    # spine chamfer (dark) + fuller groove
    A.append(plate("fuller", (0.0052, 0.11, 0.0045), (0, 0.075, 0.0235), dk, bevel_w=0.0006))
    # edge: thin bright strip + glow line along the cutting edge
    A.append(prism("edge", [(0.006, -0.0005), (0.148, -0.0005), (0.188, 0.0205),
                            (0.148, 0.0045), (0.006, 0.0045)], 0.0028, st, bevel_w=0.0005))
    A.append(prism("edge_glow", [(0.008, -0.0012), (0.147, -0.0012), (0.185, 0.0198),
                                 (0.147, 0.0012), (0.008, 0.0012)], 0.0016, gl, bevel_w=0))
    # ---- guard
    A.append(plate("guard", (0.012, 0.008, 0.052), (0, 0.002, 0.013), dk, bevel_w=0.0015))
    # ---- handle: loft + cord wrap (crossing diagonals) + teal wrap line
    g0 = Vector((0, -0.006, 0.013))
    haxis = Vector((0, -1.0, -0.10)).normalized()
    rake = math.degrees(math.atan2(-haxis.y, -haxis.z)) - 90
    prof = [(0.0, 0.0085, 0.014), (0.02, 0.0105, 0.017), (0.06, 0.0115, 0.018),
            (0.10, 0.0105, 0.0165), (0.125, 0.009, 0.0145)]
    A.append(loft("handle", [(tuple(g0 + haxis * t), hw, hd, 90 + rake) for t, hw, hd in prof],
                  pol, ring=10, subsurf=1))
    def wrap_ring(i, t, tilt, material):
        c = g0 + haxis * t
        bpy.ops.mesh.primitive_torus_add(major_radius=0.0128, minor_radius=0.0028,
                                         major_segments=14, minor_segments=6,
                                         location=tuple(c))
        w = bpy.context.object
        w.name = f"wrap{i}"
        w.rotation_euler = Euler((math.radians(90 + rake + tilt), 0, 0), "XYZ")
        w.scale = (0.92, 1.0, 1.35)
        bpy.ops.object.transform_apply(rotation=True, scale=True)
        w.data.materials.append(material)
        bpy.ops.object.shade_smooth()
        return w
    for i in range(5):
        t = 0.022 + i * 0.021
        A.append(wrap_ring(i * 2, t, 14, dk))
        A.append(wrap_ring(i * 2 + 1, t + 0.0105, -14, dk))
    A.append(wrap_ring(99, 0.064, 14, tl))
    # ---- pommel + lanyard ring
    pc = g0 + haxis * 0.135
    A.append(plate("pommel", (0.017, 0.016, 0.026), tuple(pc), dk, rot=(90 + rake, 0, 0),
                   bevel_w=0.0025))
    bpy.ops.mesh.primitive_torus_add(major_radius=0.008, minor_radius=0.0018,
                                     major_segments=16, minor_segments=6,
                                     location=tuple(pc + haxis * 0.012))
    ring_o = bpy.context.object
    ring_o.name = "lanyard"
    ring_o.rotation_euler = (0, math.radians(90), 0)
    ring_o.data.materials.append(st)
    bpy.ops.object.shade_smooth()
    A.append(ring_o)
    flat = [x for it in A for x in (it if isinstance(it, list) else [it])]
    return finalize(flat, "weapon_knife_v3")


# ------------------------------------------------------------------ studio render
def render_weapon(obj_name, out_name, views=None):
    import importlib
    import harness
    importlib.reload(harness)
    harness._ensure_studio()
    cam = harness._camera()
    o = bpy.data.objects[obj_name]
    lo, hi = harness._bounds([o])
    ctr = (lo + hi) / 2
    rad = max((hi - lo).length / 2, 0.1)
    out = harness.PREVIEWS / out_name
    out.mkdir(parents=True, exist_ok=True)
    state = harness._solo([o])
    scn = bpy.context.scene
    scn.render.resolution_x, scn.render.resolution_y = 1280, 800
    views = views or [("left", 270, 8, 0.50, None, 1.0), ("right", 90, 8, 0.50, None, 1.0),
                      ("tq_front", 320, 18, 0.50, None, 1.0),
                      ("grip_detail", 250, 10, 0.40, (0, -0.10, -0.06), 0.30),
                      ("muzzle_detail", 300, 12, 0.40, (0, 0.50, 0.01), 0.30)]
    paths = []
    for name, az, el, fov, focus, rscale in views:
        c_use = Vector(focus) if focus else ctr
        r_use = rad * rscale
        cam.data.angle = fov
        dist = r_use / math.tan(fov / 2) * 1.12
        a, e = math.radians(az), math.radians(el)
        cam.location = c_use + Vector((math.sin(a) * math.cos(e),
                                       -math.cos(a) * math.cos(e),
                                       math.sin(e))) * dist
        cam.rotation_euler = (c_use - cam.location).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = str(out / f"{name}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scn.render.filepath)
    harness._restore(state)
    return paths


BUILDERS = {"rifle": build_rifle, "pistol": build_pistol,
            "sniper": build_sniper, "knife": build_knife}


def build_all(export_glb=False):
    out = {}
    for key, fn in BUILDERS.items():
        o, tris = fn()
        out[key] = {"tris": tris}
        if export_glb:
            out[key].update(export(o, f"weapon_{key}.glb"))
    return out


if __name__ == "__main__":
    print(build_all())
