"""Build an agent from the CC0 stylized base body + spec-driven gear shells.

v4: Zephyr redesigned (see specs.py) and a proper RECRUIT placeholder. The
proven v3 machinery stays — normalize base, UV-island face labeling, garment
shells via Solidify — with a new hard-surface addon kit borrowed from
tools/weapongen (beveled prisms/lofts instead of raw boxes), procedural hair
(scalp shell + swept ponytail), and Subsurf smoothing on body+shells.

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


def normalize_base(height, head_scale, curl=True):
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
    # armor-silhouette chest flatten on the BASE so every shell inherits it
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
    # faces are always masked (IP/style constraint) — flatten nose/lips/chin
    for v in me.vertices:
        if v.co.y > 0.045 and 1.45 < v.co.z < 1.70 and abs(v.co.x) < 0.10:
            v.co.y = 0.045
    # tuck the ears hard (helmet/haircap shells would tent over them otherwise)
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


# ================= ZEPHYR v4 addons =================
def addons_zephyr_v4(M, body, labels):
    A = []
    gear, accent, glow, jacket, jacket_in, hair, metal, pants = (
        M["gear"], M["accent"], M["glow"], M["jacket"], M["jacket_in"],
        M["hair"], M["metal"], M["pants"])
    # ---- masked face: smooth plate + chevron visor
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=14, radius=0.105)
    fp = bpy.context.object
    fp.name = "z_faceplate"
    fp.scale = (1.0, 0.8, 1.4)
    fp.location = (0, 0.048, 1.585)
    bpy.ops.object.transform_apply(scale=True)
    fp.data.materials.append(gear)
    bpy.ops.object.shade_smooth()
    A.append(fp)
    for s, x in (("L", 0.032), ("R", -0.032)):
        A.append(W.plate(f"z_visor.{s}", (0.062, 0.016, 0.020), (x * 1.0, 0.118, 1.606),
                         glow, rot=(-8, 0, -22 if s == "L" else 22), bevel_w=0.002))
    A.append(W.plate("z_visor_dot", (0.014, 0.014, 0.012), (0, 0.124, 1.588), glow,
                     rot=(-8, 0, 45), bevel_w=0.002))
    # brow ridge over the visor
    A.append(W.plate("z_brow", (0.15, 0.03, 0.018), (0, 0.095, 1.652), gear,
                     rot=(-14, 0, 0), taper=(0.85, 0.7), bevel_w=0.003))
    # ---- hair: scalp cap shell + swept bangs + high ponytail
    cap = shell(body, labels, "haircap", "z_haircap", 0.013, 0.013, hair)
    smooth_open_boundary(cap)
    A.append(cap)
    A.append(chain("z_bang", [(0.045, 0.095, 1.735), (-0.01, 0.115, 1.71),
                              (-0.062, 0.10, 1.66), (-0.085, 0.075, 1.615)],
                   [0.030, 0.026, 0.018, 0.008], hair))
    pony = [(0.01, -0.115, 1.745), (0.02, -0.21, 1.69), (0.005, -0.275, 1.56),
            (-0.015, -0.26, 1.40), (0.0, -0.20, 1.26), (0.01, -0.16, 1.17)]
    A.append(chain("z_ponytail", pony, [0.040, 0.048, 0.036, 0.024, 0.014, 0.006], hair))
    A.append(ring("z_tie", 0.030, 0.009, (0.013, -0.145, 1.735), accent,
                  rot=(65, 0, 0), segs=(16, 8)))
    A.append(ring("z_braid1", 0.024, 0.006, (0.002, -0.268, 1.50), metal,
                  rot=(80, 0, 0), segs=(14, 6)))
    A.append(ring("z_braid2", 0.017, 0.005, (-0.006, -0.235, 1.335), metal,
                  rot=(70, 0, 0), segs=(14, 6)))
    # ---- collar cowl
    A.append(ring("z_collar", 0.098, 0.024, (0, 0.005, 1.505), jacket,
                  scale=(1.0, 1.15, 0.55), rot=(8, 0, 0)))
    A.append(ring("z_collar_in", 0.085, 0.012, (0, 0.008, 1.515), jacket_in,
                  scale=(1.0, 1.1, 0.5), rot=(8, 0, 0), segs=(20, 8)))
    # ---- asymmetric pauldron (left shoulder, x > 0)
    A.append(W.plate("z_pauldron1", (0.145, 0.115, 0.030), (0.186, -0.005, 1.448),
                     metal, rot=(0, 26, 4), taper=(0.72, 0.80), bevel_w=0.003))
    A.append(W.plate("z_pauldron2", (0.125, 0.100, 0.026), (0.213, -0.010, 1.408),
                     jacket, rot=(0, 38, 4), taper=(0.75, 0.82), bevel_w=0.003))
    A.append(W.plate("z_pauldron3", (0.105, 0.088, 0.022), (0.233, -0.014, 1.368),
                     gear, rot=(0, 50, 4), taper=(0.78, 0.85), bevel_w=0.003))
    A.append(W.plate("z_pauldron_glow", (0.10, 0.012, 0.010), (0.194, 0.046, 1.452),
                     glow, rot=(0, 26, 4), bevel_w=0.0015))
    # ---- chest strap L-shoulder -> R-hip + buckle
    A.append(chain("z_strap", [(0.13, 0.068, 1.445), (0.045, 0.092, 1.32),
                               (-0.045, 0.085, 1.20), (-0.115, 0.045, 1.09)],
                   [0.012, 0.013, 0.013, 0.012], gear, subsurf=1))
    A.append(W.plate("z_buckle", (0.045, 0.018, 0.055), (0.005, 0.098, 1.30), accent,
                     rot=(-4, 0, -32), bevel_w=0.002))
    # ---- left forearm bracer + glow inlay
    A.append(W.loft("z_bracer", [
        ((0.264, -0.022, 1.095), 0.045, 0.042, 0),
        ((0.286, -0.028, 1.020), 0.042, 0.039, 0),
        ((0.305, -0.034, 0.950), 0.038, 0.035, 0),
    ], gear, ring=10, round_k=0.45, subsurf=1))
    A.append(W.plate("z_bracer_glow", (0.012, 0.014, 0.11), (0.318, -0.030, 1.023),
                     glow, rot=(0, -12, 0), bevel_w=0.0015))
    # ---- belt + buckle + canisters (right hip) + pouch (left hip)
    A.append(ring("z_belt", 0.128, 0.020, (0, -0.002, 1.048), gear, scale=(1, 0.74, 1)))
    A.append(W.plate("z_beltbuckle", (0.052, 0.016, 0.038), (0, 0.092, 1.048), glow,
                     bevel_w=0.002))
    for i, (bx, by) in enumerate(((-0.155, 0.020), (-0.125, 0.075))):
        A.append(W.cyl(f"z_can{i}", 0.020, 0.075, (bx, by, 0.995), metal, axis="Z",
                       segs=14, bevel_w=0.002))
        A.append(ring(f"z_canband{i}", 0.021, 0.004, (bx, by, 0.985), glow,
                      rot=(0, 0, 0), segs=(14, 6)))
    A.append(W.plate("z_pouch", (0.075, 0.055, 0.095), (0.152, 0.045, 0.995), gear,
                     rot=(0, 0, -8), taper=(0.9, 0.85), bevel_w=0.003))
    # ---- split tail panel off the back of the belt (glow strips joined in
    # BEFORE the S-curve deform so they follow the cloth)
    tail = W.plate("z_tail", (0.15, 0.012, 0.42), (0, -0.155, 0.83), jacket,
                   rot=(12, 0, 0), taper=(1.35, 1.0), bevel_w=0.002)
    strips = [W.plate(f"z_tail_glow.{s}", (0.005, 0.007, 0.30), (x, -0.164, 0.84),
                      glow, rot=(12, 0, 0), bevel_w=0.001)
              for s, x in (("L", 0.062), ("R", -0.062))]
    W._activate(tail)
    for st in strips:
        st.select_set(True)
    bpy.ops.object.join()
    tail = bpy.context.object
    for v in tail.data.vertices:
        t = max(0.0, min(1.0, (1.04 - v.co.z) / 0.42))
        v.co.y += 0.035 * math.sin(t * math.pi)
    tail.data.update()
    md = tail.modifiers.new("ss", "SUBSURF")
    md.levels = 1
    W._activate(tail)
    bpy.ops.object.modifier_apply(modifier="ss")
    A.append(tail)
    # ---- legs: knee guards, white shin plates, boot soles + toes
    for s, x in (("L", 0.082), ("R", -0.082)):
        A.append(W.plate(f"z_knee.{s}", (0.095, 0.048, 0.105), (x, 0.026, 0.535), gear,
                         rot=(-10, 0, 0), taper=(0.80, 0.70), bevel_w=0.003))
        A.append(W.plate(f"z_shin.{s}", (0.070, 0.030, 0.190), (x, 0.030, 0.315),
                         jacket, taper=(0.85, 0.80), bevel_w=0.003))
        A.append(W.plate(f"z_sole.{s}", (0.090, 0.255, 0.026), (x, 0.052, 0.013), gear,
                         bevel_w=0.004))
        A.append(W.plate(f"z_toe.{s}", (0.084, 0.100, 0.056), (x, 0.160, 0.048), gear,
                         taper=(0.85, 0.60), bevel_w=0.003))
        A.append(W.plate(f"z_heel.{s}", (0.080, 0.050, 0.070), (x, -0.075, 0.045), gear,
                         taper=(0.9, 0.8), bevel_w=0.003))
    # ---- back wind unit: core + glow ring + 3 fan blades (proud of the jacket)
    A.append(W.cyl("z_windcore", 0.056, 0.065, (0, -0.160, 1.295), gear, axis="Y",
                   segs=24, bevel_w=0.003))
    A.append(ring("z_windglow", 0.046, 0.007, (0, -0.196, 1.295), glow,
                  rot=(90, 0, 0), segs=(24, 8)))
    for i, (bx, ang) in enumerate(((-0.060, 18), (0, 0), (0.060, -18))):
        A.append(W.plate(f"z_blade{i}", (0.015, 0.020, 0.185), (bx, -0.190, 1.372),
                         metal, rot=(22, ang, 0), taper=(0.35, 0.60), bevel_w=0.002))
        A.append(W.plate(f"z_bladeglow{i}", (0.006, 0.008, 0.15),
                         (bx * 1.06, -0.200, 1.372), glow, rot=(22, ang, 0),
                         taper=(0.35, 0.6), bevel_w=0.001))
    # ---- glow seams + zipper + emblem
    for s, x in (("L", 0.107), ("R", -0.107)):
        A.append(W.plate(f"z_seam_leg.{s}", (0.005, 0.012, 0.30), (x, 0.004, 0.78),
                         glow, bevel_w=0.001))
    A.append(W.plate("z_zipper", (0.010, 0.012, 0.21), (0, 0.086, 1.315), accent,
                     bevel_w=0.0015))
    # teal presence: sleeve cuffs, jacket hem, boot-top bands
    for s, x in (("L", 0.272), ("R", -0.272)):
        A.append(ring(f"z_cuff.{s}", 0.052, 0.011, (x, -0.024, 1.118), accent,
                      scale=(1, 1, 1.2), rot=(0, 10 if s == "L" else -10, 0),
                      segs=(18, 8)))
    A.append(W.plate("z_hem", (0.21, 0.014, 0.016), (0, 0.058, 1.098), accent,
                     bevel_w=0.002))
    for s, x in (("L", 0.086), ("R", -0.086)):
        A.append(ring(f"z_boottop.{s}", 0.057, 0.010, (x, 0.010, 0.290), accent,
                      scale=(1, 1.22, 0.7), segs=(18, 8)))
    for i, r in enumerate((28, -28)):
        A.append(W.plate(f"z_emblem{i}", (0.0035, 0.022, 0.007), (0.075 + i * 0.001, 0.088, 1.392),
                         glow, rot=(0, 0, r), bevel_w=0.001))
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


ADDONS = {"zephyr_v4": addons_zephyr_v4, "recruit": addons_recruit}


def build(agent_key):
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
    body = normalize_base(spec["height"], spec.get("head_scale", 1.0))
    labels, parts = label_faces(body.data)
    body.data.materials.clear()
    body.data.materials.append(mat(agent_key, "suit", pal["suit"], mn))
    made = [body]
    shells = []
    for g in spec["gear"]:
        m = mat(agent_key, g["mat"], pal[g["mat"]], mn)
        s = shell(body, labels, g["region"], f"{agent_key}_{g['region']}",
                  g["offset"], g["thick"], m)
        if g["region"] in ("jacket", "gloves", "pants", "helmet"):
            smooth_open_boundary(s)
        if g["region"] == "jacket":
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
