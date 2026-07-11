"""Join agent gear, decimate to budget, fit the 18-bone game rig, skin,
bake vertex AO, export GLB. Bone names match packages/client/src/playerModel.ts
(root, hips, spine, chest, neck, head, upper_arm/forearm/hand.{L,R},
thigh/shin/foot.{L,R}) so the client bone-driving code needs no changes.

v4: per-spec tri budgets, exact bbox-height normalization (the client scales
by the hardcoded AGENT_MODEL_HEIGHT, so the export is scaled to match it
exactly), Cycles AO baked into COLOR_0 (the client multiplies it in), and the
"recruit" spec exports as agent_placeholder.glb.

Live: import and call rig_and_export("zephyr").
Headless: blender --background --python tools/agentgen/rig_export.py -- --agent zephyr
"""
import math
import sys
from pathlib import Path

import bpy

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone/tools/agentgen")
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))
from specs import AGENTS  # noqa: E402

REPO = TOOLS.parents[1]
GLB_NAME = {"zephyr": "agent_zephyr.glb", "recruit": "agent_placeholder.glb"}

# joint positions measured on the normalized base (1.72 m, feet z=0)
BONES = [
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


def bake_vertex_ao(mesh, samples=10, lift=0.30):
    """Cycles AO -> COLOR_0 ("Col"), lifted so blacks stay readable."""
    import numpy as np
    me = mesh.data
    if "Col" in me.color_attributes:
        me.color_attributes.remove(me.color_attributes["Col"])
    me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
    me.color_attributes.active_color = me.color_attributes["Col"]
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    scn = bpy.context.scene
    prev = scn.render.engine
    scn.render.engine = "CYCLES"
    scn.cycles.samples = samples
    scn.render.bake.target = "VERTEX_COLORS"
    bpy.ops.object.bake(type="AO")
    scn.render.bake.target = "IMAGE_TEXTURES"
    scn.render.engine = prev
    col = me.color_attributes["Col"]
    buf = np.empty(len(col.data) * 4, dtype=np.float32)
    col.data.foreach_get("color", buf)
    buf = buf.reshape(-1, 4)
    buf[:, :3] = buf[:, :3] * (1 - lift) + lift
    col.data.foreach_set("color", buf.reshape(-1))
    me.update()


def _segment_weights(mesh, arm, top=2):
    """Gaussian falloff on point-to-bone-segment distance — smooth enough for
    the walk-cycle deltas the client applies, and it never fails."""
    import math as _m
    from mathutils import Vector as _V
    deform = [b for b in arm.data.bones if b.name != "root"]
    bones = []
    for b in deform:
        h, t = _V(b.head_local), _V(b.tail_local)
        sig = 0.09 if b.name in ("hips", "spine", "chest", "neck", "head") else 0.055
        bones.append((b.name, h, t, sig))
    for g in list(mesh.vertex_groups):
        mesh.vertex_groups.remove(g)
    groups = {n: mesh.vertex_groups.new(name=n) for n, *_ in bones}
    for v in mesh.data.vertices:
        ws = []
        for n, h, t, sig in bones:
            ab = t - h
            u = max(0.0, min(1.0, (v.co - h).dot(ab) / max(ab.length_squared, 1e-12)))
            d = (v.co - (h + ab * u)).length
            ws.append((_m.exp(-(d / sig) ** 2), n))
        ws.sort(reverse=True)
        sel = [(w, n) for w, n in ws[:top] if w > 1e-6] or [ws[0]]
        tot = sum(w for w, _ in sel)
        for w, n in sel:
            groups[n].add([v.index], w / tot, "REPLACE")


def rig_and_export(agent_key, bake_ao=True):
    spec = AGENTS[agent_key]
    coll = bpy.data.collections[f"agent_{agent_key}"]
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
    old = bpy.data.objects.get(f"{agent_key}_final")
    if old and old is not mesh:
        bpy.data.objects.remove(old, do_unlink=True)
    mesh.name = f"{agent_key}_final"

    # decimate to budget (preserves material assignments)
    budget = spec.get("tri_budget", 30000)
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    if tris > budget:
        md = mesh.modifiers.new("dec", "DECIMATE")
        md.ratio = budget / tris
        md.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier="dec")

    # exact height: client scales by its hardcoded AGENT_MODEL_HEIGHT
    want = spec.get("max_height")
    if want:
        zs = [v.co.z for v in mesh.data.vertices]
        h = max(zs)
        if abs(h - want) > 1e-4:
            f = want / h
            for v in mesh.data.vertices:
                v.co *= f
            mesh.data.update()

    if bake_ao:
        bake_vertex_ao(mesh)

    # armature
    old = bpy.data.objects.get(f"{agent_key}_rig_v4")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    arm_data = bpy.data.armatures.new(f"{agent_key}_rig_v4")
    arm = bpy.data.objects.new(f"{agent_key}_rig_v4", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones
    sc = (want / 1.76) if want else 1.0  # bones measured on ~1.76-top base
    for name, head, tail, parent, connect in BONES:
        b = eb.new(name)
        b.head = [c * sc for c in head]
        b.tail = [c * sc for c in tail]
        if parent:
            b.parent = eb[parent]
            b.use_connect = connect
    bpy.ops.object.mode_set(mode="OBJECT")

    # auto weights, with a deterministic nearest-segment fallback (heat can
    # fail on tightly layered gear — "Bone Heat Weighting: failed ...")
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_AUTO")
    has_arm_mod = any(md.type == "ARMATURE" for md in mesh.modifiers)
    weighted = sum(1 for v in mesh.data.vertices if v.groups) if mesh.vertex_groups else 0
    if not has_arm_mod or weighted < len(mesh.data.vertices) * 0.9:
        bpy.ops.object.select_all(action="DESELECT")
        mesh.select_set(True)
        arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_NAME")
        _segment_weights(mesh, arm)
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    if not mesh.vertex_groups:
        raise RuntimeError("weighting produced no vertex groups")
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_limit_total(limit=4)
    bpy.ops.object.vertex_group_normalize_all(lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    # no vertex may be unweighted (exporter would invent a neutral_bone)
    from mathutils import Vector as _V
    segs = [(mesh.vertex_groups.get(n), _V(h), _V(t))
            for n, h, t, p, c in [(b[0], b[1], b[2], b[3], b[4]) for b in BONES]
            if n != "root" and mesh.vertex_groups.get(n)]
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

    out = REPO / "assets/models" / GLB_NAME[agent_key]
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True,
                              export_vertex_color="ACTIVE")
    tris_final = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    return {"glb": str(out), "tris": tris_final,
            "size_kb": out.stat().st_size // 1024}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import build_agent
    build_agent.build(kv.get("--agent", "zephyr"))
    print(rig_and_export(kv.get("--agent", "zephyr")))
