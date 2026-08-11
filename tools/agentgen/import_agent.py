"""Fit an externally generated character GLB to the game's agent contract.

Generative image-to-3D (TRELLIS, Hunyuan3D, Tripo) hands you a dense static
mesh in arbitrary orientation with one baked-texture material. The client needs
something quite specific instead — see packages/client/src/playerModel.ts:

  * skinned to the 18-bone rig, with the exact bone names the runtime poses
    (root, hips, spine, chest, neck, head, upper_arm/forearm/hand.{L,R},
    thigh/shin/foot.{L,R}); the walk cycle is applied as bone deltas, so an
    unrigged mesh would slide around the map frozen in its A-pose
  * facing +Y in Blender, which export_yup turns into three.js -Z forward
  * feet on z=0 and an exact bbox height, since the client scales by a
    hardcoded AGENT_MODEL_HEIGHT
  * at least one material named in ACCENT_MATERIAL_NAMES, retinted per-frame to
    the ally/enemy colour. A generated mesh has a single textured material; if
    that were the accent, IFF would tint the entire body and destroy the
    costume, so dedicated flat accent geometry is added instead.

Joint placement: the spine and legs come from the proportions rig_export.py
already fits, but the arm chain is MEASURED off the mesh. Generated A-poses vary
by tens of degrees in arm angle, and a mispositioned elbow makes the walk cycle
rotate the forearm around a point outside the sleeve.

No AO bake here, unlike rig_export: these textures already have lighting baked
into albedo by the generator's back-projection, and the client multiplies COLOR_0
into base colour, so baking again double-darkens everything.

Headless:
  blender --background --factory-startup --python tools/agentgen/import_agent.py -- \
      --src <in.glb> --out agent_sonar.glb --prefix ag_sonar --height 1.8
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone/tools/agentgen")
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
REPO = TOOLS.parents[1]

# Spine/leg joints as a fraction of standing height. rig_export.py's ZEPHYR_BONES
# are authored in a 1.72 m space and scaled at export; expressing them as
# fractions here means this works for any target height.
H0 = 1.72
SPINE = [
    ("root", (0, 0, 0.0), (0, 0.25, 0.0), None, False),
    ("hips", (0, 0, 0.98), (0, 0, 1.09), "root", False),
    ("spine", (0, 0, 1.09), (0, 0, 1.28), "hips", True),
    ("chest", (0, 0, 1.28), (0, 0, 1.45), "spine", True),
    ("neck", (0, 0, 1.45), (0, 0, 1.52), "chest", True),
    ("head", (0, 0, 1.52), (0, 0, 1.72), "neck", True),
]
LEGS = [
    ("thigh", (0.085, 0, 0.96), (0.100, 0.005, 0.53), "hips", False),
    ("shin", (0.100, 0.005, 0.53), (0.108, -0.010, 0.13), "thigh", True),
    ("foot", (0.108, -0.010, 0.13), (0.108, 0.17, 0.04), "shin", True),
]
SHOULDER = (0.18, -0.005, 1.41)      # fraction-of-H0 space, mirrored per side


def _verts(mesh):
    return [v.co for v in mesh.data.vertices]


def import_and_join(src):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(src))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh in the source glb")
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.object
    # bake the world transform into the data for the same reason orient() does
    mesh.data.transform(mesh.matrix_world)
    mesh.matrix_world = Matrix.Identity(4)
    mesh.data.update()
    for o in new:
        if o is not mesh and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    return mesh


def decide_flip(src, reference):
    """Whether the source needs a 180 deg turn, decided by comparing it to a
    SHIPPED agent in glTF space.

    Not by inspecting the mesh in Blender. Two successive geometric heuristics
    (nose-vs-bbox, then toe-vs-ankle) both got this backwards and happily
    exported a character facing away from its own walk direction. Both files are
    glTF, so measuring both with one code path removes the guesswork: if the
    toes disagree with the reference's, turn it around."""
    ref = REPO / "assets/models" / reference
    if not ref.exists():
        return False
    mine, theirs = _glb_toe_axis(src), _glb_toe_axis(ref)
    return mine != theirs


def orient(mesh, flip=False):
    """Turn the character to face +Y, by transforming the mesh DATA.

    Not via bpy.ops.object.transform_apply: setting rotation_euler and calling
    that operator silently did nothing here (geometry came out byte-identical,
    object rotation back at zero) and the tool exported a back-to-front
    character while reporting a successful flip. Mesh.transform() has no
    context or selection dependency, so it cannot quietly no-op."""
    if flip:
        mesh.data.transform(Matrix.Rotation(math.pi, 4, "Z"))
        mesh.data.update()
    return flip


def decimate(mesh, budget):
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    if tris <= budget:
        return tris, tris
    md = mesh.modifiers.new("dec", "DECIMATE")
    md.ratio = budget / tris
    md.use_collapse_triangulate = True
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.modifier_apply(modifier="dec")
    return tris, sum(len(p.vertices) - 2 for p in mesh.data.polygons)


def normalize_height(mesh, want):
    zs = [v.co.z for v in mesh.data.vertices]
    lo, hi = min(zs), max(zs)
    s = want / (hi - lo)
    for v in mesh.data.vertices:
        v.co.x *= s
        v.co.y *= s
        v.co.z = (v.co.z - lo) * s
    mesh.data.update()
    return s


def retexture(mesh, prefix, max_px=1024):
    """Name the body material for the client, and cap texture resolution — a
    generated 2k albedo plus a 2k ORM map is most of a 12 MB glb."""
    names = []
    for i, slot in enumerate(mesh.data.materials):
        if slot is None:
            continue
        slot.name = f"{prefix}_body" if i == 0 else f"{prefix}_body{i}"
        names.append(slot.name)
        if not slot.use_nodes:
            continue
        for n in slot.node_tree.nodes:
            if n.type == "TEX_IMAGE" and n.image and max(n.image.size) > max_px:
                w, h = n.image.size
                k = max_px / max(w, h)
                n.image.scale(int(w * k), int(h * k))
    return names


def _mat(name, rgb, emissive=False):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Roughness"].default_value = 0.45
    if emissive:
        for n in ("Emission Color", "Emission"):
            if n in b.inputs:
                b.inputs[n].default_value = (*rgb, 1.0)
                break
        if "Emission Strength" in b.inputs:
            b.inputs["Emission Strength"].default_value = 0.8
    return m


def add_accents(mesh, prefix, height, front=1.0):
    """Mark IFF accent regions by REASSIGNING existing faces to accent
    materials, rather than adding plates.

    Added plates float: the chest is convex, so a flat band placed at the depth
    of the most forward vertex stands off the surface at its ends, and the
    first version of this left teal rectangles hovering in front of the sternum
    and outside both shoulders. Recolouring faces the mesh already has is flush
    by construction and adds no geometry.

    The body's own textured material can't be the accent — three.js multiplies
    material colour into the map, so retinting it would wash the entire costume
    ally-blue or enemy-red.

    orient() guarantees the character faces +Y, so chest normals point +Y and
    `front` is +1; the parameter exists only to make that assumption explicit.
    """
    me = mesh.data
    accent = _mat(f"{prefix}_accent", (0.18, 0.72, 0.66))
    glow = _mat(f"{prefix}_glow", (0.47, 0.95, 0.87), emissive=True)
    me.materials.append(accent)
    me.materials.append(glow)
    ai, gi = len(me.materials) - 2, len(me.materials) - 1

    # Kept deliberately small. A first pass at roughly twice these bounds
    # covered the whole upper chest and both shoulder caps and read as a teal
    # bib over the costume rather than an insignia. Region edges follow the
    # decimated triangulation, so at 35k tris on a 1.8 m figure a boundary is
    # stair-stepped at ~2 cm — invisible at the 10-50 m the agent is actually
    # seen from, but another reason not to let the patches sprawl.
    n_acc = n_glow = 0
    for p in me.polygons:
        c = sum((me.vertices[i].co for i in p.vertices), Vector()) / len(p.vertices)
        n = p.normal
        zf = c.z / height
        facing = n.y * front
        # chest chevron
        if 0.765 <= zf <= 0.800 and abs(c.x) < height * 0.045 and facing > 0.3:
            p.material_index = ai
            n_acc += 1
        # sternum strip, emissive
        elif 0.700 <= zf < 0.765 and abs(c.x) < height * 0.010 and facing > 0.25:
            p.material_index = gi
            n_glow += 1
        # shoulder stripes: the outer top of each pauldron only
        elif 0.825 <= zf <= 0.865 and abs(c.x) > height * 0.115 and n.z > 0.5:
            p.material_index = ai
            n_acc += 1
    me.update()
    return [accent.name, glow.name], n_acc, n_glow


def build_rig(mesh, name, height):
    """18-bone rig: spine/legs by proportion, arm chain measured off the mesh."""
    sc = height / H0
    co = _verts(mesh)
    bones = [(n, tuple(v * sc for v in h), tuple(v * sc for v in t), p, c)
             for n, h, t, p, c in SPINE]
    for side, sx in (("L", 1), ("R", -1)):
        for n, h, t, p, c in LEGS:
            bones.append((f"{n}.{side}",
                          (h[0] * sx * sc, h[1] * sc, h[2] * sc),
                          (t[0] * sx * sc, t[1] * sc, t[2] * sc),
                          "hips" if p == "hips" else f"{p}.{side}", c))
    # measured arm chain: shoulder -> actual fingertip
    for side, sx in (("L", 1), ("R", -1)):
        sh = Vector((SHOULDER[0] * sx * sc, SHOULDER[1] * sc, SHOULDER[2] * sc))
        cand = [c for c in co if (c.x * sx) > 0]
        tip = max(cand, key=lambda c: c.x * sx) if cand else None
        if tip is None:
            tip = Vector((sx * height * 0.24, 0, height * 0.44))
        tip = Vector((tip.x, tip.y, tip.z))
        for n, a, b, parent in (("upper_arm", 0.00, 0.42, "chest"),
                                ("forearm", 0.42, 0.76, "upper_arm"),
                                ("hand", 0.76, 1.00, "forearm")):
            bones.append((f"{n}.{side}",
                          tuple(sh.lerp(tip, a)), tuple(sh.lerp(tip, b)),
                          parent if parent == "chest" else f"{parent}.{side}",
                          n != "upper_arm"))
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    arm_data = bpy.data.armatures.new(name)
    arm = bpy.data.objects.new(name, arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    for n, h, t, p, c in bones:
        b = eb.new(n)
        b.head, b.tail = h, t
        if p:
            b.parent = eb[p]
            b.use_connect = c
    bpy.ops.object.mode_set(mode="OBJECT")
    return arm, bones


def skin(mesh, arm, bones):
    from rig_export import _segment_weights
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_NAME")
    _segment_weights(mesh, arm)
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # any unweighted vertex makes the exporter invent a neutral_bone
    segs = [(mesh.vertex_groups.get(n), Vector(h), Vector(t))
            for n, h, t, p, c in bones if n != "root" and mesh.vertex_groups.get(n)]
    filled = 0
    for v in mesh.data.vertices:
        if not v.groups or sum(g.weight for g in v.groups) < 1e-5:
            best, bd = None, 9e9
            for vg, h, t in segs:
                ab = t - h
                u = max(0.0, min(1.0, (v.co - h).dot(ab) / max(ab.length_squared, 1e-12)))
                d = (v.co - (h + ab * u)).length_squared
                if d < bd:
                    bd, best = d, vg
            best.add([v.index], 1.0, "REPLACE")
            filled += 1
    mesh.data.validate()
    return filled


def _glb_toe_axis(path):
    """Which way the toes point in raw glTF space (Y-up): '-Z' or '+Z'.

    Reads the written file rather than trusting the in-Blender orientation, and
    applies node transforms — the exporter writes the object's origin as a node
    translation, so raw accessor values alone can be offset."""
    import json
    import struct

    import numpy as np
    raw = Path(path).read_bytes()
    jl = struct.unpack("<I", raw[12:16])[0]
    g = json.loads(raw[20:20 + jl])
    base = 20 + jl + 8
    comp = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}
    world = {}

    def nmat(n):
        if "matrix" in n:
            return np.array(n["matrix"], dtype=np.float64).reshape(4, 4).T
        m = np.eye(4)
        if "scale" in n:
            m = np.diag(list(n["scale"]) + [1.0]) @ m
        if "rotation" in n:
            x, y, z, w = n["rotation"]
            m = np.array([
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                [0, 0, 0, 1]]) @ m
        if "translation" in n:
            t = np.eye(4)
            t[:3, 3] = n["translation"]
            m = t @ m
        return m

    def walk(i, par):
        n = g["nodes"][i]
        m = par @ nmat(n)
        if "mesh" in n:
            world.setdefault(n["mesh"], []).append(m)
        for c in n.get("children", ()):
            walk(c, m)

    for r in g["scenes"][g.get("scene", 0)].get("nodes", ()):
        walk(r, np.eye(4))
    pts = []
    for mi, mesh in enumerate(g["meshes"]):
        for pr in mesh["primitives"]:
            a = g["accessors"][pr["attributes"]["POSITION"]]
            v = g["bufferViews"][a["bufferView"]]
            off = base + v.get("byteOffset", 0) + a.get("byteOffset", 0)
            arr = np.frombuffer(raw, dtype=np.dtype("<" + comp[a["componentType"]]),
                               count=a["count"] * 3, offset=off).reshape(-1, 3).astype(float)
            for m in world.get(mi, [np.eye(4)]):
                pts.append(arr @ m[:3, :3].T + m[:3, 3])
    P = np.concatenate(pts)
    lo, hi = P.min(axis=0), P.max(axis=0)
    h = hi[1] - lo[1]
    ank = P[(P[:, 1] > lo[1] + h * 0.09) & (P[:, 1] < lo[1] + h * 0.16)]
    foot = P[P[:, 1] < lo[1] + h * 0.05]
    a = float(np.median(ank[:, 2])) if len(ank) else 0.0
    return "+Z" if abs(foot[:, 2].max() - a) >= abs(foot[:, 2].min() - a) else "-Z"


def build(src, out_name, prefix, height=1.8, budget=35000, flip=None, tex_px=1024,
          reference="agent_zephyr.glb"):
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    if flip is None:
        flip = decide_flip(src, reference)
    mesh = import_and_join(src)
    flipped = orient(mesh, flip)
    before, after = decimate(mesh, budget)
    scale = normalize_height(mesh, height)
    body_mats = retexture(mesh, prefix, tex_px)
    accent_mats, n_acc, n_glow = add_accents(mesh, prefix, height)
    mesh.name = f"{prefix}_final"
    arm, bones = build_rig(mesh, f"{prefix}_rig", height)
    filled = skin(mesh, arm, bones)

    out = REPO / "assets/models" / out_name
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True)

    # Verify facing against a SHIPPED agent rather than re-running the same
    # heuristic that decided the flip — that would be circular, and the first
    # version of this tool exported the character back-to-front while its own
    # detector was happy. What matters is agreeing with the asset the client
    # already poses correctly.
    ref = REPO / "assets/models" / reference
    mine = _glb_toe_axis(out)
    theirs = _glb_toe_axis(ref) if ref.exists() else None
    zs = [v.co.z for v in mesh.data.vertices]
    return {"glb": str(out), "kb": out.stat().st_size // 1024,
            "tris_in": before, "tris_out": after, "flipped": flipped,
            "height": round(max(zs) - min(zs), 4), "feet_z": round(min(zs), 5),
            "scale": round(scale, 4), "materials": body_mats + accent_mats,
            "accent_faces": n_acc, "glow_faces": n_glow,
            "backfilled_verts": filled, "bones": len(bones),
            "toes": mine, "toes_reference": theirs,
            "facing_ok": theirs is None or mine == theirs}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    print(build(kv["--src"], kv.get("--out", "agent_imported.glb"),
                kv.get("--prefix", "ag_imported"),
                float(kv.get("--height", 1.8)), int(kv.get("--budget", 35000)),
                None if "--flip" not in kv else kv["--flip"] == "1",
                int(kv.get("--tex", 1024))))
