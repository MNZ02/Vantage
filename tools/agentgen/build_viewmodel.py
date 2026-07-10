"""Zephyr first-person viewmodel, fully regenerable: arms mesh (tapered
forearms, cuffs, wraps, wind-glow) + curled-fist hands + 1-bone rig + three
scripted f-curve actions (equip / reload / inspect) with anticipation and
overshoot. No imported geometry — everything builds from this file.

Camera space: origin = camera, Blender -Y = view forward (exports to glTF -Z).
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

ARMS = {
    "R": {"elbow": (0.30, 0.10, -0.36), "wrist": (0.10, -0.42, -0.235),
          "hand_rot": (18, 0, -14), "side": 1},
    "L": {"elbow": (-0.28, 0.00, -0.34), "wrist": (-0.06, -0.60, -0.255),
          "hand_rot": (14, 0, 14), "side": -1},
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


def plate(name, dims, loc, rot, material, taper=None, taper_axis="y", bevel=0.0025):
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


def build_fist(side_key, parts_out, scale=1.25):
    """Curled fist: palm, 4 two-segment fingers, wrapped thumb, knuckle plate.
    Built palm-forward (-Y), then scaled, oriented and placed at the wrist."""
    cfg = ARMS[side_key]
    s = cfg["side"]
    local = []
    local.append(plate(f"vmh_palm.{side_key}", (0.075, 0.085, 0.058), (0, 0, 0), None, mat("dark"), bevel=0.004))
    for i in range(4):
        x = (-0.026 + i * 0.0175) * s
        local.append(plate(f"vmh_prox{i}.{side_key}", (0.0155, 0.042, 0.019),
                           (x, -0.05, -0.006), (55, 0, 0), mat("dark")))
        local.append(plate(f"vmh_dist{i}.{side_key}", (0.0145, 0.038, 0.017),
                           (x, -0.061, -0.037), (115, 0, 0), mat("dark")))
    local.append(plate(f"vmh_thumb1.{side_key}", (0.017, 0.05, 0.019),
                       (0.042 * s, -0.016, -0.008), (35, 0, -55 * s), mat("dark")))
    local.append(plate(f"vmh_thumb2.{side_key}", (0.015, 0.038, 0.017),
                       (0.054 * s, -0.048, -0.022), (85, 0, -30 * s), mat("dark")))
    local.append(plate(f"vmh_knuckle.{side_key}", (0.058, 0.022, 0.028),
                       (0, -0.04, 0.033), (18, 0, 0), mat("teal"), bevel=0.002))
    # scale about origin, orient by the wrist euler, translate to the wrist —
    # nudged slightly along the arm so the palm overlaps the tapered wrist end
    from mathutils import Matrix
    e = Euler([math.radians(d) for d in cfg["hand_rot"]], "XYZ").to_matrix().to_4x4()
    d = (Vector(cfg["wrist"]) - Vector(cfg["elbow"])).normalized()
    t = Matrix.Translation(Vector(cfg["wrist"]) + d * 0.035)
    sc = Matrix.Scale(scale, 4)
    for o in local:
        o.matrix_world = t @ e @ sc @ o.matrix_world
    parts_out += local


def build_arms_mesh():
    old = bpy.data.objects.get("viewmodel_zephyr")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    parts = []
    for k, cfg in ARMS.items():
        rot, L = _seg_rot(cfg["elbow"], cfg["wrist"])
        mid = _lerp(cfg["elbow"], cfg["wrist"], 0.5)
        parts.append(plate(f"forearm.{k}", (0.082, L, 0.082), mid, rot, mat("white"),
                           taper=(0.75, 0.75)))
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
        (1,  (0.06, 0.05, -0.30), (-38, 0, 12)),
        (7,  (0.005, -0.01, 0.03), (4, 0, -2)),
        (10, (0, 0, -0.008), (-1, 0, 0.5)),
        (12, (0, 0, 0), (0, 0, 0)),
    ])
    make("reload", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (8,  (-0.01, 0.02, -0.09), (-20, 0, 14)),
        (16, (-0.012, 0.02, -0.10), (-22, 0, 15)),
        (22, (-0.008, 0.015, -0.085), (-16, 0, 10)),
        (25, (-0.01, 0.02, -0.095), (-19, 0, 12)),
        (34, (0.004, -0.008, 0.018), (3, 0, -2)),
        (40, (0, 0, 0), (0, 0, 0)),
    ])
    make("inspect", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (14, (0.02, 0.06, 0.02), (6, -18, 24)),
        (28, (0.025, 0.07, 0.03), (10, -26, 32)),
        (40, (0.02, 0.05, 0.02), (5, -12, 20)),
        (52, (-0.003, -0.005, 0.012), (-2, 2, -3)),
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
