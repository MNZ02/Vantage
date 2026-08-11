"""Render-critique harness.

Renders turntable stills (front / right / back / 3-quarter / bust closeup) of a
target object or collection into assets/models/previews/<name>/, using a fixed
neutral studio: 3-point soft lighting, dark backdrop, AgX view transform.

Runs headless:
    blender --background <file.blend> --python tools/agentgen/harness.py -- \
        --target zephyr_final --name zephyr --frame 0
or import and call `render_views(...)` from any Blender session (the live MCP
session uses this module directly).

Stills are deliberately consistent shot-to-shot so critique iterations diff
cleanly. Contact sheets are stitched outside Blender by contact_sheet.py.
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/vantage")
PREVIEWS = REPO / "assets" / "models" / "previews"

LIGHT_RIG = (
    # name, type, loc, energy, size, color
    ("hx_key",  "AREA", (1.8, 1.6, 2.4), 110, 2.2, (1.0, 0.98, 0.95)),
    ("hx_fill", "AREA", (-2.0, 1.4, 1.2), 36, 3.0, (0.82, 0.90, 1.0)),
    ("hx_rim",  "AREA", (0.3, -2.4, 2.1), 95, 1.6, (0.70, 1.0, 0.95)),
)

def _ensure_studio():
    for name, typ, loc, energy, size, color in LIGHT_RIG:
        o = bpy.data.objects.get(name)
        if not o:
            bpy.ops.object.light_add(type=typ, location=loc)
            o = bpy.context.object
            o.name = name
        o.location = loc
        o.data.energy = energy
        o.data.color = color
        if hasattr(o.data, "size"):
            o.data.size = size
        o.rotation_euler = (Vector((0, 0, 1.2)) - Vector(loc)).to_track_quat(
            "-Z", "Y").to_euler()
    w = bpy.context.scene.world
    if w and w.use_nodes:
        bg = w.node_tree.nodes.get("Background")
        if bg:
            bg.inputs[0].default_value = (0.015, 0.018, 0.024, 1)
    vs = bpy.context.scene.view_settings
    try:
        vs.view_transform = "AgX"
        vs.look = "AgX - Base Contrast"
    except Exception:
        pass


def _camera():
    cam = bpy.data.objects.get("hx_cam")
    if not cam:
        data = bpy.data.cameras.new("hx_cam")
        cam = bpy.data.objects.new("hx_cam", data)
        bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def _bounds(objs):
    pts = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        oe = o.evaluated_get(dg)
        pts += [oe.matrix_world @ Vector(c) for c in oe.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def _solo(objs):
    names = {o.name for o in objs}
    state = {}
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            state[o.name] = o.hide_render
            o.hide_render = o.name not in names
    return state


def _restore(state):
    for n, h in state.items():
        o = bpy.data.objects.get(n)
        if o:
            o.hide_render = h


VIEWS = (
    # name, azimuth deg (0 = front, +Y side looking -Y ... see note), elev deg, fov, framing
    ("front", 0, 6, 0.62, "full"),
    ("right", 90, 6, 0.62, "full"),
    ("back", 180, 6, 0.62, "full"),
    ("tq", 35, 10, 0.62, "full"),
    ("bust", 25, 4, 0.50, "bust"),
)


def render_views(target, name, res=(900, 1200), samples=None):
    """target: object name or collection name. Writes PNGs to previews/<name>/."""
    scn = bpy.context.scene
    coll = bpy.data.collections.get(target)
    if coll:
        objs = [o for o in coll.objects if o.type == "MESH"]
    else:
        objs = [bpy.data.objects[target]]
    _ensure_studio()
    cam = _camera()
    lo, hi = _bounds(objs)
    ctr = (lo + hi) / 2
    rad = max((hi - lo).length / 2, 0.1)
    bust_ctr = Vector((ctr.x, ctr.y, lo.z + (hi.z - lo.z) * 0.82))
    out = PREVIEWS / name
    out.mkdir(parents=True, exist_ok=True)
    state = _solo(objs)
    scn.render.resolution_x, scn.render.resolution_y = res
    for vname, az, el, fov, framing in VIEWS:
        c = bust_ctr if framing == "bust" else ctr
        r = rad * (0.45 if framing == "bust" else 1.0)
        cam.data.angle = fov
        dist = r / math.tan(fov / 2) * 1.15
        a, e = math.radians(az), math.radians(el)
        # character faces +Y in Blender scenes here; az 0 puts camera on +Y
        cam.location = c + Vector((math.sin(a) * math.cos(e),
                                   math.cos(a) * math.cos(e),
                                   math.sin(e))) * dist
        cam.rotation_euler = (c - cam.location).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = str(out / f"{vname}.png")
        bpy.ops.render.render(write_still=True)
    _restore(state)
    return str(out)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    render_views(kv.get("--target", "zephyr_final"), kv.get("--name", "zephyr"))
