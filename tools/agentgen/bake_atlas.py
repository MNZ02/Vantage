"""Bake ambient occlusion into vertex colors (COLOR_0) for an agent's final
mesh. glTF multiplies COLOR_0 into base color, so Three.js gets baked contact
shading for free — no texture, no extra UV set, decimation-proof, and it suits
the flat-palette stylized look better than a noisy 2048 atlas.

(First attempt was a classic smart-project atlas bake; on the decimated
triangle soup it produced confetti islands. Vertex AO is the right tool here.)

Live: import, call bake_vertex_ao("zephyr") after rig_export.
"""
import sys
from pathlib import Path

import bpy
import numpy as np

REPO = Path(__file__).resolve().parents[2] if "__file__" in globals() else Path(
    "/Users/mnz/dev/valorant-clone")


def bake_vertex_ao(agent_key, strength=0.55):
    mesh = bpy.data.objects[f"{agent_key}_final"]
    me = mesh.data
    # color attribute (corner-domain, byte color = exports as COLOR_0)
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
    scn.cycles.samples = 32
    scn.render.bake.target = "VERTEX_COLORS"
    bpy.ops.object.bake(type="AO")
    scn.render.bake.target = "IMAGE_TEXTURES"
    scn.render.engine = prev

    # lift the AO (pure black crevices read muddy at game distance)
    col = me.color_attributes["Col"]
    n = len(col.data)
    buf = np.empty(n * 4, dtype=np.float32)
    col.data.foreach_get("color", buf)
    buf = buf.reshape(-1, 4)
    buf[:, :3] = buf[:, :3] * strength + (1 - strength)
    col.data.foreach_set("color", buf.reshape(-1))
    me.update()
    return {"verts": len(me.vertices)}


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    kv = dict(zip(argv[::2], argv[1::2]))
    print(bake_vertex_ao(kv.get("--agent", "zephyr")))
