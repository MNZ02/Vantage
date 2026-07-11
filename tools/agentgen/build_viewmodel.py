"""Zephyr first-person viewmodel v2 — real fingered hands.

Replaces the v1 mitten fists: appends the CC0 bundle's "Hand  - Realistic"
mesh (831 verts, clean quads), rigs each digit with a temp 3-bone chain
(landmarks measured from the mesh), auto-weights, poses a per-finger grip
(trigger finger indexed straight, support hand C-clamping the handguard),
freezes the pose, and dresses everything as gloves + sleeves.

Anchor space (same contract as v1, verified against the shipped client):
grip at origin, Blender +Y = view forward (glTF -Z), camera at
(-0.16, -0.35, +0.13), client FOV 90. Arms are authored around the ACTUAL
v3 rifle (tools/weapongen): pistol grip at (0,-0.095,-0.050) raked (0,-.34,-1),
handguard octagon r=0.030 centered (0, 0.315, 0.010).

Export rig: vm_root drives everything; vm_l_hand additionally drives the
left arm so the reload clip can slap the mag. Clips: equip / reload / inspect
(client AnimationMixer contract unchanged).

Live: import build_viewmodel; build_viewmodel.build_all()
"""
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

TOOLS = Path(__file__).resolve().parent if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone/tools/agentgen")
for p in (str(TOOLS), str(TOOLS.parent / "weapongen")):
    if p not in sys.path:
        sys.path.insert(0, p)
import build_weapons as W  # loft/plate/cyl/finalize helpers + studio render  # noqa: E402

REPO = TOOLS.parents[1]
VENDOR = REPO / "assets/blender/vendor/human-base-meshes-bundle-v1.4.1/human_base_meshes_bundle.blend"
HAND_SRC = "Hand  - Realistic"
FPS = 24
CAMERA_POS = (-0.16, -0.35, 0.13)

PAL = {
    "white": ("#EDF1F4", 0.05, 0.55),
    "teal":  ("#2FB7A8", 0.25, 0.50),
    "dark":  ("#1A1E26", 0.10, 0.80),
    "glove": ("#23272F", 0.08, 0.72),
    "strap": ("#3A414E", 0.45, 0.55),
    "glow":  ("#5FF2DE", 0.0, 0.35, "#33E0CC"),
}
GENERIC_PAL = {  # viewmodel_arms.glb (non-Zephyr agents)
    "white": ("#8E969F", 0.05, 0.65),
    "teal":  ("#5A646E", 0.20, 0.55),
    "dark":  ("#20242A", 0.10, 0.80),
    "glove": ("#2A2E35", 0.08, 0.75),
    "strap": ("#4A5058", 0.45, 0.55),
    "glow":  ("#9AA4AE", 0.0, 0.45),
}


def hex_rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [1.0]


def mat(key, palette=PAL, prefix=None):
    spec = palette[key]
    if prefix is None:
        prefix = "vm" if palette is PAL else "vmg"
    name = f"{prefix}_{key}"
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


# ---------------------------------------------------------- hand landmarks
# measured on HAND_SRC (left hand: fingers -Z, palm +Y, thumb +X, wrist +Z)
DIGITS = {
    # name: (mcp, tip) — pip/dip interpolated 0.42 / 0.72 along the chain
    "pinky":  ((-0.0450, 0.0035, -0.0960), (-0.0533, 0.0206, -0.1700)),
    "ring":   ((-0.0140, 0.0040, -0.0980), (-0.0115, 0.0206, -0.1980)),
    "middle": ((0.0140, 0.0040, -0.0985), (0.0183, 0.0138, -0.2090)),
    "index":  ((0.0380, 0.0035, -0.0975), (0.0290, 0.0155, -0.2010)),
}
THUMB = ((0.0380, 0.0150, -0.0400), (0.0620, 0.0220, -0.0750),
         (0.0800, 0.0230, -0.0940), (0.0960, 0.0220, -0.1120))
WRIST_LOCAL = Vector((0.0, 0.002, 0.015))  # placement reference point
PALM_BONE = ((0.0, 0.002, 0.010), (0.0, 0.004, -0.0960))
ROOT_BONE = ((0.0, 0.000, 0.0450), (0.0, 0.002, 0.0100))


def _hand_master(detail=1):
    """Append the bundle hand ONCE per session (re-appending the same library
    object aliases cached data evaluated in the bundle's showroom space) and
    bake its MULTIRES sculpt down to `detail` levels, re-centered."""
    m = bpy.data.objects.get("vmh_master")
    if m and len(m.data.vertices) > 800:
        return m
    for o in list(bpy.data.objects):
        if o.name == "vmh_master" or o.name.startswith(HAND_SRC):
            bpy.data.objects.remove(o, do_unlink=True)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    with bpy.data.libraries.load(str(VENDOR)) as (df, dt):
        dt.objects = [HAND_SRC]
    o = bpy.data.objects[HAND_SRC]
    o.name = "vmh_master"
    if o.name not in bpy.context.scene.collection.objects:
        try:
            bpy.context.scene.collection.objects.link(o)
        except RuntimeError:
            pass
    W._activate(o)
    base = [v.co.copy() for v in o.data.vertices]
    bmin = Vector((min(v[i] for v in base) for i in range(3)))
    bmax = Vector((max(v[i] for v in base) for i in range(3)))
    base_ctr = (bmin + bmax) / 2
    for md in list(o.modifiers):
        if md.type == "MULTIRES":
            md.levels = min(detail, md.total_levels)
            bpy.ops.object.modifier_apply(modifier=md.name)
        else:
            bpy.ops.object.modifier_remove(modifier=md.name)
    me = o.data
    amin = Vector((min(v.co[i] for v in me.vertices) for i in range(3)))
    amax = Vector((max(v.co[i] for v in me.vertices) for i in range(3)))
    off = (amin + amax) / 2 - base_ctr
    if off.length > 1e-4:
        for v in me.vertices:
            v.co -= off
        me.update()
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    o.hide_render = True
    o.hide_viewport = True
    return o


HAND_BBOX_CTR = Vector((0.0188, 0.0018, -0.0634))  # measured on the base cage


def _anchor_to_landmarks(o):
    """The bundle multires bake sometimes lands in showroom space; bbox size
    is identical either way, so snapping the bbox center onto the measured
    base-cage center restores the landmark frame. Idempotent."""
    me = o.data
    mn = [min(v.co[i] for v in me.vertices) for i in range(3)]
    mx = [max(v.co[i] for v in me.vertices) for i in range(3)]
    ctr = Vector(((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2))
    off = ctr - HAND_BBOX_CTR
    if off.length > 1e-4:
        for v in me.vertices:
            v.co -= off
        me.update()


def load_hand(tag, detail=1):
    old = bpy.data.objects.get(f"vmh_{tag}")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    master = _hand_master(detail)
    o = master.copy()
    o.data = master.data.copy()
    o.name = f"vmh_{tag}"
    o.hide_render = False
    o.hide_viewport = False
    bpy.context.scene.collection.objects.link(o)
    _anchor_to_landmarks(o)
    W._activate(o)
    return o


CURL_SIGN = 1.0  # flipped if auto-roll makes +X rotation extend instead of curl


def rig_hand(hand, mirrored):
    """Temp armature: root + palm + 4 finger chains + thumb chain, auto-weights
    on the bare skin, accents weighted by nearest bone afterwards."""
    s = -1.0 if mirrored else 1.0
    arm_data = bpy.data.armatures.new("vmh_rig")
    arm = bpy.data.objects.new("vmh_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    W._activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm_data.edit_bones

    def bone(name, head, tail, parent=None):
        b = eb.new(name)
        b.head = (head[0] * s, head[1], head[2])
        b.tail = (tail[0] * s, tail[1], tail[2])
        if parent:
            b.parent = eb[parent]
        return b

    bone("root", *ROOT_BONE)
    bone("palm", *PALM_BONE, parent="root")
    for name, (mcp, tip) in DIGITS.items():
        mcp_v, tip_v = Vector(mcp), Vector(tip)
        pip = mcp_v.lerp(tip_v, 0.42)
        dip = mcp_v.lerp(tip_v, 0.72)
        bone(f"{name}1", mcp_v, pip, parent="palm")
        bone(f"{name}2", pip, dip, parent=f"{name}1")
        bone(f"{name}3", dip, tip_v, parent=f"{name}2")
    t = [Vector(v) for v in THUMB]
    bone("thumb1", t[0], t[1], parent="palm")
    bone("thumb2", t[1], t[2], parent="thumb1")
    bone("thumb3", t[2], t[3], parent="thumb2")
    bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="DESELECT")
    hand.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE_NAME")  # weights computed below
    procedural_weights(hand, arm)
    return arm


# per-bone falloff radius (m): fingers tight, palm broad
BONE_SIGMA = {"root": 0.030, "palm": 0.024, "thumb1": 0.011, "thumb2": 0.008,
              "thumb3": 0.008}


def _seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(ab.length_squared, 1e-12)))
    return (p - (a + ab * t)).length


def procedural_weights(hand, arm):
    """Deterministic smooth skinning: gaussian falloff on point-to-bone-segment
    distance, top-3 influences, normalized. Heat weighting on this mesh is
    unreliable; rest-pose fingers are well separated so nearest-segment is
    clean and produces soft knuckle transitions."""
    me = hand.data
    bones = []
    for b in arm.data.bones:
        sig = BONE_SIGMA.get(b.name)
        if sig is None:
            sig = 0.0085 if any(b.name.startswith(d) for d in DIGITS) else 0.02
        bones.append((b.name, Vector(b.head_local), Vector(b.tail_local), sig))
    for g in list(hand.vertex_groups):
        hand.vertex_groups.remove(g)
    groups = {name: hand.vertex_groups.new(name=name) for name, *_ in bones}
    for v in me.vertices:
        ws = []
        for name, h, t, sig in bones:
            d = _seg_dist(v.co, h, t)
            ws.append((math.exp(-(d / sig) ** 2), name))
        ws.sort(reverse=True)
        top = [(w, n) for w, n in ws[:3] if w > 1e-5]
        if not top:
            top = [(1.0, min(bones, key=lambda bn: _seg_dist(v.co, bn[1], bn[2]))[0])]
        tot = sum(w for w, _ in top)
        for w, n in top:
            groups[n].add([v.index], w / tot, "REPLACE")


def weight_islands_to_nearest(hand, arm):
    """Accent islands (knuckle plate / strap / cuff, joined after the skin was
    heat-weighted): each connected island rides ONE bone — palm or root — so
    finger curls never tear the plates apart."""
    me = hand.data
    cand = [(b.name, (Vector(b.head_local) + Vector(b.tail_local)) / 2)
            for b in arm.data.bones if b.name in ("palm", "root")]
    vg = hand.vertex_groups
    unweighted = set()
    for v in me.vertices:
        if sum(g.weight for g in v.groups) < 1e-4:
            unweighted.add(v.index)
    if not unweighted:
        return 0
    # connected components within the unweighted set
    adj = {i: [] for i in unweighted}
    for e in me.edges:
        a, b = e.vertices
        if a in unweighted and b in unweighted:
            adj[a].append(b)
            adj[b].append(a)
    seen = set()
    for seed in list(unweighted):
        if seed in seen:
            continue
        stack, comp = [seed], []
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            comp.append(x)
            stack += adj[x]
        ctr = Vector((0, 0, 0))
        for vi in comp:
            ctr += me.vertices[vi].co
        ctr /= len(comp)
        best = min(cand, key=lambda bn: (ctr - bn[1]).length_squared)
        g = vg.get(best[0]) or vg.new(name=best[0])
        g.add(comp, 1.0, "REPLACE")
    return len(unweighted)


def pose_hand(hand, arm, curls, mirrored):
    """curls: {digit: (mcp, pip, dip)} degrees + optional 'splay' {digit: deg}
    and 'thumb': (cmc_bend, cmc_twist, mcp, ip). Applies pose into the mesh."""
    s = -1.0 if mirrored else 1.0
    W._activate(arm)
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    splay = curls.get("splay", {})
    k = CURL_SIGN
    for name in DIGITS:
        a1, a2, a3 = curls[name]
        arm.pose.bones[f"{name}1"].rotation_euler = (
            math.radians(a1) * k, 0, math.radians(splay.get(name, 0.0)) * s)
        arm.pose.bones[f"{name}2"].rotation_euler = (math.radians(a2) * k, 0, 0)
        arm.pose.bones[f"{name}3"].rotation_euler = (math.radians(a3) * k, 0, 0)
    cmc, twist, tm, ti = curls["thumb"]
    arm.pose.bones["thumb1"].rotation_euler = (
        math.radians(cmc) * k, math.radians(twist) * s, 0)
    arm.pose.bones["thumb2"].rotation_euler = (math.radians(tm) * k, 0, 0)
    arm.pose.bones["thumb3"].rotation_euler = (math.radians(ti) * k, 0, 0)
    bpy.ops.object.mode_set(mode="OBJECT")
    # freeze: apply armature modifier
    W._activate(hand)
    for md in list(hand.modifiers):
        if md.type == "ARMATURE":
            bpy.ops.object.modifier_apply(modifier=md.name)
    for g in list(hand.vertex_groups):
        hand.vertex_groups.remove(g)
    bpy.data.objects.remove(arm, do_unlink=True)
    return hand


def orient_hand(hand, wrist_world, finger_dir, palm_dir, scale=0.92):
    """Map hand-local (fingers -Z, palm +Y) onto the target frame."""
    Zl = -Vector(finger_dir).normalized()          # local +Z target
    Yl = Vector(palm_dir)
    Yl = (Yl - Zl * Yl.dot(Zl)).normalized()       # local +Y target
    Xl = Yl.cross(Zl)
    M = Matrix.Identity(4)
    M.col[0][:3], M.col[1][:3], M.col[2][:3] = Xl, Yl, Zl
    xf = (Matrix.Translation(Vector(wrist_world)) @ M
          @ Matrix.Scale(scale, 4) @ Matrix.Translation(-WRIST_LOCAL))
    hand.matrix_world = xf @ hand.matrix_world
    W._activate(hand)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return hand


def trim_forearm(hand, keep_below_z=0.052):
    """Drop the bundled forearm stub above the glove cuff (local space)."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(hand.data)
    kill = [v for v in bm.verts if v.co.z > keep_below_z]
    if len(kill) > len(bm.verts) * 0.3:
        bm.free()
        raise RuntimeError(
            f"trim_forearm would delete {len(kill)}/{len(bm.verts)} verts — "
            "hand mesh is not in landmark space")
    bmesh.ops.delete(bm, geom=kill, context="VERTS")
    bm.to_mesh(hand.data)
    bm.free()
    hand.data.update()


# ---------------------------------------------------------- grip configs
# One pose per weapon CLASS (the client swaps arms by weaponClassFor()):
#   rifle  — right fist on the raked grip, left C-clamps the v3 handguard
#            (weapon_rifle: grip (0,-0.095,-0.050) axis (0,-.34,-1), guard
#             octagon r=0.030 centered (0, 0.315, 0.010)). Also used for smg.
#   sniper — same hold, left wrist dropped to the deeper forend
#            (weapon_sniper chassis bottom ≈ -0.036 vs rifle guard -0.021).
#   pistol — two-handed: left palm cups the right hand at the grip.
#   knife  — one-handed: no left arm at all (vm_l_hand group stays empty).
_R_ON_GRIP = {
    "elbow": (0.17, -0.47, -0.38),
    "wrist": (0.060, -0.132, -0.104),
    "finger_dir": (-0.84, 0.18, -0.51),
    "palm_dir": (-0.70, 0.36, -0.62),
    "curls": {
        "pinky": (80, 90, 48), "ring": (76, 88, 46), "middle": (68, 84, 42),
        "index": (14, 12, 8),
        "splay": {"index": -6, "pinky": 5},
        "thumb": (16, 30, 16, 10),
    },
}
_L_ON_GUARD = {
    "elbow": (-0.40, -0.40, -0.36),
    "wrist": (-0.068, 0.300, -0.055),
    "finger_dir": (0.88, 0.08, 0.47),
    "palm_dir": (0.12, 0.10, 0.99),
    "curls": {
        "pinky": (64, 76, 40), "ring": (62, 74, 38), "middle": (58, 70, 34),
        "index": (48, 58, 28),
        "splay": {"index": 2, "pinky": -5},
        "thumb": (10, -35, 10, 8),
    },
}
POSES = {
    "rifle": {"R": _R_ON_GRIP, "L": _L_ON_GUARD},
    "sniper": {"R": _R_ON_GRIP,
               "L": {**_L_ON_GUARD, "wrist": (-0.068, 0.315, -0.075),
                     "elbow": (-0.40, -0.40, -0.38),
                     "curls": {
                         "pinky": (58, 68, 36), "ring": (56, 66, 34),
                         "middle": (52, 60, 30), "index": (44, 52, 24),
                         "splay": {"index": 2, "pinky": -5},
                         "thumb": (10, -35, 10, 8),
                     }}},
    "pistol": {
        # tighter fist for the slimmer grip; index rests on the guard front
        "R": {**_R_ON_GRIP, "curls": {
            "pinky": (86, 96, 52), "ring": (82, 94, 50), "middle": (74, 90, 46),
            "index": (22, 20, 10),
            "splay": {"index": -6, "pinky": 5},
            "thumb": (16, 30, 16, 10),
        }},
        # support hand cups from the left flank: palm pressing the grip and
        # the right-hand fingers, left fingers overlaying them up-across
        "L": {
            "elbow": (-0.34, -0.44, -0.36),
            "wrist": (-0.058, -0.052, -0.122),
            "finger_dir": (0.78, 0.26, 0.57),
            "palm_dir": (0.60, 0.22, 0.77),
            "curls": {
                "pinky": (58, 68, 36), "ring": (56, 66, 34), "middle": (50, 58, 28),
                "index": (46, 56, 28),
                "splay": {"index": 4, "pinky": -4},
                "thumb": (-6, -28, 10, 8),
            },
        },
    },
    "knife": {
        # hammer grip on the horizontal handle (axis ≈ (0,-1,-0.1), girth
        # r≈0.013 with wraps; handle spans y -0.006..-0.135 at z≈0.005)
        "R": {
            "elbow": (0.19, -0.47, -0.34),
            "wrist": (0.058, -0.128, -0.020),
            "finger_dir": (-0.86, -0.06, -0.50),
            "palm_dir": (-0.48, -0.10, -0.87),
            "curls": {
                "pinky": (84, 92, 50), "ring": (82, 92, 48), "middle": (76, 88, 46),
                "index": (66, 80, 40),
                "splay": {"index": -3, "pinky": 4},
                "thumb": (18, 34, 20, 12),
            },
        },
        "L": None,
    },
}


def build_hand(side, palette, cfg):
    mirrored = side == "R"
    hand = load_hand(side)
    if mirrored:
        hand.scale = (-1, 1, 1)
        W._activate(hand)
        bpy.ops.object.transform_apply(scale=True)
        hand.data.flip_normals()
    trim_forearm(hand)
    hand.data.materials.clear()
    hand.data.materials.append(mat("glove", palette))
    arm = rig_hand(hand, mirrored)
    add_glove_gear_post(hand, arm, palette, mirrored)
    pose_hand(hand, arm, cfg["curls"], mirrored)
    orient_hand(hand, cfg["wrist"], cfg["finger_dir"], cfg["palm_dir"])
    W._smooth(hand, 62)
    return hand


def add_glove_gear_post(hand, arm, palette, mirrored):
    """Join accents after auto-weights, then weight them to nearest bones."""
    s = -1.0 if mirrored else 1.0
    gear = [
        W.plate("knuckle", (0.050, 0.009, 0.032), (-0.004 * s, -0.0170, -0.076),
                mat("teal", palette), rot=(8, 0, 0), bevel_w=0.002),
        W.plate("strap", (0.056, 0.006, 0.013), (-0.002 * s, -0.0145, -0.046),
                mat("strap", palette), rot=(6, 0, 0), bevel_w=0.0012),
    ]
    bpy.ops.mesh.primitive_torus_add(major_radius=0.036, minor_radius=0.011,
                                     major_segments=22, minor_segments=10,
                                     location=(0.002 * s, 0.003, 0.034))
    cuff = bpy.context.object
    cuff.name = "glovecuff"
    cuff.scale = (1.0, 0.85, 1.15)
    bpy.ops.object.transform_apply(scale=True)
    cuff.data.materials.append(mat("dark", palette))
    bpy.ops.object.shade_smooth()
    gear.append(cuff)
    W._activate(hand)
    for g in gear:
        g.select_set(True)
    bpy.ops.object.join()
    n = weight_islands_to_nearest(hand, arm)
    return n


def build_sleeve(side, palette, cfg):
    """Sleeve lofted straight along +Y, then rotated onto the elbow->wrist
    axis (the loft helper only tilts about X, arms run diagonally)."""
    e, w = Vector(cfg["elbow"]), Vector(cfg["wrist"])
    d = (w - e).normalized()
    L = (w - e).length
    q = d.to_track_quat("Z", "Y")  # loft rings live in the XY plane (⊥ Z)

    def ring(t, hw, hd):
        return ((0.0, 0.0, t * L), hw, hd, 0.0)

    def place(o):
        o.rotation_euler = q.to_euler()
        o.location = e
        W._activate(o)
        bpy.ops.object.transform_apply(location=True, rotation=True)
        return o

    parts = []
    parts.append(place(W.loft(f"sleeve.{side}", [
        ring(0.00, 0.058, 0.062), ring(0.22, 0.054, 0.058), ring(0.48, 0.048, 0.051),
        ring(0.68, 0.042, 0.045), ring(0.84, 0.037, 0.039), ring(0.97, 0.032, 0.033),
    ], mat("white", palette), ring=12, round_k=0.42, subsurf=1)))
    parts.append(place(W.loft(f"cuff.{side}", [
        ring(0.30, 0.0555, 0.059), ring(0.40, 0.0545, 0.058)],
        mat("teal", palette), ring=12, round_k=0.42, subsurf=1)))
    for i, t in enumerate((0.62, 0.76)):
        parts.append(place(W.loft(f"wrap{i}.{side}", [
            ring(t, 0.047 - i * 0.003, 0.050 - i * 0.003),
            ring(t + 0.055, 0.0465 - i * 0.003, 0.0495 - i * 0.003)],
            mat("dark", palette), ring=12, round_k=0.42, subsurf=1)))
    wl = e.lerp(w, 0.55)
    n_up = (q @ Vector((0, 0, 1))).normalized()
    wp = W.plate(f"windline.{side}", (0.006, L * 0.20, 0.012), (0, 0, 0),
                 mat("glow", palette), bevel_w=0.001)
    wp.rotation_euler = q.to_euler()
    wp.location = wl + n_up * 0.050
    W._activate(wp)
    bpy.ops.object.transform_apply(location=True, rotation=True)
    parts.append(wp)
    return parts


# ---------------------------------------------------------- rig + actions
def _fcurves(action):
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    fcs = []
    for layer in action.layers:
        for strip in layer.strips:
            for cb in strip.channelbags:
                fcs.extend(cb.fcurves)
    return fcs


def _ease(action):
    for fc in _fcurves(action):
        for kp in fc.keyframe_points:
            kp.interpolation = "BEZIER"
            kp.handle_left_type = kp.handle_right_type = "AUTO_CLAMPED"


# per-pose left-hand choreography for the reload clip (bone-local deltas)
RELOAD_L_KEYS = {
    "rifle": [
        (1,  (0, 0, 0), (0, 0, 0)),
        (6,  (0.03, -0.11, -0.05), (-16, 0, -8)),
        (12, (0.05, -0.22, -0.10), (-28, 0, -14)),
        (16, (0.06, -0.23, -0.11), (-30, 0, -14)),
        (19, (0.05, -0.21, -0.095), (-26, 0, -12)),
        (30, (0.02, -0.08, -0.035), (-9, 0, -5)),
        (38, (0, 0, 0), (0, 0, 0)),
    ],
    # pistol: support hand peels off, dips to meet the fresh mag, re-cups
    "pistol": [
        (1,  (0, 0, 0), (0, 0, 0)),
        (7,  (-0.03, -0.05, -0.09), (-22, 0, 10)),
        (14, (-0.04, -0.03, -0.13), (-30, 0, 14)),
        (20, (-0.035, -0.02, -0.11), (-26, 0, 12)),
        (32, (-0.01, -0.005, -0.03), (-8, 0, 4)),
        (38, (0, 0, 0), (0, 0, 0)),
    ],
    "knife": [],
}
RELOAD_L_KEYS["sniper"] = RELOAD_L_KEYS["rifle"]

INSPECT_L_KEYS = {
    "rifle": [
        (1, (0, 0, 0), (0, 0, 0)),
        (20, (0.01, -0.05, 0.02), (-6, 0, -4)),
        (44, (0.005, -0.02, 0.01), (-3, 0, -2)),
        (60, (0, 0, 0), (0, 0, 0)),
    ],
    "knife": [],
}
INSPECT_L_KEYS["sniper"] = INSPECT_L_KEYS["rifle"]
INSPECT_L_KEYS["pistol"] = INSPECT_L_KEYS["rifle"]


def rig_and_animate(mesh, left_verts, pose="rifle"):
    old = bpy.data.objects.get("vm_rig")
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    # purge stale clip datablocks — the exporter would ship every lingering
    # action (equip.001, ...) from previous rebuilds
    for act in list(bpy.data.actions):
        if act.name.split(".")[0] in ("equip", "reload", "inspect"):
            bpy.data.actions.remove(act)
    arm_data = bpy.data.armatures.new("vm_rig")
    arm = bpy.data.objects.new("vm_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    W._activate(arm)
    bpy.ops.object.mode_set(mode="EDIT")
    b = arm_data.edit_bones.new("vm_root")
    b.head, b.tail = (0, 0, -0.2), (0, -0.25, -0.2)
    lh = arm_data.edit_bones.new("vm_l_hand")
    lh.head, lh.tail = (-0.06, 0.10, -0.10), (-0.06, 0.32, -0.10)
    lh.parent = b
    bpy.ops.object.mode_set(mode="OBJECT")

    vg_root = mesh.vertex_groups.get("vm_root") or mesh.vertex_groups.new(name="vm_root")
    vg_l = mesh.vertex_groups.get("vm_l_hand") or mesh.vertex_groups.new(name="vm_l_hand")
    all_idx = list(range(len(mesh.data.vertices)))
    vg_root.add(all_idx, 1.0, "REPLACE")
    if left_verts:
        vg_root.remove(left_verts)
        vg_l.add(left_verts, 1.0, "REPLACE")
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type="ARMATURE")

    bpy.context.scene.render.fps = FPS
    arm.animation_data_create()
    root = arm.pose.bones["vm_root"]
    lhand = arm.pose.bones["vm_l_hand"]
    for pb in (root, lhand):
        pb.rotation_mode = "XYZ"

    def key(pb, frame, loc=None, rot=None):
        if loc is not None:
            pb.location = loc
            pb.keyframe_insert("location", frame=frame)
        if rot is not None:
            pb.rotation_euler = [math.radians(d) for d in rot]
            pb.keyframe_insert("rotation_euler", frame=frame)

    def make(name, keys_root, keys_l=()):
        act = bpy.data.actions.new(name)
        arm.animation_data.action = act
        for frame, loc, rot in keys_root:
            key(root, frame, loc, rot)
        for frame, loc, rot in keys_l:
            key(lhand, frame, loc, rot)
        _ease(act)
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, act)
        arm.animation_data.action = None

    make("equip", [
        (1,  (0.07, -0.06, -0.32), (-42, 0, 14)),
        (7,  (0.006, 0.012, 0.035), (5, 0, -2.5)),
        (10, (0, 0, -0.010), (-1.5, 0, 0.6)),
        (12, (0, 0, 0), (0, 0, 0)),
    ])
    # reload: gun tilts, LEFT hand works the mag (choreography per pose)
    make("reload", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (8,  (-0.012, -0.02, -0.06), (-14, 0, 12)),
        (26, (-0.014, -0.022, -0.07), (-17, 0, 14)),
        (34, (0.004, 0.008, 0.016), (3, 0, -2)),
        (40, (0, 0, 0), (0, 0, 0)),
    ], keys_l=RELOAD_L_KEYS.get(pose, RELOAD_L_KEYS["rifle"]))
    make("inspect", [
        (1,  (0, 0, 0), (0, 0, 0)),
        (14, (0.02, -0.06, 0.02), (7, -20, 26)),
        (28, (0.028, -0.075, 0.032), (11, -28, 34)),
        (40, (0.02, -0.05, 0.02), (5, -13, 21)),
        (52, (-0.003, 0.006, 0.012), (-2, 2, -3)),
        (60, (0, 0, 0), (0, 0, 0)),
    ], keys_l=INSPECT_L_KEYS.get(pose, INSPECT_L_KEYS["rifle"]))
    return arm


# ---------------------------------------------------------- assembly
def build_arms_mesh(palette=PAL, out_name="viewmodel_zephyr", pose="rifle"):
    old = bpy.data.objects.get(out_name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)
    cfgs = POSES[pose]
    parts = []
    left_parts = []
    for side in ("R", "L"):
        cfg = cfgs[side]
        if cfg is None:  # one-handed pose (knife): no left arm at all
            continue
        hand = build_hand(side, palette, cfg)
        sleeves = build_sleeve(side, palette, cfg)
        parts += [hand] + sleeves
        if side == "L":
            left_parts += [hand] + sleeves
    left_names = {o.name for o in left_parts}
    # tag left verts BEFORE join via a temp vertex group per object
    for o in parts:
        vg = o.vertex_groups.new(name="__left" if o.name in left_names else "__right")
        vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")
    W._activate(parts[0])
    for o in parts[1:]:
        o.select_set(True)
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = out_name
    left_idx = []
    lg = o.vertex_groups.get("__left")
    if lg:
        gi = lg.index
        for v in o.data.vertices:
            if any(g.group == gi for g in v.groups):
                left_idx.append(v.index)
    for gname in ("__left", "__right"):
        g = o.vertex_groups.get(gname)
        if g:
            o.vertex_groups.remove(g)
    return o, left_idx


def build_all(palette=PAL, out_file="viewmodel_zephyr.glb", out_name="viewmodel_zephyr",
              pose="rifle"):
    mesh, left_idx = build_arms_mesh(palette, out_name, pose)
    arm = rig_and_animate(mesh, left_idx, pose)
    out = REPO / "assets/models" / out_file
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.export_scene.gltf(filepath=str(out), use_selection=True, export_yup=True)
    tris = sum(len(p.vertices) - 2 for p in mesh.data.polygons)
    return {"glb": str(out), "tris": tris, "kb": out.stat().st_size // 1024,
            "clips": ["equip", "reload", "inspect"]}


# class -> filename suffix; rifle covers smg too (client maps smg->rifle arms)
VARIANTS = {"rifle": "", "pistol": "_pistol", "knife": "_knife", "sniper": "_sniper"}


def build_variants():
    """Export every (palette × pose) arms glb the client can select."""
    outs = {}
    for base, pal in (("viewmodel_zephyr", PAL), ("viewmodel_arms", GENERIC_PAL)):
        for pose, suffix in VARIANTS.items():
            name = f"{base}{suffix}"
            for o in list(bpy.data.objects):
                if o.name.startswith(("vmh_", name, "sleeve", "cuff.", "wrap", "windline")):
                    bpy.data.objects.remove(o, do_unlink=True)
            outs[name] = build_all(palette=pal, out_file=f"{name}.glb",
                                   out_name=name, pose=pose)
    return outs


def render_fp(name="viewmodel_fp", rifle="weapon_rifle_v3", arms_name="viewmodel_zephyr"):
    """Game-camera check: camera at the client anchor inverse, FOV 90, plus
    side/top diagnostics. Renders arms + the actual rifle."""
    import harness, importlib
    importlib.reload(harness)
    harness._ensure_studio()
    cam = harness._camera()
    scn = bpy.context.scene
    objs = [bpy.data.objects[arms_name]]
    if bpy.data.objects.get(rifle):
        objs.append(bpy.data.objects[rifle])
    state = harness._solo(objs)
    out = harness.PREVIEWS / name
    out.mkdir(parents=True, exist_ok=True)
    scn.render.resolution_x, scn.render.resolution_y = 1280, 800
    shots = [
        ("game_cam", Vector(CAMERA_POS), Vector((0, 0.4, -0.02)), math.radians(90)),
        ("side", Vector((-0.85, 0.05, 0.05)), Vector((0, 0.05, -0.08)), math.radians(45)),
        ("top", Vector((0.02, 0.05, 0.85)), Vector((0, 0.05, -0.05)), math.radians(45)),
        ("grip_close", Vector((-0.28, -0.34, 0.02)), Vector((0.03, -0.10, -0.06)), math.radians(40)),
        ("lhand_close", Vector((-0.30, 0.02, -0.06)), Vector((-0.02, 0.28, -0.02)), math.radians(40)),
    ]
    paths = []
    for nm, pos, tgt, ang in shots:
        cam.data.angle = ang
        cam.location = pos
        cam.rotation_euler = (tgt - pos).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = str(out / f"{nm}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scn.render.filepath)
    harness._restore(state)
    return paths


if __name__ == "__main__":
    print(build_all())
