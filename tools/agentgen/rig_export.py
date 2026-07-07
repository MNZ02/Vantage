"""Join agent gear, decimate to budget, fit the 18-bone game rig, auto-skin,
export GLB. Bone names match packages/client/src/playerModel.ts (same skeleton
as the earlier placeholder assets, so the client code needs no changes):
root, hips, spine, chest, neck, head, upper_arm/forearm/hand.{L,R},
thigh/shin/foot.{L,R}.

Live: import and call rig_and_export("zephyr").
Headless: blender --background --python tools/agentgen/rig_export.py -- --agent zephyr
"""
import math
import sys
from pathlib import Path

import bpy

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone")
TRI_BUDGET = 15000

# joint positions measured on the normalized base (1.72 m, feet z=0)
BONES = [
    # name, head, tail, parent, connect
    ("root", (0, 0, 0), (0, 0.25, 0), None, False),
    ("hips", (0, 0, 0.98), (0, 0, 1.09), "root", False),
    ("spine", (0, 0, 1.09), (0, 0, 1.28), "hips", True),
    ("chest", (0, 0, 1.28), (0, 0, 1.46), "spine", True),
    ("neck", (0, 0, 1.46), (0, 0, 1.53), "chest", True),
    ("head", (0, 0, 1.53), (0, 0, 1.76), "neck", True),
]
for s, x in (("L", 1), ("R", -1)):
    BONES += [
        (f"upper_arm.{s}", (x * 0.17, -0.01, 1.42), (x * 0.26, -0.02, 1.14), "chest", False),
        (f"forearm.{s}", (x * 0.26, -0.02, 1.14), (x * 0.315, -0.035, 0.93), f"upper_arm.{s}", True),
        (f"hand.{s}", (x * 0.315, -0.035, 0.93), (x * 0.345, -0.04, 0.80), f"forearm.{s}", True),
        (f"thigh.{s}", (x * 0.085, 0, 0.96), (x * 0.095, 0.005, 0.53), "hips", False),
        (f"shin.{s}", (x * 0.095, 0.005, 0.53), (x * 0.10, -0.01, 0.12), f"thigh.{s}", True),
        (f"foot.{s}", (x * 0.10, -0.01, 0.12), (x * 0.10, 0.16, 0.03), f"shin.{s}", True),
    ]


def rig_and_export(agent_key):
    coll = bpy.data.collections[f"agent_{agent_key}"]
    # duplicate + join gear meshes (originals stay for future critique passes)
    dups = []
    bpy.ops.object.select_all(action="DESELECT")
    for o in coll.objects:
        if o.type != "MESH":
            continue
        d = o.copy()
        d.data = o.data.copy()
        bpy.context.scene.collection.objects.link(d)
        d.select_set(True)
        dups.append(d)
    bpy.context.view_layer.objects.active = dups[0]
    bpy.ops.object.join()
    mesh = bpy.context.object
    mesh.name = f"{agent_key}_final"

    # decimate to budget (preserves material assignments)
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    if tris > TRI_BUDGET:
        md = mesh.modifiers.new("dec", "DECIMATE")
        md.ratio = TRI_BUDGET / tris
        md.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="dec")

    # armature
    old = bpy.data.objects.get(f"{agent_key}_rig_v3")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    arm_data = bpy.data.armatures.new(f"{agent_key}_rig_v3")
    arm = bpy.data.objects.new(f"{agent_key}_rig_v3", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    for name, head, tail, parent, connect in BONES:
        b = eb.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
    bpy.ops.object.mode_set(mode="OBJECT")

    # auto weights + cleanup
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh.data.validate()

    out = REPO / "assets/models" / f"agent_{agent_key}.glb"
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True)
    tris_final = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    return {"glb": str(out), "tris": tris_final,
            "size_kb": out.stat().st_size // 1024}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    # headless path: build first, then rig
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_agent
    build_agent.build(kv.get("--agent", "zephyr"))
    print(rig_and_export(kv.get("--agent", "zephyr")))
