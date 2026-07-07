"""Zephyr first-person viewmodel: arms mesh + 1-bone rig + three scripted
f-curve actions (equip / reload / inspect) with anticipation & overshoot.

Camera space: origin = camera, Blender -Y = view forward (exports to glTF -Z).
The client's procedural sway/bob/recoil (viewmodel.ts pure math) stays the
motion source of truth; these clips are authored alternatives it can adopt
via THREE.AnimationMixer without a refactor.

Live: import, call build_viewmodel(). Headless: --python this file.
"""
import math
import sys
from pathlib import Path

import bpy

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone")
FPS = 24


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


def build_viewmodel(mesh_name="viewmodel_zephyr"):
    mesh = bpy.data.objects[mesh_name]
    # 1-bone rig
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

    # actions
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
        # stash to NLA so the exporter writes every action as a clip
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, act)
        arm.animation_data.action = None
        return act

    # equip: rise from low-right with wrist flick, overshoot, settle (0.5 s)
    make("equip", [
        (1,  (0.06, 0.05, -0.30), (-38, 0, 12)),
        (7,  (0.005, -0.01, 0.03), (4, 0, -2)),
        (10, (0, 0, -0.008), (-1, 0, 0.5)),
        (12, (0, 0, 0), (0, 0, 0)),
    ])
    # reload: drop + roll out, mag work beat, sharp return with overshoot (1.7 s)
    make("reload", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (8,  (-0.01, 0.02, -0.09), (-20, 0, 14)),
        (16, (-0.012, 0.02, -0.10), (-22, 0, 15)),   # hold: mag out
        (22, (-0.008, 0.015, -0.085), (-16, 0, 10)),  # mag in bump
        (25, (-0.01, 0.02, -0.095), (-19, 0, 12)),
        (34, (0.004, -0.008, 0.018), (3, 0, -2)),     # overshoot
        (40, (0, 0, 0), (0, 0, 0)),
    ])
    # inspect: leisurely turn out, pause, roll back (2.5 s)
    make("inspect", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (14, (0.02, 0.06, 0.02), (6, -18, 24)),
        (28, (0.025, 0.07, 0.03), (10, -26, 32)),    # hold apex
        (40, (0.02, 0.05, 0.02), (5, -12, 20)),
        (52, (-0.003, -0.005, 0.012), (-2, 2, -3)),  # overshoot home
        (60, (0, 0, 0), (0, 0, 0)),
    ])

    out = REPO / "assets/models/viewmodel_zephyr.glb"
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True,
                              export_yup=True)
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    return {"glb": str(out), "tris": tris, "clips": ["equip", "reload", "inspect"]}


if __name__ == "__main__":
    print(build_viewmodel())
