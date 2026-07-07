"""Build an agent from the CC0 stylized base body + spec-driven gear shells.

Headless: blender --background --python tools/agentgen/build_agent.py -- --agent zephyr
Live: import and call build(agent_key) — the MCP session does this.

Pipeline: normalize base (recenter! the bundle stores bodies off-origin) →
label faces by UV island (islands = natural anatomical seams: head, torso
halves, arms, legs, feet, ears...) → garment regions = island sets + z windows
→ Solidify shells → materials. Hard add-ons and rig/anim/bake live in sibling
scripts so critique iterations stay fast.
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
sys.path.insert(0, str(TOOLS))
from specs import AGENTS  # noqa: E402

VENDOR_BLEND = TOOLS.parents[1] / "assets/blender/vendor/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend"
BASE_OBJ = "GEO-body_female_stylized"


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(agent, key, spec):
    name = f"ag_{agent}_{key}"
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


def normalize_base(height, head_scale):
    # always re-append fresh so the normalize transforms are applied exactly once
    o = bpy.data.objects.get(BASE_OBJ)
    if o:
        bpy.data.objects.remove(o, do_unlink=True)
    with bpy.data.libraries.load(str(VENDOR_BLEND)) as (df, dt):
        dt.objects = [BASE_OBJ]
    o = bpy.data.objects[BASE_OBJ]
    bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    me = o.data
    # recenter x/y on bbox, feet to z=0, scale to height
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
    # AFTER head scaling so the faceplate seats cleanly with nothing poking out
    for v in me.vertices:
        if v.co.y > 0.045 and 1.45 < v.co.z < 1.70 and abs(v.co.x) < 0.10:
            v.co.y = 0.045
    me.update()
    return o


# ---------------- UV-island face labeling
def label_faces(me):
    """Returns (labels: face_index -> part name, parts: part -> [face_idx])."""
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


# ---------------- garment regions: (parts, z-window, y-window)
GARMENTS = {
    "pants":  {"parts": ("leg.L", "leg.R", "torso.L", "torso.R"), "z": (0.24, 1.08)},
    "boots":  {"parts": ("foot.L", "foot.R", "leg.L", "leg.R"), "z": (0.0, 0.30)},
    "gloves": {"parts": ("hand.L", "hand.R", "arm.L", "arm.R"), "z": (0.0, 0.98)},
    "jacket": {"parts": ("torso.L", "torso.R", "chest_upper", "arm.L", "arm.R",
                          "misc"), "z": (1.04, 1.58)},
    "mask":   {"parts": ("head",), "z": (1.50, 1.65), "y": (0.03, 9)},
    "hood":   {"parts": ("head", "scalp", "ear.L", "ear.R", "chest_upper", "misc"),
               "z": (1.47, 9), "not_y_z": (0.075, 1.64)},  # tighter face opening (faceplate covers the rest)
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
        keep.append(f)
    if not keep:
        bm.free()
        raise ValueError(f"empty garment {garment}")
    keep_set = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep_set], context="FACES")
    # drop tiny disconnected islands (<12 faces) that make floating chips
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
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier="sol")
    o.data.materials.append(material)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(45))
    except Exception:
        bpy.ops.object.shade_smooth()
    return o


# ---------------- hard-surface add-ons (angular plates, no spheres)
def _bevel(o, w=0.004):
    md = o.modifiers.new("bv", "BEVEL")
    md.width = w
    md.segments = 2
    md.limit_method = "ANGLE"
    md.angle_limit = math.radians(40)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier="bv")


def plate(name, dims, loc, material, rot=None, taper=None, bevel=0.004):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    if taper:
        tx, ty = taper
        for v in o.data.vertices:
            if v.co.z > 0:
                v.co.x *= tx
                v.co.y *= ty
    if rot:
        o.rotation_euler = [math.radians(d) for d in rot]
        bpy.ops.object.transform_apply(rotation=True)
    o.location = loc
    o.data.materials.append(material)
    if bevel:
        _bevel(o, bevel)
    return o


def ring(name, R, r, loc, material, scale=None):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r,
                                     major_segments=20, minor_segments=8,
                                     location=loc)
    o = bpy.context.object
    o.name = name
    if scale:
        o.scale = scale
        bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    return o


def chain(name, pts, rads, material):
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [(i, i + 1) for i in range(len(pts) - 1)], [])
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    o.modifiers.new("skin", "SKIN")
    for i, r in enumerate(rads):
        me.skin_vertices[0].data[i].radius = (r, r)
    me.skin_vertices[0].data[0].use_root = True
    bpy.ops.object.modifier_apply(modifier="skin")
    md = o.modifiers.new("ss", "SUBSURF")
    md.levels = 2
    bpy.ops.object.modifier_apply(modifier="ss")
    bpy.ops.object.shade_smooth()
    o.data.materials.append(material)
    return o


def addons_zephyr(mats):
    A = []
    gear, accent, glow, jacket, hair = (mats["gear"], mats["accent"],
                                        mats["glow"], mats["jacket"], mats["hair"])
    # smooth faceplate + visor (constraint: no exposed faces)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.105)
    fp = bpy.context.object
    fp.name = "z_faceplate"
    fp.scale = (1.0, 0.8, 1.4)
    fp.location = (0, 0.05, 1.585)
    bpy.ops.object.transform_apply(scale=True)
    fp.data.materials.append(gear)
    bpy.ops.object.shade_smooth()
    A.append(fp)
    A.append(plate("z_visor", (0.14, 0.018, 0.022), (0, 0.122, 1.612), glow,
                   rot=(-8, 0, 0), bevel=0.003))
    # belt + buckle (hip half-width ~0.19 without arms)
    A.append(ring("z_belt", 0.15, 0.02, (0, -0.01, 1.04), gear, scale=(1, 0.85, 1)))
    A.append(plate("z_buckle", (0.05, 0.018, 0.036), (0, 0.105, 1.04), glow, bevel=0.003))
    # wrist cuffs (hide sleeve seams)
    for s, x in (("L", 0.332), ("R", -0.332)):
        A.append(ring(f"z_cuff.{s}", 0.05, 0.012, (x, -0.035, 0.99), accent,
                      scale=(1, 1, 1.25)))
    # chest rig: two angular plates + strap, snug to chest (front y≈0.074)
    for s, x in (("L", 0.062), ("R", -0.062)):
        A.append(plate(f"z_chestplate.{s}", (0.09, 0.03, 0.13), (x, 0.052, 1.30),
                       gear, rot=(-4, 0, -5 if s == "L" else 5), taper=(0.85, 0.8)))
    # kneepads + shin guards + boot soles/toes (leg front y≈0.03)
    for s, x in (("L", 0.078), ("R", -0.078)):
        A.append(plate(f"z_knee.{s}", (0.09, 0.045, 0.10), (x, 0.022, 0.535), gear,
                       rot=(-10, 0, 0), taper=(0.8, 0.7)))
        A.append(plate(f"z_shin.{s}", (0.07, 0.03, 0.20), (x, 0.026, 0.32), jacket,
                       taper=(0.85, 0.8)))
        A.append(plate(f"z_sole.{s}", (0.088, 0.25, 0.026), (x, 0.05, 0.014), gear,
                       bevel=0.006))
        A.append(plate(f"z_toe.{s}", (0.082, 0.10, 0.06), (x, 0.155, 0.045), gear,
                       taper=(0.85, 0.6)))
    # ponytail (signature silhouette)
    A.append(chain("z_ponytail",
                   [(0, -0.14, 1.70), (0, -0.245, 1.60), (0, -0.315, 1.44),
                    (0, -0.305, 1.27), (0, -0.25, 1.15)],
                   [0.045, 0.052, 0.040, 0.022, 0.009], hair))
    # back unit + ult blades (below hood hem)
    A.append(plate("z_backpack", (0.17, 0.05, 0.16), (0, -0.125, 1.26), gear,
                   taper=(0.85, 0.85), bevel=0.006))
    for i, (bx, ang) in enumerate(((-0.065, 16), (0, 0), (0.065, -16))):
        A.append(plate(f"z_blade{i}", (0.016, 0.022, 0.20), (bx, -0.175, 1.36), glow,
                       rot=(22, ang, 0), taper=(0.35, 0.6), bevel=0.002))
    # zipper line breaks the blank jacket front
    A.append(plate("z_zipper", (0.012, 0.012, 0.26), (0, 0.066, 1.235), accent,
                   bevel=0.002))
    return A


def smooth_open_boundary(o, iters=6, sel=lambda co: True):
    """Laplacian-smooth open boundary loops (e.g. the hood face opening)."""
    import bmesh as _bm
    bm = _bm.new()
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
    """Armor read: pull breast volume down on the jacket shell."""
    for v in o.data.vertices:
        if v.co.y > 0.045 and 1.16 < v.co.z < 1.42 and abs(v.co.x) < 0.16:
            v.co.y = 0.045 + (v.co.y - 0.045) * 0.35
    o.data.update()


def build(agent_key):
    spec = AGENTS[agent_key]
    pal = spec["palette"]
    # fresh rebuild: remove previous outputs
    coll = bpy.data.collections.get(f"agent_{agent_key}")
    if coll:
        for o in list(coll.objects):
            bpy.data.objects.remove(o, do_unlink=True)
    body = normalize_base(spec["height"], spec.get("head_scale", 1.0))
    labels, parts = label_faces(body.data)
    body.data.materials.clear()
    body.data.materials.append(mat(agent_key, "suit", pal["suit"]))
    made = [body]
    for g in spec["gear"]:
        m = mat(agent_key, g["mat"], pal[g["mat"]])
        s = shell(body, labels, g["region"], f"{agent_key}_{g['region']}",
                  g["offset"], g["thick"], m)
        if g["region"] in ("hood", "jacket", "gloves", "pants"):
            smooth_open_boundary(s)
        made.append(s)
    if agent_key == "zephyr":
        mats = {k: mat(agent_key, k, v) for k, v in pal.items()}
        made += addons_zephyr(mats)
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
