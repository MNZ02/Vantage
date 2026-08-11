"""Build an agent from the CC0 stylized base body + spec-driven gear shells.

v6: Zephyr dispatches to build_zephyr_scratch.py, a clean-slate realistic
human wind-runner build. RECRUIT remains on the proven normalized stylized
base, UV-island face labeling and garment-shell machinery below. The legacy
v5 addon code stays readable for older saved sessions but is not production.

Headless: blender --background --python tools/agentgen/build_agent.py -- --agent zephyr
Live: import and call build(agent_key) — the MCP session does this.
"""
import math
import sys
from collections import defaultdict
from pathlib import Path

import bpy
import bmesh
from mathutils import Vector

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone/tools/agentgen")
for p in (str(TOOLS), str(TOOLS.parent / "weapongen")):
    if p not in sys.path:
        sys.path.insert(0, p)
from specs import AGENTS  # noqa: E402
import build_weapons as W  # noqa: E402  (plate/cyl/loft helpers + _smooth)

VENDOR_BLEND = TOOLS.parents[1] / "assets/blender/vendor/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend"
BASE_OBJ = "GEO-body_female_stylized"


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(agent, key, spec, mat_names=None):
    name = (mat_names or {}).get(key, f"ag_{agent}_{key}")
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
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


def _body_master():
    """Append the pristine base body ONCE per session (re-appending the same
    library object aliases stale data — see _hand_master in build_viewmodel)."""
    m = bpy.data.objects.get("agentbody_master")
    if m and len(m.data.vertices) > 1000:
        return m
    for o in list(bpy.data.objects):
        if o.name == "agentbody_master" or o.name.startswith(BASE_OBJ):
            bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    with bpy.data.libraries.load(str(VENDOR_BLEND)) as (df, dt):
        dt.objects = [BASE_OBJ]
    o = bpy.data.objects[BASE_OBJ]
    o.name = "agentbody_master"
    if o.name not in bpy.context.scene.collection.objects:
        try:
            bpy.context.scene.collection.objects.link(o)
        except RuntimeError:
            pass
    W._activate(o)
    for md in list(o.modifiers):
        bpy.ops.object.modifier_remove(modifier=md.name)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.hide_render = True
    o.hide_viewport = True
    return o


def normalize_base(height, head_scale, curl=True, flatten_face=True,
                   flatten_chest=True):
    master = _body_master()
    o = master.copy()
    o.data = master.data.copy()
    o.name = BASE_OBJ  # keep the well-known name for the build collection
    o.hide_render = False
    o.hide_viewport = False
    bpy.context.scene.collection.objects.link(o)
    W._activate(o)
    me = o.data
    xs = [v.co.x for v in me.vertices]
    ys = [v.co.y for v in me.vertices]
    zs = [v.co.z for v in me.vertices]
    cx = (min(xs) + max(xs)) / 2
    cy = (min(ys) + max(ys)) / 2
    z0 = min(zs)
    s = height / (max(zs) - z0)
    for v in me.vertices:
        v.co.x = (v.co.x - cx) * s
        v.co.y = (v.co.y - cy) * s
        v.co.z = (v.co.z - z0) * s
    # face +Y: bundle bodies face -Y; flip
    for v in me.vertices:
        v.co.x, v.co.y = -v.co.x, -v.co.y
    if flatten_chest:
        # Recruit's armor vest needs a flatter base silhouette. Zephyr keeps
        # the natural torso volume so the jacket reads as cloth on a person.
        for v in me.vertices:
            if v.co.y > 0.04 and 1.14 < v.co.z < 1.42 and abs(v.co.x) < 0.17:
                v.co.y = 0.04 + (v.co.y - 0.04) * 0.35
    if head_scale != 1.0:
        hc = Vector((0, 0, 1.62))
        for v in me.vertices:
            if v.co.z > 1.50:
                w = min(1.0, (v.co.z - 1.50) / 0.06)
                f = 1.0 + (head_scale - 1.0) * w
                v.co = hc + (v.co - hc) * f
    if flatten_face:
        # The generic recruit is fully masked, so simplify features beneath
        # the faceplate and tuck ears beneath the helmet shell.
        for v in me.vertices:
            if v.co.y > 0.045 and 1.45 < v.co.z < 1.70 and abs(v.co.x) < 0.10:
                v.co.y = 0.045
        for v in me.vertices:
            ax = abs(v.co.x)
            if ax > 0.058 and 1.53 < v.co.z < 1.68 and abs(v.co.y) < 0.09:
                v.co.x = math.copysign(0.058 + (ax - 0.058) * 0.08, v.co.x)
    # merge the toes into a boot-wedge so boot shells + toe caps seal the foot
    for v in me.vertices:
        if v.co.z < 0.06 and v.co.y > 0.10:
            v.co.y = 0.10 + (v.co.y - 0.10) * 0.55
            v.co.x *= 0.86
    if curl:
        curl_fingers(me)
    me.update()
    return o


def curl_fingers(me, knuckle_z=0.845, max_deg=55.0, run=0.09):
    """Relaxed half-fist on the hanging arms (|x| > 0.24, fingers point -z)."""
    for v in me.vertices:
        x, y, z = v.co
        if abs(x) < 0.24 or z > knuckle_z or z < 0.70:
            continue
        side = 1.0 if x > 0 else -1.0
        t = min(1.0, (knuckle_z - z) / run)
        ang = math.radians(max_deg) * t * t
        px = 0.30 * side
        dx, dz = x - px, z - knuckle_z
        c, s = math.cos(ang), math.sin(ang)
        v.co.x = px + (dx * c + dz * s * side)
        v.co.z = knuckle_z + (-dx * s * side + dz * c)


# ---------------- UV-island face labeling (unchanged, battle-tested)
def label_faces(me):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    uv = bm.loops.layers.uv.active
    parent = list(range(len(bm.faces)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    vert_uv = defaultdict(lambda: defaultdict(list))
    for f in bm.faces:
        for l in f.loops:
            u = l[uv].uv
            vert_uv[l.vert.index][(round(u.x, 5), round(u.y, 5))].append(f.index)
    for groups in vert_uv.values():
        for fis in groups.values():
            for fi in fis[1:]:
                union(fis[0], fi)

    islands = defaultdict(list)
    for f in bm.faces:
        islands[find(f.index)].append(f.index)

    labels = {}
    for fids in islands.values():
        ctr = sum((bm.faces[i].calc_center_median() for i in fids), Vector()) / len(fids)
        zs = [bm.faces[i].calc_center_median().z for i in fids]
        zmin, zmax = min(zs), max(zs)
        n = len(fids)
        side = "L" if ctr.x > 0 else "R"
        if n > 1200 and zmax > 1.4:
            part = "head"
        elif n > 1200:
            part = f"leg.{side}"
        elif 600 < n <= 900 and zmax > 1.3:
            part = f"arm.{side}"
        elif 500 < n <= 700 and zmin > 0.9:
            part = f"torso.{side}"
        elif zmax < 0.15:
            part = f"foot.{side}"
        elif n > 400 and zmin > 1.3:
            part = "chest_upper"
        elif zmin > 1.45 and n > 150 and n < 260:
            part = f"ear.{side}"
        elif zmin > 1.4:
            part = "scalp"
        elif zmin > 0.7 and zmax < 1.1:
            part = f"hand.{side}"
        else:
            part = "misc"
        for i in fids:
            labels[i] = part
    parts = defaultdict(list)
    for i, p in labels.items():
        parts[p].append(i)
    bm.free()
    return labels, dict(parts)


# ---------------- garment regions
GARMENTS = {
    "pants":  {"parts": ("leg.L", "leg.R", "torso.L", "torso.R"), "z": (0.24, 1.08)},
    "boots":  {"parts": ("foot.L", "foot.R", "leg.L", "leg.R"), "z": (0.0, 0.30)},
    "gloves": {"parts": ("hand.L", "hand.R", "arm.L", "arm.R"), "z": (0.0, 0.98)},
    "jacket": {"parts": ("torso.L", "torso.R", "chest_upper", "arm.L", "arm.R",
                          "misc"), "z": (1.10, 1.58)},   # cropped (v4)
    "mask":   {"parts": ("head",), "z": (1.50, 1.65), "y": (0.03, 9),
               "not_x_z": (0.062, 9)},
    "helmet": {"parts": ("head", "scalp"), "z": (1.50, 9),
               "not_y_z": (0.05, 1.66), "not_x_z": (0.055, 1.65)},
    "haircap": {"parts": ("scalp", "ear.L", "ear.R", "head"), "z": (1.56, 9),
                "not_y_z": (0.015, 1.72)},
    "haircap_open": {"parts": ("scalp", "head"), "z": (1.585, 9),
                     "not_y_z": (0.018, 1.715)},
}


def shell(body, labels, garment, name, offset, thick, material):
    g = GARMENTS[garment]
    zlo, zhi = g.get("z", (-9, 9))
    ylo, yhi = g.get("y", (-9, 9))
    bm = bmesh.new()
    bm.from_mesh(body.data)
    bm.faces.ensure_lookup_table()
    keep = []
    for f in bm.faces:
        c = f.calc_center_median()
        if labels.get(f.index) not in g["parts"]:
            continue
        if not (zlo <= c.z <= zhi and ylo <= c.y <= yhi):
            continue
        if "not_y_z" in g:
            ny, nz = g["not_y_z"]
            if c.y > ny and c.z < nz:
                continue
        if "not_x_z" in g:
            nx, nz = g["not_x_z"]
            if abs(c.x) > nx and c.z < nz:
                continue
        keep.append(f)
    if not keep:
        bm.free()
        raise ValueError(f"empty garment {garment}")
    keep_set = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep_set], context="FACES")
    bm.faces.ensure_lookup_table()
    seen, comps = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, comp = [f], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            for e in x.edges:
                stack += [ff for ff in e.link_faces if ff not in seen]
        comps.append(comp)
    small = [f for comp in comps if len(comp) < 12 for f in comp]
    if small:
        bmesh.ops.delete(bm, geom=small, context="FACES")
    for v in bm.verts:
        v.co += v.normal * offset
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    md = o.modifiers.new("sol", "SOLIDIFY")
    md.thickness = thick
    md.offset = 1.0
    W._activate(o)
    bpy.ops.object.modifier_apply(modifier="sol")
    o.data.materials.append(material)
    W._smooth(o, 45)
    return o


def smooth_open_boundary(o, iters=6, sel=lambda co: True):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    boundary = [v for v in bm.verts
                if sel(v.co) and any(len(e.link_faces) == 1 for e in v.link_edges)]
    bset = set(boundary)
    for _ in range(iters):
        new = {}
        for v in boundary:
            nbrs = [e.other_vert(v) for e in v.link_edges
                    if e.other_vert(v) in bset and len(e.link_faces) == 1]
            if len(nbrs) >= 2:
                avg = sum((n.co for n in nbrs), v.co * 0) / len(nbrs)
                new[v] = v.co * 0.4 + avg * 0.6
        for v, co in new.items():
            v.co = co
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def flatten_jacket_chest(o):
    for v in o.data.vertices:
        if v.co.y > 0.045 and 1.16 < v.co.z < 1.42 and abs(v.co.x) < 0.16:
            v.co.y = 0.045 + (v.co.y - 0.045) * 0.35
    o.data.update()


def chain(name, pts, rads, material, subsurf=2):
    """Skin-modifier tube along points — organic locks/straps."""
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [(i, i + 1) for i in range(len(pts) - 1)], [])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    W._activate(o)
    o.modifiers.new("skin", "SKIN")
    for i, r in enumerate(rads):
        me.skin_vertices[0].data[i].radius = (r, r)
    me.skin_vertices[0].data[0].use_root = True
    bpy.ops.object.modifier_apply(modifier="skin")
    md = o.modifiers.new("ss", "SUBSURF")
    md.levels = subsurf
    bpy.ops.object.modifier_apply(modifier="ss")
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    return o


def ring(name, R, r, loc, material, scale=None, rot=None, segs=(24, 10)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r,
                                     major_segments=segs[0], minor_segments=segs[1],
                                     location=loc)
    o = bpy.context.object
    o.name = name
    if rot:
        o.rotation_euler = [math.radians(d) for d in rot]
    if scale:
        o.scale = scale
    bpy.ops.object.transform_apply(rotation=True, scale=True)
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


# ---------------- soft-form helpers (Zephyr v5)
def ellipsoid(name, loc, scale, material, rot=None, segs=20, rings=12):
    """Smooth low-poly ellipsoid used for facial and hair forms."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1,
                                         location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    if rot:
        o.rotation_euler = [math.radians(d) for d in rot]
    bpy.ops.object.transform_apply(rotation=True, scale=True)
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


def ribbon(name, pts, widths, material, thick=0.004, bevel_w=0.002):
    """Tapered fabric strip following a centerline.

    Ribbons face roughly along Y (front/back of the character), which covers
    coat tails, shoulder streamers and embroidered wind marks without giving
    them the rigid cuboid language of the weapon helper plates.
    """
    pts = [Vector(p) for p in pts]
    if isinstance(widths, (int, float)):
        widths = [float(widths)] * len(pts)
    if len(pts) != len(widths):
        raise ValueError("ribbon needs one width per point")
    verts = []
    normal = Vector((0, 1, 0))
    for i, (p, width) in enumerate(zip(pts, widths)):
        tangent = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
        side = normal.cross(tangent)
        if side.length < 1e-6:
            side = Vector((1, 0, 0))
        else:
            side.normalize()
        verts += [p - side * width * 0.5, p + side * width * 0.5]
    faces = [(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
             for i in range(len(pts) - 1)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.materials.append(material)
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    W._activate(o)
    md = o.modifiers.new("sol", "SOLIDIFY")
    md.thickness = thick
    md.offset = 0
    bpy.ops.object.modifier_apply(modifier=md.name)
    if bevel_w:
        W.bevel(o, bevel_w, segs=2, deg=20)
    bpy.ops.object.shade_smooth()
    return o


# ================= ZEPHYR v5 addons =================
def addons_zephyr_v5(M, body, labels):
    A = []
    (gear, accent, glow, jacket, jacket_in, hair, hair_dark, skin, skin_warm,
     eye, eye_white, metal) = (
        M["gear"], M["accent"], M["glow"], M["jacket"], M["jacket_in"],
        M["hair"], M["hair_dark"], M["skin"], M["skin_warm"], M["eye"],
        M["eye_white"], M["metal"])

    # ---- expressive human face; the base mesh supplies nose, cheeks and jaw
    for s, x in (("L", 0.055), ("R", -0.048)):
        rz = -4 if s == "L" else 4
        A.append(ellipsoid(f"z_eye_white.{s}", (x, 0.102, 1.568),
                           (0.030, 0.006, 0.013), eye_white, rot=(0, 0, rz)))
        A.append(ellipsoid(f"z_iris.{s}", (x, 0.109, 1.568),
                           (0.0085, 0.003, 0.0085), eye))
        A.append(ellipsoid(f"z_eye_glint.{s}", (x + 0.002, 0.112, 1.571),
                           (0.0022, 0.0012, 0.0022), glow, segs=12, rings=8))
    A.append(chain("z_brow.L", [(0.010, 0.114, 1.596), (0.033, 0.116, 1.601),
                                 (0.055, 0.110, 1.596)],
                   [0.0025, 0.0030, 0.0015], hair_dark, subsurf=1))
    A.append(chain("z_brow.R", [(-0.010, 0.114, 1.596), (-0.033, 0.116, 1.600),
                                 (-0.055, 0.110, 1.593)],
                   [0.0025, 0.0030, 0.0015], hair_dark, subsurf=1))
    A.append(chain("z_lips", [(-0.026, 0.119, 1.500), (-0.009, 0.123, 1.497),
                               (0.009, 0.123, 1.497), (0.026, 0.119, 1.500)],
                   [0.0015, 0.0027, 0.0027, 0.0015], skin_warm, subsurf=1))
    # A tiny painted wind stroke under her left eye becomes the hero face mark.
    A.append(chain("z_face_mark", [(0.045, 0.115, 1.548), (0.055, 0.112, 1.539),
                                    (0.067, 0.107, 1.542)],
                   [0.0018, 0.0022, 0.0008], accent, subsurf=1))

    # ---- mint-white hair with a swept fringe and an off-center ponytail
    A.append(chain("z_fringe_main", [(-0.050, 0.020, 1.726), (-0.026, 0.082, 1.704),
                                      (0.018, 0.107, 1.682), (0.065, 0.090, 1.647)],
                   [0.016, 0.014, 0.010, 0.0025], hair))
    A.append(chain("z_fringe_side", [(-0.070, 0.010, 1.708), (-0.079, 0.069, 1.665),
                                      (-0.082, 0.074, 1.608), (-0.073, 0.060, 1.566)],
                   [0.012, 0.010, 0.006, 0.002], hair_dark))
    A.append(chain("z_fringe_light", [(0.005, 0.052, 1.724), (0.045, 0.100, 1.700),
                                       (0.083, 0.072, 1.668)],
                   [0.010, 0.007, 0.002], hair))
    for s, x in (("L", 0.080), ("R", -0.080)):
        A.append(chain(f"z_side_lock.{s}", [(x, 0.047, 1.650),
                                             (x, 0.064, 1.615),
                                             (x * 0.96, 0.052, 1.575)],
                       [0.010, 0.008, 0.002],
                       hair_dark if s == "L" else hair, subsurf=1))
    A.append(ellipsoid("z_hair_knot", (0.040, -0.112, 1.692),
                       (0.050, 0.043, 0.046), hair_dark, rot=(12, 0, -18)))
    pony = [(0.045, -0.135, 1.688), (0.073, -0.205, 1.640),
            (0.100, -0.255, 1.545), (0.082, -0.270, 1.430),
            (0.040, -0.245, 1.325), (0.020, -0.205, 1.270)]
    A.append(chain("z_ponytail", pony,
                   [0.044, 0.050, 0.042, 0.030, 0.016, 0.004], hair))
    A.append(chain("z_ponytail_streak", [(0.073, -0.218, 1.625),
                                          (0.096, -0.272, 1.530),
                                          (0.075, -0.285, 1.430),
                                          (0.046, -0.250, 1.348)],
                   [0.009, 0.008, 0.005, 0.0015], hair_dark, subsurf=1))
    A.append(ring("z_hair_tie", 0.028, 0.006, (0.047, -0.143, 1.681), accent,
                  rot=(63, 0, -15), segs=(16, 6)))

    # ---- soft neckline and hood fold, close to the body rather than a halo
    A.append(ring("z_neckline", 0.074, 0.011, (0, -0.002, 1.498), jacket_in,
                  scale=(1.0, 1.14, 0.48), rot=(7, 0, 0), segs=(20, 8)))
    A.append(chain("z_hood_fold", [(-0.075, -0.030, 1.500),
                                    (0.000, -0.100, 1.520),
                                    (0.075, -0.030, 1.500)],
                   [0.015, 0.021, 0.015], jacket, subsurf=1))

    # ---- asymmetric fabric sash and wind-streamer shoulder tails
    A.append(ribbon("z_sash", [(0.145, 0.080, 1.445), (0.080, 0.101, 1.365),
                                (0.020, 0.108, 1.285), (-0.055, 0.090, 1.190),
                                (-0.110, 0.060, 1.108)],
                    [0.060, 0.057, 0.052, 0.045, 0.032], accent,
                    thick=0.005, bevel_w=0.0025))
    A.append(ellipsoid("z_sash_knot", (0.156, 0.030, 1.445),
                       (0.029, 0.019, 0.025), accent, rot=(0, 18, -15)))
    A.append(ribbon("z_streamer_outer", [(0.170, -0.015, 1.430),
                                          (0.195, -0.052, 1.397),
                                          (0.220, -0.088, 1.350),
                                          (0.238, -0.116, 1.300),
                                          (0.247, -0.134, 1.245),
                                          (0.243, -0.142, 1.195),
                                          (0.225, -0.145, 1.155)],
                    [0.062, 0.060, 0.055, 0.046, 0.035, 0.022, 0.008], accent,
                    thick=0.004, bevel_w=0.002))
    A.append(ribbon("z_streamer_inner", [(0.145, -0.022, 1.425),
                                          (0.128, -0.064, 1.380),
                                          (0.118, -0.106, 1.330),
                                          (0.130, -0.132, 1.275),
                                          (0.145, -0.146, 1.225),
                                          (0.143, -0.151, 1.180),
                                          (0.130, -0.150, 1.145)],
                    [0.046, 0.044, 0.040, 0.034, 0.027, 0.016, 0.006], jacket_in,
                    thick=0.004, bevel_w=0.002))

    # ---- jacket tailoring and one textile forearm wrap
    A.append(W.plate("z_zipper", (0.007, 0.007, 0.195),
                     (0, 0.102, 1.303), jacket_in, bevel_w=0.0012))
    A.append(W.loft("z_forearm_wrap", [
        ((0.275, -0.025, 1.100), 0.042, 0.040, 0),
        ((0.291, -0.030, 1.035), 0.040, 0.038, 0),
        ((0.307, -0.034, 0.975), 0.037, 0.035, 0),
    ], gear, ring=10, round_k=0.60, subsurf=1))
    A.append(ribbon("z_wrap_glyph", [(0.307, 0.002, 1.072),
                                      (0.320, 0.004, 1.040),
                                      (0.313, 0.003, 1.008)],
                    [0.007, 0.010, 0.003], glow, thick=0.002,
                    bevel_w=0.001))

    # ---- low-profile utility belt, one pouch and a dangling wind charm
    A.append(ring("z_belt", 0.124, 0.012, (0, -0.002, 1.046), gear,
                  scale=(1.0, 0.74, 0.72), segs=(24, 8)))
    A.append(W.plate("z_belt_clasp", (0.038, 0.012, 0.026),
                     (0, 0.088, 1.046), accent, taper=(0.82, 0.82),
                     bevel_w=0.002))
    A.append(W.plate("z_pouch", (0.064, 0.045, 0.082),
                     (-0.145, 0.018, 0.995), gear, rot=(0, 0, 7),
                     taper=(0.88, 0.86), bevel_w=0.004))
    A.append(ring("z_wind_charm", 0.021, 0.0035, (0.145, 0.075, 1.002), metal,
                  rot=(90, 0, 0), segs=(18, 6)))
    A.append(chain("z_charm_swirl", [(0.134, 0.080, 1.005),
                                      (0.145, 0.082, 1.013),
                                      (0.155, 0.081, 1.003)],
                   [0.0012, 0.0018, 0.0006], glow, subsurf=1))

    # ---- two lightweight, wind-swept coat tails
    A.append(ribbon("z_coattail.L", [(0.050, -0.092, 1.055),
                                      (0.078, -0.135, 0.955),
                                      (0.090, -0.145, 0.825),
                                      (0.065, -0.120, 0.705)],
                    [0.075, 0.082, 0.060, 0.012], jacket,
                    thick=0.005, bevel_w=0.0025))
    A.append(ribbon("z_coattail.R", [(-0.045, -0.090, 1.052),
                                      (-0.070, -0.125, 0.970),
                                      (-0.050, -0.150, 0.860),
                                      (-0.015, -0.138, 0.760)],
                    [0.068, 0.073, 0.050, 0.010], jacket_in,
                    thick=0.005, bevel_w=0.0025))

    # ---- minimal boots: grounded soles and a single smooth shoe volume
    for s, x in (("L", 0.082), ("R", -0.082)):
        A.append(W.plate(f"z_sole.{s}", (0.086, 0.235, 0.018),
                         (x, 0.045, 0.012), gear, bevel_w=0.005))
        A.append(ellipsoid(f"z_boot_toe.{s}", (x, 0.120, 0.052),
                           (0.061, 0.075, 0.030), gear,
                           rot=(6, 0, 0), segs=18, rings=10))

    # ---- embroidered wind signature on the back; this replaces the fan pack
    A.append(chain("z_back_wind_top", [(-0.070, -0.132, 1.355),
                                        (-0.030, -0.142, 1.378),
                                        (0.015, -0.144, 1.372),
                                        (0.055, -0.136, 1.350)],
                   [0.0020, 0.0030, 0.0020, 0.0007], accent, subsurf=1))
    A.append(chain("z_back_wind_low", [(-0.045, -0.135, 1.325),
                                        (-0.010, -0.144, 1.340),
                                        (0.030, -0.140, 1.332)],
                   [0.0015, 0.0024, 0.0006], glow, subsurf=1))
    return A


# ================= RECRUIT addons =================
def addons_recruit(M, body, labels):
    A = []
    gear, accent, glow, jacket, metal, hair = (M["gear"], M["accent"], M["glow"],
                                               M["jacket"], M["metal"], M["hair"])
    # full trooper faceplate (faces stay masked) + visor bar + brim + antenna
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=14, radius=0.096)
    fp = bpy.context.object
    fp.name = "r_faceplate"
    fp.scale = (1.0, 0.68, 1.34)
    fp.location = (0, 0.050, 1.576)
    bpy.ops.object.transform_apply(scale=True)
    fp.data.materials.append(gear)
    bpy.ops.object.shade_smooth()
    A.append(fp)
    A.append(W.plate("r_visor", (0.120, 0.018, 0.026), (0, 0.112, 1.592), glow,
                     rot=(-8, 0, 0), bevel_w=0.003))
    A.append(W.plate("r_brim", (0.150, 0.045, 0.016), (0, 0.108, 1.662), gear,
                     rot=(-16, 0, 0), taper=(0.85, 0.7), bevel_w=0.003))
    A.append(W.cyl("r_antenna", 0.004, 0.09, (-0.055, -0.05, 1.73), metal, axis="Z",
                   segs=8))
    # neck seal covering the jacket's top boundary
    A.append(ring("r_collar", 0.096, 0.024, (0, 0.005, 1.51), gear,
                  scale=(1.0, 1.15, 0.6), rot=(6, 0, 0)))
    # chest + back plates, shoulder pads
    A.append(W.plate("r_chest", (0.150, 0.030, 0.125), (0, 0.048, 1.315), metal,
                     rot=(-6, 0, 0), taper=(0.82, 0.75), bevel_w=0.004))
    A.append(W.plate("r_back", (0.170, 0.050, 0.170), (0, -0.115, 1.30), gear,
                     taper=(0.85, 0.85), bevel_w=0.004))
    for s, x in (("L", 0.158), ("R", -0.158)):
        A.append(W.plate(f"r_shoulder.{s}", (0.105, 0.10, 0.030), (x, -0.005, 1.430),
                         gear, rot=(0, 32 if s == "L" else -32, 0), taper=(0.78, 0.82),
                         bevel_w=0.003))
    # belt + buckle + thigh rig
    A.append(ring("r_belt", 0.128, 0.020, (0, -0.002, 1.048), gear, scale=(1, 0.74, 1)))
    A.append(W.plate("r_buckle", (0.05, 0.016, 0.036), (0, 0.092, 1.048), glow,
                     bevel_w=0.002))
    A.append(W.plate("r_thigh", (0.075, 0.06, 0.10), (-0.135, 0.02, 0.86), gear,
                     rot=(0, 0, 6), taper=(0.9, 0.85), bevel_w=0.003))
    # kneepads + boots
    for s, x in (("L", 0.080), ("R", -0.080)):
        A.append(W.plate(f"r_knee.{s}", (0.092, 0.046, 0.10), (x, 0.024, 0.535), gear,
                         rot=(-10, 0, 0), taper=(0.8, 0.7), bevel_w=0.003))
        A.append(W.plate(f"r_sole.{s}", (0.088, 0.25, 0.026), (x, 0.05, 0.013), gear,
                         bevel_w=0.004))
        A.append(W.plate(f"r_toe.{s}", (0.082, 0.10, 0.055), (x, 0.155, 0.046), gear,
                         taper=(0.85, 0.6), bevel_w=0.003))
    # accent stripes (retinted client-side for IFF)
    for s, x in (("L", 0.158), ("R", -0.158)):
        A.append(W.plate(f"r_armband.{s}", (0.012, 0.07, 0.02), (x, -0.015, 1.35),
                         accent, rot=(0, -14 if s == "L" else 14, 0), bevel_w=0.002))
    A.append(W.plate("r_chevron", (0.004, 0.03, 0.010), (0.0, 0.078, 1.36), accent,
                     rot=(0, 0, 0), bevel_w=0.001))
    return A


ADDONS = {"zephyr_v5": addons_zephyr_v5, "recruit": addons_recruit}


def build(agent_key):
    if agent_key == "zephyr":
        # Zephyr's current production model is a clean-slate human build on the
        # realistic CC0 base. Keep the legacy shell builder below for RECRUIT
        # and for opening older saved sessions.
        import build_zephyr_scratch
        return build_zephyr_scratch.build()
    spec = AGENTS[agent_key]
    pal = spec["palette"]
    mn = spec.get("mat_names")
    coll = bpy.data.collections.get(f"agent_{agent_key}")
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    # purge stale same-named materials (older sessions wired vertex-color AO
    # multiplies into them — with no baked attribute they render black)
    for m in list(bpy.data.materials):
        if m.name.startswith(f"ag_{agent_key}_"):
            bpy.data.materials.remove(m)
    exposed_face = spec.get("exposed_face", False)
    body = normalize_base(spec["height"], spec.get("head_scale", 1.0),
                          flatten_face=not exposed_face,
                          flatten_chest=not exposed_face)
    labels, parts = label_faces(body.data)
    body.data.materials.clear()
    body.data.materials.append(mat(agent_key, "suit", pal["suit"], mn))
    if exposed_face:
        body.data.materials.append(mat(agent_key, "skin", pal["skin"], mn))
        body.data.materials.append(mat(agent_key, "hair", pal["hair"], mn))
        for p in body.data.polygons:
            part = labels.get(p.index)
            c = p.center
            if part == "scalp" or (part == "head" and
                                   (c.y < 0.012 or c.z > 1.675)):
                p.material_index = 2
            elif part in ("head", "ear.L", "ear.R"):
                p.material_index = 1
    made = [body]
    shells = []
    for g in spec["gear"]:
        m = mat(agent_key, g["mat"], pal[g["mat"]], mn)
        s = shell(body, labels, g["region"], f"{agent_key}_{g['region']}",
                  g["offset"], g["thick"], m)
        if g["region"] in ("jacket", "gloves", "pants", "helmet"):
            smooth_open_boundary(s)
        if g["region"] == "jacket" and not exposed_face:
            flatten_jacket_chest(s)
        shells.append(s)
    made += shells
    mats = {k: mat(agent_key, k, v, mn) for k, v in pal.items()}
    made += ADDONS[spec["addons"]](mats, body, labels)
    # smooth the BODY only — subsurf shrinks thin open shells under the skin,
    # and the body shrinking slightly under its shells is the safe direction
    md = body.modifiers.new("ss", "SUBSURF")
    md.levels = 1
    W._activate(body)
    bpy.ops.object.modifier_apply(modifier="ss")
    if exposed_face:
        # Re-establish a clean hairline after subdivision. Material indices
        # inherited from coarse source faces otherwise leave patchy bald areas.
        for p in body.data.polygons:
            c = p.center
            if c.z > 1.645 or (c.z > 1.565 and c.y < 0.012):
                p.material_index = 2
    W._smooth(body, 55)
    for o in shells:
        W._smooth(o, 55)
    if not coll:
        coll = bpy.data.collections.new(f"agent_{agent_key}")
        bpy.context.scene.collection.children.link(coll)
    for o in made:
        for c in o.users_collection:
            c.objects.unlink(o)
        coll.objects.link(o)
    return {"objects": [o.name for o in made],
            "parts": {k: len(v) for k, v in parts.items()}}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    print(build(kv.get("--agent", "zephyr")))
