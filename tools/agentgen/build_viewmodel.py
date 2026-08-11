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
# The client's eye in anchor space, exactly: viewmodel.ts anchors at
# (0.16,-0.13,-0.35) with rotation.y = 0.06, so the camera sits at
# R_y(-0.06) * (-0.16, 0.13, 0.35) (three.js) mapped to Blender's Z-up.
CLIENT_CAM = (-0.1807, -0.3398, 0.13)
CLIENT_FWD = (0.05996, 0.9982, 0.0)

# Tactical-glove values: the glove is nearly black and the sleeve carries the
# colour, so the hand reads by silhouette against the weapon the way the
# reference does. A mid-grey glove on a grey weapon is why the old fists
# dissolved into the receiver.
# Hues track Zephyr's agent palette (tools/agentgen/specs.py): the sleeve is the
# character's jacket, the glove its gear, the cuff its accent.
PAL = {
    # Zephyr's jacket is #E9F0EE, but at full value the sleeve out-reads the
    # weapon and becomes the brightest thing on screen — the reverse of the
    # reference, where the gun is the highlight and the arm sits under it.
    "white": ("#B7C0C2", 0.05, 0.58),   # sleeve shell  (agent jacket, dimmed)
    "teal":  ("#35BFAE", 0.25, 0.50),   # cuff          (agent accent)
    "dark":  ("#101519", 0.12, 0.72),   # ribs
    "glove": ("#17212B", 0.06, 0.68),   # the glove     (agent gear)
    "strap": ("#2B333D", 0.30, 0.60),   # wrist band
    "glow":  ("#78E6D5", 0.0, 0.35, "#3ED8C3"),
}
GENERIC_PAL = {  # viewmodel_arms.glb (non-Zephyr agents)
    "white": ("#6F777F", 0.05, 0.66),
    "teal":  ("#464E58", 0.20, 0.58),
    "dark":  ("#0E1115", 0.12, 0.74),
    "glove": ("#1B1F25", 0.06, 0.70),
    "strap": ("#333A43", 0.30, 0.62),
    "glow":  ("#8A939C", 0.0, 0.45),
}


def hex_rgba(h):
    """sRGB hex -> linear, which is what a Principled base colour actually
    wants. Feeding the raw hex in (as the weapon builder does) lifts every dark
    value by roughly a factor of three — it is why a #191D24 glove was still
    rendering as mid grey and dissolving into the receiver behind it."""
    h = h.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out + [1.0]


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
    if key == "glove":
        # A near-black glove under a strong key is carried almost entirely by
        # its specular lobe, which is what makes it read mid-grey. Tactical
        # gloves are matte; drop the default 4% reflectance to about 2%.
        for n in ("Specular IOR Level", "Specular"):
            if n in b.inputs:
                b.inputs[n].default_value = 0.25
                break
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

KNUCKLE_BUMP = 0.0036
TENDON_RIDGE = 0.0014
VALLEY = 0.0022


def sculpt_hand_detail(hand, mirrored):
    """Cut the landmarks a hand is recognised by into the back of the glove.

    The vendor cast is 3300 verts with a single multires level and almost no
    relief above the metacarpals, so from the player's viewpoint — which looks
    straight at the back of the support hand — it reads as a smooth mitten. Add
    what should be there: MCP and finger-joint heads raised, tendons running
    back over the metacarpals, valleys sunk between them. Done on the rest pose
    before rigging, so it rides the grip like the rest of the skin."""
    s = -1.0 if mirrored else 1.0
    me = hand.data
    heads = []                       # (x, z, sigma_x, sigma_z, amplitude)
    for name in DIGITS:
        chain = _digit_chain(name)
        m = chain[0]
        heads.append((m.x * s, m.z, 0.0125, 0.0135, KNUCKLE_BUMP))
        for j, amp in ((1, KNUCKLE_BUMP * 0.55), (2, KNUCKLE_BUMP * 0.30)):
            q = chain[j]
            heads.append((q.x * s, q.z, 0.0076, 0.0082, amp))
    xs = sorted(Vector(DIGITS[n][0]).x * s for n in DIGITS)
    valleys = [(xs[i] + xs[i + 1]) / 2 for i in range(len(xs) - 1)]
    for v in me.vertices:
        n = v.normal
        back = max(0.0, -n.y)        # the palm side stays smooth
        if back < 0.04:
            continue
        p = v.co
        d = 0.0
        for kx, kz, sx, sz, amp in heads:
            d += amp * math.exp(-(((p.x - kx) / sx) ** 2 + ((p.z - kz) / sz) ** 2))
        w = math.exp(-((p.z + 0.062) / 0.032) ** 2)   # over the metacarpals only
        for tx in xs:
            d += TENDON_RIDGE * w * math.exp(-((p.x - tx) / 0.0075) ** 2)
        for vx in valleys:
            d -= VALLEY * w * math.exp(-((p.x - vx) / 0.0070) ** 2)
        v.co = p + n * (d * back)
    me.update()
    return hand


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
    # One flex convention for every digit incl. the thumb and both hands: roll
    # each bone so its local +Z faces the palm (+Y). Local +Y is always the bone
    # itself, so local +X becomes the flexion axis and a POSITIVE rotation
    # always bends toward the palm; local +Z stays the splay axis. Without this
    # each digit inherits Blender's auto-roll and curls in its own tilted plane.
    for b in eb:
        if b.name not in ("root", "palm"):
            b.align_roll(Vector((0.0, 1.0, 0.0)))
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


def weight_like_skin(hand, n_skin):
    """Every vertex joined on after skinning (the glove plates) inherits the
    weights of the nearest original skin vertex. The old version pinned each
    accent island to a single palm/root bone, so anything sitting on a finger
    stayed put while the finger curled out from under it."""
    from mathutils import kdtree
    me = hand.data
    extra = len(me.vertices) - n_skin
    if extra <= 0:
        return 0
    tree = kdtree.KDTree(n_skin)
    for i in range(n_skin):
        tree.insert(me.vertices[i].co, i)
    tree.balance()
    src = [[(g.group, g.weight) for g in me.vertices[i].groups] for i in range(n_skin)]
    by_index = {g.index: g for g in hand.vertex_groups}
    for i in range(n_skin, len(me.vertices)):
        _, j, _ = tree.find(me.vertices[i].co)
        for gi, w in src[j]:
            by_index[gi].add([i], w, "REPLACE")
    return extra


def _surface_patch(hand, name, material, pick, thickness=0.0024, lift=0.0005,
                   bevel_w=0.0009):
    """A plate cut from the glove's OWN surface: keep the faces `pick(center,
    normal)` wants, push them out along their normals and solidify. Floating
    cuboids read as stickers pasted on a curved hand — these bend with it."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(hand.data)
    bm.faces.ensure_lookup_table()
    bm.normal_update()
    drop = [f for f in bm.faces if not pick(f.calc_center_median(), f.normal)]
    if len(drop) >= len(bm.faces):
        bm.free()
        return None
    bmesh.ops.delete(bm, geom=drop, context="FACES")
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * lift
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if not me.polygons:
        bpy.data.meshes.remove(me)
        return None
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    me.materials.append(material)
    W._activate(o)
    md = o.modifiers.new("sol", "SOLIDIFY")
    md.thickness = thickness
    md.offset = 1.0
    W._apply(o, md)
    W.bevel(o, bevel_w, 2, 50)
    return o


def pose_hand(hand, arm, curls, mirrored):
    """curls: {digit: (mcp, pip, dip)} degrees + optional 'splay' {digit: deg}
    and 'thumb': (cmc_flex, cmc_abduct, mcp, ip). Applies pose into the mesh.

    Bone-local +X flexes toward the palm and +Z splays within the palm plane
    for every digit (rig_hand rolls them that way), so the thumb's second value
    swings it across the palm — which is what actually places a thumb — rather
    than rolling it about its own length as it used to."""
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
    cmc, abduct, tm, ti = curls["thumb"]
    arm.pose.bones["thumb1"].rotation_euler = (
        math.radians(cmc) * k, 0, math.radians(abduct) * s)
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


def trim_forearm(hand, keep_below_z=0.042):
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
    # cap the stump — an open wrist shows through the sleeve cuff as a black
    # slit whenever the camera catches the seam at a grazing angle
    border = [e for e in bm.edges if len(e.link_faces) == 1]
    if border:
        bmesh.ops.holes_fill(bm, edges=border)
    bm.to_mesh(hand.data)
    bm.free()
    hand.data.update()


# ---------------------------------------------------------- grip solver
# Every digit flexes about its bone-local +X (see rig_hand), so a phalanx never
# leaves its own hand-local YZ plane. That makes a grip a 2D problem: the thing
# being held is a cylinder, it cuts a circle in each finger's plane, and a
# convincing grip is just "lay the phalanges onto that circle". Phalanges 2/3
# become chords of it, phalanx 1 reaches in from the knuckle. The alternative —
# hand-tuning 15 angles per hand per weapon — is what produced the melted fists.
FINGER_R = 0.0115   # bone chain -> skin, i.e. half a phalanx
MCP_Z = -0.098      # fingers start here; everything above is palm
HAND_SCALE = 0.92
DEFAULT_CURL = {"pinky": (66, 78, 40), "ring": (64, 76, 38),
                "middle": (60, 72, 34), "index": (52, 62, 30)}


def _digit_chain(name):
    """Rest-pose joint positions (MCP, PIP, DIP, TIP) in hand-local space."""
    mcp, tip = Vector(DIGITS[name][0]), Vector(DIGITS[name][1])
    return [mcp, mcp.lerp(tip, 0.42), mcp.lerp(tip, 0.72), tip]


def _yz(p):
    """Into the flex plane. +X bone rotation is a CCW turn in these coords."""
    return Vector((p.y, p.z))


def _rot2(v, a):
    c, s = math.cos(a), math.sin(a)
    return Vector((v.x * c - v.y * s, v.x * s + v.y * c))


def _signed(a, b):
    return math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y)


def wrap_digit(name, seat, radius, clearance=FINGER_R, max_mcp=92.0):
    """(mcp, pip, dip) flexion in degrees that wraps one finger onto a cylinder
    whose axis runs along hand-local X through `seat` = (y, z).

    Phalanx 1 swings until the PIP knuckle lands on the circle of radius
    `radius + clearance` (circle/circle intersection, near branch); 2 and 3 then
    step around that circle as chords. Returns None when the cylinder is out of
    reach or would need a hyperextended knuckle — caller falls back."""
    C = Vector(seat)
    rho = radius + clearance
    P = [_yz(p) for p in _digit_chain(name)]
    L = [(P[i + 1] - P[i]).length for i in range(3)]
    to_c = C - P[0]
    d = to_c.length
    if d < 1e-6 or L[0] < 1e-6:
        return None
    cos_b = (d * d + L[0] * L[0] - rho * rho) / (2.0 * d * L[0])
    if not -1.0 <= cos_b <= 1.0:
        return None                       # knuckle inside it, or can't reach
    d1 = _rot2(to_c / d, -math.acos(cos_b))
    mcp = _signed(P[1] - P[0], d1)
    if mcp < 0.0 or math.degrees(mcp) > max_mcp:
        return None
    pts = [P[0], P[0] + d1 * L[0]]
    phi = math.atan2(pts[1].y - C.y, pts[1].x - C.x)
    for i in (1, 2):
        phi += 2.0 * math.asin(min(1.0, L[i] / (2.0 * rho)))
        pts.append(C + Vector((math.cos(phi), math.sin(phi))) * rho)
    seg = [pts[i + 1] - pts[i] for i in range(3)]
    return (math.degrees(mcp), math.degrees(_signed(seg[0], seg[1])),
            math.degrees(_signed(seg[1], seg[2])))


def _seat_y(hand, cz, radius, half_x=0.046, clear=0.0012, band=0.034):
    """How high the held cylinder rides: the lowest axis height at which no
    vertex of the distal palm ends up inside it. Measured off the real mesh, so
    a fatter handguard pushes the hand out on its own. Only the pad below the
    knuckles counts — the thenar bulge further up the palm never touches a
    handguard, and letting it vote parked the whole grip a centimetre out."""
    best = None
    for v in hand.data.vertices:
        p = v.co
        if abs(p.x) > half_x or not (MCP_Z <= p.z <= MCP_Z + band) or p.y < -0.004:
            continue
        dz = p.z - cz
        if abs(dz) >= radius:
            continue
        y = p.y + math.sqrt(radius * radius - dz * dz)
        if best is None or y > best:
            best = y
    return (radius if best is None else best) + clear


def solve_curls(hand, cfg):
    """Grip config -> the curls dict pose_hand() consumes, plus the seat point.
    Radius stays the weapon's true radius: canting the hand makes each finger
    plane cut the cylinder as a slightly wider ellipse, but compensating for
    that lifted the fingers clear of the surface, and a glove biting a
    millimetre into a handguard reads as grip while a gap reads as broken."""
    cz = cfg["seat_z"]
    radius = cfg["radius"]
    cy = cfg.get("seat_y") or _seat_y(hand, cz, radius)
    slack = cfg.get("slack", {})
    override = cfg.get("override", {})
    curls = {"thumb": cfg["thumb"], "splay": dict(cfg.get("splay", {}))}
    for name in DIGITS:
        if name in override:
            curls[name] = override[name]
            continue
        got = wrap_digit(name, (cy, cz), radius,
                         cfg.get("finger_r", FINGER_R) + slack.get(name, 0.0))
        curls[name] = got or DEFAULT_CURL[name]
    return curls, (cy, cz)


def seat_hand(hand, cfg, seat, scale=HAND_SCALE):
    """Drop the solved hand onto the weapon: its local grip axis (+X) lands on
    the weapon's `axis`, the palm ends up on the `out` side of that axis, and
    `cant` spins the hand about `out` to swing the forearm back off
    perpendicular the way a real grip sits. Returns the wrist in world space."""
    axis = Vector(cfg["axis"]).normalized()
    out = Vector(cfg["out"])
    out = (out - axis * out.dot(axis)).normalized()
    Xw = (Matrix.Rotation(math.radians(cfg.get("cant", 0.0)), 3, out) @ axis).normalized()
    Yw = -out                                  # palm faces the held cylinder
    Zw = Xw.cross(Yw).normalized()             # fingers are -Z, so wrist is +Z
    M = Matrix.Identity(4)
    M.col[0][:3], M.col[1][:3], M.col[2][:3] = Xw, Yw, Zw
    xf = (Matrix.Translation(Vector(cfg["center"])) @ M @ Matrix.Scale(scale, 4)
          @ Matrix.Translation(-Vector((0.0, seat[0], seat[1]))))
    hand.matrix_world = xf @ hand.matrix_world
    W._activate(hand)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return xf @ WRIST_LOCAL, Zw


# Shoulders in anchor space: the client's eye sits at CAMERA_POS, so the torso
# hangs off that, not off the weapon.
SHOULDER = {"L": (-0.34, -0.40, -0.14), "R": (0.03, -0.40, -0.14)}
FOREARM = 0.30


def elbow_for(side, wrist, wrist_dir, cfg):
    """Put the elbow a forearm's length back from the wrist, along a direction
    that leaves the wrist straight (no kink at the glove cuff) but aims at the
    shoulder. The old configs hardcoded an elbow ~0.60m from the wrist, which
    is what turned the sleeve into a giant white cone."""
    if cfg.get("elbow"):
        return Vector(cfg["elbow"])
    w = Vector(wrist)
    to_body = (Vector(SHOULDER[side]) - w).normalized()
    d = (Vector(wrist_dir).normalized() * 0.45 + to_body * 0.55).normalized()
    return w + d * cfg.get("forearm", FOREARM)


# ---------------------------------------------------------- grip configs
# One grip per weapon CLASS (the client swaps arms by weaponClassFor()). Each
# names the cylinder the hand closes on, in weapon space, straight off
# tools/weapongen/build_weapons.py:
#   rifle  — guard = cyl(r 0.030) along +Y at (0, 0.315, 0.010); grip = loft
#            from (0,-0.095,-0.050) along (0,-.34,-1), ~0.022 girth. Also smg.
#   sniper — same firing hand, support hand out on the deeper forend.
#   pistol — two-handed: support hand wraps the firing hand's fingers.
#   knife  — one-handed: no left arm at all (vm_l_hand group stays empty).
_GRIP_AXIS = (0.0, -0.3218, -0.9468)      # rifle grip rake (0,-.34,-1), normalized
_BACKSTRAP = (0.0, -0.9468, 0.3218)       # ⊥ to it, pointing at the palm
_PGRIP_AXIS = (0.0, -0.3873, -0.9221)     # pistol grip rake (0,-.42,-1)
_PBACKSTRAP = (0.0, -0.9221, 0.3873)

# firing hand on the rifle's raked pistol grip: local +X (the pinky side once
# mirrored) runs down the grip, so the index lands at the trigger and the thumb
# rides up toward the receiver. Index is overridden — it's on the trigger, not
# wrapped around anything.
# `cant` is the one free DOF once the fingers are perpendicular to what they
# hold: it spins the hand about `out`, swinging the forearm off perpendicular
# and back toward the shoulder the way a real grip sits.
_R_ON_GRIP = {
    "axis": _GRIP_AXIS, "out": _BACKSTRAP, "center": (0.0, -0.1128, -0.1017),
    "radius": 0.021, "cant": -35.0, "seat_z": -0.074,
    "thumb": (12, 24, 14, 8),
    "override": {"index": (26, 16, 6)},
    "slack": {"pinky": 0.0015},
    "splay": {"index": -4, "pinky": 3},
}
# support hand C-clamps the handguard from the left: palm on the left flank,
# fingers over the top, thumb forward, canted so the forearm swings back-left.
_L_ON_GUARD = {
    # seated at the BACK of the guard (it spans y 0.165..0.465): a support hand
    # out at mid-barrel is both wrong for the hold and half a metre from the
    # camera, where it shrinks to an unreadable speck.
    "axis": (0.0, 1.0, 0.0), "out": (-0.94, 0.0, 0.34), "center": (0.0, 0.196, 0.010),
    "radius": 0.030, "cant": 32.0, "seat_z": -0.082,
    "thumb": (-14, 30, 10, 6),
    "slack": {"pinky": 0.002, "ring": 0.001},
    "splay": {"index": 3, "pinky": -4},
}
GRIPS = {
    "rifle": {"R": _R_ON_GRIP, "L": _L_ON_GUARD},
    "sniper": {"R": _R_ON_GRIP,
               "L": {**_L_ON_GUARD, "center": (0.0, 0.262, -0.004),
                     "radius": 0.032, "cant": 30.0}},
    # the pistol has its OWN rake — grip_p lofts from (0,-0.048,-0.008) along
    # (0,-.42,-1), narrower than the rifle's (hw 0.013, hd 0.023). Reusing the
    # rifle's axis and centre here is what left both hands clutching at air.
    "pistol": {
        "R": {**_R_ON_GRIP, "axis": _PGRIP_AXIS, "out": _PBACKSTRAP,
              "center": (0.0, -0.0693, -0.0587), "radius": 0.019,
              "seat_z": -0.072, "override": {"index": (30, 18, 6)}},
        # support hand wraps the firing hand itself: same axis, a cylinder fat
        # enough to be grip + right-hand fingers, approached from the left
        "L": {"axis": _PGRIP_AXIS, "out": (-1.0, 0.0, 0.0),
              "center": (0.0, -0.0770, -0.0772), "radius": 0.040, "cant": -40.0,
              "seat_z": -0.078, "thumb": (-10, 26, 14, 8),
              "splay": {"index": 3, "pinky": -3}},
    },
    "knife": {
        # hammer grip: handle lofts from (0,-0.006,0.013) along (0,-1,-0.1),
        # hw 0.0115 / hd 0.018 at the grip, plus ~2mm of cord wrap
        "R": {"axis": (0.0, -0.995, -0.0995), "out": (0.0, -0.0995, 0.995),
              "center": (0.0, -0.0657, 0.0070), "radius": 0.0175, "cant": -28.0,
              "seat_z": -0.070, "thumb": (16, 30, 18, 10),
              "splay": {"index": -3, "pinky": 3}},
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
    sculpt_hand_detail(hand, mirrored)
    hand.data.materials.clear()
    hand.data.materials.append(mat("glove", palette))
    curls, seat = solve_curls(hand, cfg)   # needs the mesh unposed
    arm = rig_hand(hand, mirrored)
    add_glove_gear_post(hand, arm, palette, mirrored)
    pose_hand(hand, arm, curls, mirrored)
    wrist, wrist_dir = seat_hand(hand, cfg, seat)
    W._smooth(hand, 62)
    return hand, wrist, elbow_for(side, wrist, wrist_dir, cfg)


# glove plating, in hand-local landmark space (palm +Y, fingers -Z, wrist +Z).
# Cut from the hand's surface, so a band that spans all four fingers arrives as
# four separate islands — the mesh has no geometry in the gaps between them.
def add_glove_gear_post(hand, arm, palette, mirrored):
    """Dress the glove, then give the new geometry the skin's own weights so it
    curls with the hand. Runs before pose_hand: the plates are authored on the
    rest pose and ride the armature into the grip like the skin does.

    Only the wrist band survives here. Anything cut from this mesh's surface
    inherits its quad boundary, and at 3300 verts that boundary is coarse enough
    that knuckle plates came out as jagged pixel crosses stuck to the fingers —
    worse than bare glove. The knuckles read from the form instead, which is
    what sculpt_hand_detail is for, and matches how plain the reference gloves
    actually are."""
    n_skin = len(hand.data.vertices)
    gear = [
        _surface_patch(hand, "gv_cuff", mat("dark", palette),
                       lambda c, n: 0.026 <= c.z <= 0.040,
                       thickness=0.0030, bevel_w=0.0012),
    ]
    gear = [g for g in gear if g]
    if gear:
        W._activate(hand)
        for g in gear:
            g.select_set(True)
        bpy.ops.object.join()
    return weight_like_skin(hand, n_skin)


def build_sleeve(side, palette, elbow, wrist):
    """Sleeve lofted straight along +Y, then rotated onto the elbow->wrist
    axis (the loft helper only tilts about X, arms run diagonally)."""
    e, w = Vector(elbow), Vector(wrist)
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

    # Fitted, not tubular: a forearm is ~9cm across at the elbow and ~6cm at the
    # wrist. The old profile started at 11.6cm over a 60cm "forearm", which is
    # what made the sleeve read as a giant white cone filling the frame.
    def rad(t):
        return 0.042 - 0.015 * t ** 0.8

    parts = []
    # runs past t=1 (the wrist) so it sleeves over the hand's trim edge instead
    # of leaving a black hole where the two meet
    parts.append(place(W.loft(f"sleeve.{side}", [
        ring(t, rad(t), rad(t) * 1.06)
        for t in (0.0, 0.18, 0.40, 0.62, 0.80, 0.93, 1.0, 1.14)
    ], mat("white", palette), ring=14, round_k=0.45, subsurf=1)))
    # armour ribs banding the forearm — the segmented look of the reference.
    # Kept shallow: proud rings this size turn the arm into a caterpillar.
    for i, t in enumerate((0.26, 0.52)):
        r = rad(t) + 0.0016
        parts.append(place(W.loft(f"rib{i}.{side}", [
            ring(t, r * 0.985, r * 1.045), ring(t + 0.085, r, r * 1.06),
            ring(t + 0.115, r * 0.97, r * 1.03)],
            mat("dark", palette), ring=14, round_k=0.45, subsurf=1)))
    # cuff where the sleeve meets the glove. Four rings, not two: subsurf pulls
    # a loft toward its control cage, and a 2-ring cage collapses far harder
    # than the 8-ring shell it is supposed to cover — which is what tore the
    # white through the cuff in a jagged line.
    cr = [rad(0.86) + 0.0050, rad(0.92) + 0.0052, rad(1.0) + 0.0054,
          rad(1.04) + 0.0046]
    parts.append(place(W.loft(f"cuff.{side}", [
        ring(t, r, r * 1.06) for t, r in
        zip((0.86, 0.94, 1.08, 1.18), cr)],
        mat("teal", palette), ring=14, round_k=0.45, subsurf=1)))
    # identity stripe along the outside of the forearm
    n_up = (q @ Vector((0, 0, 1))).normalized()
    wp = W.plate(f"windline.{side}", (0.007, L * 0.26, 0.010), (0, 0, 0),
                 mat("glow", palette), bevel_w=0.001)
    wp.rotation_euler = q.to_euler()
    wp.location = e.lerp(w, 0.52) + n_up * (rad(0.52) + 0.001)
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


# Where the support hand reaches on a reload. The MAGWELL, not the base of the
# magazine: the client's eye sits at z 0.13 with a 90° vertical FOV, so the
# bottom of the frame near the weapon is about z -0.21, and a hand sent to the
# mag base (z -0.254) plays the whole reload underneath the screen. The root
# bone's own reload dip adds roughly another -0.05 on top of these.
MAG_TARGET = {
    "rifle": (0.0, 0.048, -0.135),
    "sniper": (0.0, 0.048, -0.135),
    "pistol": (0.015, -0.078, -0.118),
    "knife": None,
}
# frame, vm_l_hand rotation (deg), how far along the reach
RELOAD_L_PROFILE = (
    (1,  (0, 0, 0), 0.0),
    (6,  (-8, 0, -5), 0.45),
    (12, (-13, 0, -8), 0.92),
    (16, (-14, 0, -8), 1.0),
    (19, (-12, 0, -7), 0.88),
    (30, (-4, 0, -2), 0.28),
    (38, (0, 0, 0), 0.0),
)


def _reload_l_keys(arm, centroid, target):
    """Solve the bone-local translations that actually put the support hand on
    the magazine, given where its geometry starts.

    These used to be hand-typed offsets, which silently stopped meaning anything
    the moment the grip moved: with the hand reseated on the guard, the old
    numbers threw it a quarter-metre below the receiver and out of frame."""
    if target is None:
        return []
    bone = arm.data.bones["vm_l_hand"]
    inv = bone.matrix_local.to_3x3().inverted()
    head = Vector(bone.head_local)
    c0 = Vector(centroid)
    keys = []
    for frame, rot, along in RELOAD_L_PROFILE:
        rot_m = Euler([math.radians(d) for d in rot], "XYZ").to_matrix()
        want = c0.lerp(Vector(target), along)
        keys.append((frame, tuple(inv @ (want - head - rot_m @ (c0 - head))), rot))
    return keys

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
    l_centroid = None
    if left_verts:
        vg_root.remove(left_verts)
        vg_l.add(left_verts, 1.0, "REPLACE")
        pts = [mesh.data.vertices[i].co for i in left_verts]
        l_centroid = sum(pts, Vector()) / len(pts)
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
    ], keys_l=_reload_l_keys(arm, l_centroid, MAG_TARGET.get(pose)))
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
    cfgs = GRIPS[pose]
    parts = []
    left_parts = []
    for side in ("R", "L"):
        cfg = cfgs[side]
        if cfg is None:  # one-handed pose (knife): no left arm at all
            continue
        hand, wrist, elbow = build_hand(side, palette, cfg)
        sleeves = build_sleeve(side, palette, elbow, wrist)
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
    """Game-camera check plus close-up diagnostics, arms + the actual weapon.

    `game_cam` reproduces the client exactly, which the old version did not:
    render.ts builds PerspectiveCamera(90, ...) and three.js reads fov as
    VERTICAL, and viewmodel.ts yaws the anchor by 0.06 rad — so framing tuned
    against a 90° horizontal shot at 16:10 was never what a player sees."""
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
    paths = []

    # the player's view
    scn.render.resolution_x, scn.render.resolution_y = 1280, 720
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(90)
    cam.location = Vector(CLIENT_CAM)
    cam.rotation_euler = Vector(CLIENT_FWD).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = str(out / "game_cam.png")
    bpy.ops.render.render(write_still=True)
    paths.append(scn.render.filepath)

    cam.data.sensor_fit = "AUTO"
    scn.render.resolution_x, scn.render.resolution_y = 1280, 800
    for nm, pos, tgt, ang in [
        ("side", (-0.85, 0.05, 0.05), (0, 0.05, -0.08), 45),
        ("top", (0.02, 0.05, 0.85), (0, 0.05, -0.05), 45),
        ("grip_close", (0.34, -0.34, 0.03), (0.01, -0.11, -0.09), 38),
        ("lhand_close", (-0.34, 0.08, 0.28), (-0.03, 0.20, 0.00), 40),
        ("back_of_hand", (-0.26, -0.11, 0.14), (-0.045, 0.20, -0.005), 40),
    ]:
        cam.data.angle = math.radians(ang)
        cam.location = pos
        cam.rotation_euler = (Vector(tgt) - Vector(pos)).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = str(out / f"{nm}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(scn.render.filepath)
    harness._restore(state)
    return paths


if __name__ == "__main__":
    print(build_all())
