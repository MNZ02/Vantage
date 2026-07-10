"""Zephyr first-person viewmodel, fully regenerable: arms mesh (tapered
forearms, cuffs, wraps, wind-glow) + curled-fist hands + 1-bone rig + three
scripted f-curve actions (equip / reload / inspect) with anticipation and
overshoot. No imported geometry — everything builds from this file.

Camera space: origin = camera, Blender +Y = view forward (exports to glTF -Z;
verified empirically by importing weapon_rifle.glb — its muzzle lands on +Y).
The arms are posed around the ACTUAL rifle at the client's weapon anchor
(viewmodel.ts: anchor (0.16, -0.13, -0.35) glTF = (0.16, 0.35, -0.13) here):
right fist wraps the pistol grip, left hand cradles the handguard. The
armsGroup offset in viewmodel.ts must be (0,0,0) — arms are authored in
final camera space.
The client's procedural sway/bob/recoil (viewmodel.ts pure math) stays the
motion source of truth; the clips are authored alternatives it can adopt via
THREE.AnimationMixer.

Live: import, call build_all(). Headless: blender --background --python <file>
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone")
FPS = 24

PAL = {
    "white": ("#EDF1F4", 0.05, 0.55),
    "teal":  ("#2FB7A8", 0.25, 0.50),
    "dark":  ("#1A1E26", 0.10, 0.80),
    "glow":  ("#5FF2DE", 0.0, 0.35, "#33E0CC"),
}

# ANCHOR SPACE: the client parents armsGroup to the weapon anchor, whose
# origin is the weapon grip (weapon glbs have their origin at the grip). So
# everything here is authored with the grip at (0,0,0); the camera sits at
# (-0.16, -0.35, +0.13) in this frame (inverse of the anchor position).
CAMERA_POS = (-0.16, -0.35, 0.13)

ARMS = {
    # right fist wraps the pistol grip (rifle grip ≈ (0, -0.11, -0.10));
    # fingers point across the grip (-X), knuckles face out-right/back
    "R": {"elbow": (0.18, -0.46, -0.34), "wrist": (0.06, -0.115, -0.085),
          "finger_dir": (-0.82, 0.10, -0.56), "knuckle_dir": (0.75, -0.35, 0.55),
          "side": 1},
    # left hand cradles the handguard from below (guard ≈ (0, +0.27, -0.03));
    # fingers wrap up-and-across (+X), knuckles face down-left
    "L": {"elbow": (-0.40, -0.42, -0.42), "wrist": (-0.055, 0.24, -0.10),
          "finger_dir": (0.85, 0.10, 0.52), "knuckle_dir": (-0.60, -0.15, 0.78),
          "side": -1},
}


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(key):
    name = f"vm_{key}"
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


def plate(name, dims, loc, rot, material, taper=None, taper_axis="y", bevel=0.0025, subsurf=0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    o = bpy.context.object
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(scale=True)
    if taper:
        tx, ty = taper
        for v in o.data.vertices:
            if getattr(v.co, taper_axis) > 0:  # taper the wrist (+y) end
                v.co.x *= tx
                if taper_axis == "y":
                    v.co.z *= ty
                else:
                    v.co.y *= ty
    if rot:
        o.rotation_euler = [math.radians(d) for d in rot]
    o.location = loc
    if bevel:
        md = o.modifiers.new("bv", "BEVEL")
        md.width = bevel
        md.segments = 2
        md.limit_method = "ANGLE"
        md.angle_limit = math.radians(40)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier="bv")
    if subsurf:
        md = o.modifiers.new("ss", "SUBSURF")
        md.levels = subsurf
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier="ss")
    o.data.materials.append(material)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(45))
    except Exception:
        pass
    return o


def _seg_rot(a, b):
    d = Vector(b) - Vector(a)
    rz = math.degrees(math.atan2(-d.x, d.y))
    rx = math.degrees(math.atan2(d.z, math.hypot(d.x, d.y)))
    return (rx, 0, rz), d.length


def _lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


def build_fist(side_key, parts_out, scale=1.15, roll_deg=0.0):
    """Organic fist: the sculpted hand region is extracted from the CC0 base
    body (via build_agent's normalize + fist-strength finger curl), oriented
    from its hanging-arm frame onto the viewmodel wrist, with a glove
    material and a teal knuckle plate."""
    from mathutils import Matrix
    import build_agent  # committed sibling module

    cfg = ARMS[side_key]
    s = cfg["side"]
    b = -s  # FP right arm uses the BODY's right hand (body x < 0), and vice versa
    body = build_agent.normalize_base(1.72, 0.93, curl=False)  # curl locally below

    # extract hand + wrist stub
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(body.data)
    keep = [f for f in bm.faces
            if 0.66 < f.calc_center_median().z < 1.01
            and f.calc_center_median().x * b > 0.20]
    keep_set = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in keep_set], context="FACES")
    me = bpy.data.meshes.new(f"vmh_hand.{side_key}")
    bm.to_mesh(me)
    bm.free()
    hand = bpy.data.objects.new(f"vmh_hand.{side_key}", me)
    bpy.context.scene.collection.objects.link(hand)
    me.materials.append(mat("dark"))
    # gloved look: shorten the slender base-mesh fingers before curling
    for v in me.vertices:
        if v.co.z < 0.85 and v.co.y <= 0.03:
            v.co.z = 0.85 + (v.co.z - 0.85) * 0.74
    # hand-local multi-joint fist curl (fingers only; thumb sits at y > 0.03)
    px = 0.30 * b
    for z_k, deg, run in ((0.85, 60, 0.08), (0.82, 60, 0.055), (0.795, 55, 0.04)):
        for v in me.vertices:
            x, y, z = v.co
            if z > z_k or y > 0.03:
                continue
            t = min(1.0, (z_k - z) / run)
            ang = math.radians(deg) * t
            c_, s_ = math.cos(ang), math.sin(ang)
            dx, dz = x - px, z - z_k
            v.co.x = px + (dx * c_ + dz * s_ * b)
            v.co.z = z_k + (-dx * s_ * b + dz * c_)
    me.update()
    bpy.ops.object.select_all(action="DESELECT")
    hand.select_set(True)
    bpy.context.view_layer.objects.active = hand
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(60))
    except Exception:
        bpy.ops.object.shade_smooth()

    # explicit frame mapping, hanging-arm space -> viewmodel wrist space.
    # src (body): fingers point down (-Z); knuckles face laterally (b, 0, 0).
    # dst (FP): fingers continue along the arm; knuckles face up-and-outward.
    def basis(K, Z):
        K = (K - K.dot(Z) * Z).normalized()
        Y = Z.cross(K)
        M = Matrix.Identity(4)
        M.col[0][:3], M.col[1][:3], M.col[2][:3] = K, Y, Z
        return M

    Z_src = Vector((0, 0, -1))
    K_src = Vector((b, 0, 0))
    arm_dir = (Vector(cfg["wrist"]) - Vector(cfg["elbow"])).normalized()
    Z_dst = Vector(cfg["finger_dir"]).normalized()
    K_dst = Vector(cfg["knuckle_dir"]).normalized()
    R = basis(K_dst, Z_dst) @ basis(K_src, Z_src).inverted()
    roll = Matrix.Rotation(math.radians(roll_deg), 4, Z_dst)
    src_wrist = Vector((0.275 * b, -0.03, 0.95))
    xf = (Matrix.Translation(Vector(cfg["wrist"]) - arm_dir * 0.03) @ roll @ R
          @ Matrix.Scale(scale, 4) @ Matrix.Translation(-src_wrist))
    hand.matrix_world = xf @ hand.matrix_world
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    parts_out.append(hand)

    # knuckle plate: authored in src space on the back of the hand, then
    # pushed through the same transform so it always rides the fist
    kp = plate(f"vmh_knuckle.{side_key}", (0.016, 0.048, 0.032),
               (0.322 * b, -0.028, 0.865), (0, 0, 0), mat("teal"), bevel=0.002)
    kp.matrix_world = xf @ kp.matrix_world
    parts_out.append(kp)
    bpy.data.objects.remove(body, do_unlink=True)


def build_arms_mesh():
    old = bpy.data.objects.get("viewmodel_zephyr")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    parts = []
    for k, cfg in ARMS.items():
        rot, L = _seg_rot(cfg["elbow"], cfg["wrist"])
        mid = _lerp(cfg["elbow"], cfg["wrist"], 0.5)
        # subsurf rounds the slab into a soft tapered sleeve (dims compensated
        # for Catmull-Clark shrink)
        parts.append(plate(f"forearm.{k}", (0.105, L * 1.1, 0.105), mid, rot, mat("white"),
                           taper=(0.88, 0.88), bevel=0, subsurf=2))
        parts.append(plate(f"cuff.{k}", (0.098, 0.055, 0.098),
                           _lerp(cfg["elbow"], cfg["wrist"], 0.08), rot, mat("teal"), bevel=0.005))
        parts.append(plate(f"wrap1.{k}", (0.084, 0.02, 0.084),
                           _lerp(cfg["elbow"], cfg["wrist"], 0.45), rot, mat("dark"), bevel=0.002))
        parts.append(plate(f"wrap2.{k}", (0.078, 0.02, 0.078),
                           _lerp(cfg["elbow"], cfg["wrist"], 0.62), rot, mat("dark"), bevel=0.002))
        wl = _lerp(cfg["elbow"], cfg["wrist"], 0.52)
        parts.append(plate(f"windline.{k}", (0.006, L * 0.22, 0.012),
                           (wl[0], wl[1], wl[2] + 0.040), rot, mat("glow"), bevel=0.001))
        build_fist(k, parts)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = "viewmodel_zephyr"
    return o


# ---------------- rig + actions
def _key(pb, frame, loc=None, rot=None):
    if loc is not None:
        pb.location = loc
        pb.keyframe_insert("location", frame=frame)
    if rot is not None:
        pb.rotation_euler = [math.radians(d) for d in rot]
        pb.keyframe_insert("rotation_euler", frame=frame)


def _fcurves(action):
    if hasattr(action, "fcurves"):  # Blender ≤4.x
        return list(action.fcurves)
    fcs = []  # Blender 5.x slotted actions
    for layer in action.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                fcs.extend(cb.fcurves)
    return fcs


def _ease(action, style="BEZIER"):
    for fc in _fcurves(action):
        for kp in fc.keyframe_points:
            kp.interpolation = style
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"


def rig_and_animate(mesh):
    old = bpy.data.objects.get("vm_rig")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    arm_data = bpy.data.armatures.new("vm_rig")
    arm = bpy.data.objects.new("vm_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    b = arm_data.edit_bones.new("vm_root")
    b.head, b.tail = (0, 0, -0.2), (0, -0.25, -0.2)
    bpy.ops.object.mode_set(mode="OBJECT")

    vg = mesh.vertex_groups.get("vm_root") or mesh.vertex_groups.new(name="vm_root")
    vg.add(range(len(mesh.data.vertices)), 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE")

    bpy.context.scene.render.fps = FPS
    arm.animation_data_create()
    pb = arm.pose.bones["vm_root"]
    pb.rotation_mode = "XYZ"

    def make(name, keys):
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        for frame, loc, rot in keys:
            _key(pb, frame, loc, rot)
        _ease(act)
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, act)
        arm.animation_data.action = None

    make("equip", [
        (1,  (0.06, -0.05, -0.30), (-38, 0, 12)),
        (7,  (0.005, 0.01, 0.03), (4, 0, -2)),
        (10, (0, 0, -0.008), (-1, 0, 0.5)),
        (12, (0, 0, 0), (0, 0, 0)),
    ])
    make("reload", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (8,  (-0.01, -0.02, -0.09), (-20, 0, 14)),
        (16, (-0.012, -0.02, -0.10), (-22, 0, 15)),
        (22, (-0.008, -0.015, -0.085), (-16, 0, 10)),
        (25, (-0.01, -0.02, -0.095), (-19, 0, 12)),
        (34, (0.004, 0.008, 0.018), (3, 0, -2)),
        (40, (0, 0, 0), (0, 0, 0)),
    ])
    make("inspect", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (14, (0.02, -0.06, 0.02), (6, -18, 24)),
        (28, (0.025, -0.07, 0.03), (10, -26, 32)),
        (40, (0.02, -0.05, 0.02), (5, -12, 20)),
        (52, (-0.003, 0.005, 0.012), (-2, 2, -3)),
        (60, (0, 0, 0), (0, 0, 0)),
    ])
    return arm


def build_all():
    mesh = build_arms_mesh()
    arm = rig_and_animate(mesh)
    out = REPO / "assets/models/viewmodel_zephyr.glb"
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True)
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    return {"glb": str(out), "tris": tris, "clips": ["equip", "reload", "inspect"]}


if __name__ == "__main__":
    print(build_all())
