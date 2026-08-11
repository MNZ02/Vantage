"""Prove the visual map never disagrees with the sim's collision.

map_crossing.glb is cosmetic — collision lives in @vg/sim's LEVEL_BOXES — so
every added surface has to hug a box the sim already has. Detail that drifts off
a box becomes cover you can see but not shoot, or an eave that quietly deletes
a sightline. This asserts the two rules build_map.py's docstring claims:

  1. Inside the playable footprint, every vertex is within TOL of some
     LEVEL_BOX (0 if inside one). TOL is the ~2 cm proud-fin budget the
     dressing works to, plus room for bevels.
  2. Nothing inside the footprint rises above the 3 m wall tops. Players can
     stand on the 2.4 m crates and hold angles over the walls; roofs there
     would remove them.

Scenery beyond the perimeter is exempt — it cannot occlude anything.

Usage: python3 tools/mapgen/check_gameplay_safe.py
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
GLB = REPO / "assets/models/map_crossing.glb"
DATA = json.loads((Path(__file__).resolve().parent / "level_data.json").read_text())

TOL = 0.05          # proud-fin budget (2.4 cm max) + bevel headroom
MAX_H = 3.0         # wall tops
COMPONENT = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}


def _node_matrix(node):
    """TRS (or explicit matrix) of a single glTF node, as 4x4."""
    if "matrix" in node:
        return np.array(node["matrix"], dtype=np.float64).reshape(4, 4).T
    m = np.eye(4)
    if "scale" in node:
        m = np.diag(list(node["scale"]) + [1.0]) @ m
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        r = np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
            [0, 0, 0, 1]])
        m = r @ m
    if "translation" in node:
        t = np.eye(4)
        t[:3, 3] = node["translation"]
        m = t @ m
    return m


def glb_positions(path):
    """Every POSITION, in scene space.

    The node transform is NOT optional here: the exporter writes the joined
    object's origin (the floor box's centre, y = -0.5) as a node translation, so
    reading raw accessors alone reports the whole map half a metre too high —
    which is exactly the phantom violation the first version of this script
    'found' across every single material."""
    raw = path.read_bytes()
    if raw[:4] != b"glTF":
        raise SystemExit(f"{path} is not a glb")
    json_len = struct.unpack("<I", raw[12:16])[0]
    gltf = json.loads(raw[20:20 + json_len])
    bin_start = 20 + json_len + 8

    world = {}

    def walk(idx, parent):
        node = gltf["nodes"][idx]
        m = parent @ _node_matrix(node)
        if "mesh" in node:
            world.setdefault(node["mesh"], []).append(m)
        for child in node.get("children", ()):
            walk(child, m)

    scene = gltf["scenes"][gltf.get("scene", 0)]
    for root in scene.get("nodes", ()):
        walk(root, np.eye(4))

    out = []
    for mi, mesh in enumerate(gltf["meshes"]):
        for prim in mesh["primitives"]:
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            view = gltf["bufferViews"][acc["bufferView"]]
            off = bin_start + view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            fmt = COMPONENT[acc["componentType"]]
            n = acc["count"]
            arr = np.frombuffer(raw, dtype=np.dtype("<" + fmt),
                                count=n * 3, offset=off).reshape(n, 3).astype(np.float64)
            for m in world.get(mi, [np.eye(4)]):
                out.append(arr @ m[:3, :3].T + m[:3, 3])
    return np.concatenate(out, axis=0)


def main():
    pts = glb_positions(GLB)
    # glTF is Y-up and matches sim coords: x, y=up, z
    H = DATA["LEVEL_HALF_EXTENT"]
    inside = (np.abs(pts[:, 0]) <= H + 0.05) & (np.abs(pts[:, 2]) <= H + 0.05)
    play = pts[inside]
    print(f"{len(pts)} verts, {len(play)} inside the playable footprint")

    boxes = DATA["LEVEL_BOXES"]
    lo = np.array([[b["minX"], b["minY"], b["minZ"]] for b in boxes])
    hi = np.array([[b["maxX"], b["maxY"], b["maxZ"]] for b in boxes])

    # distance from each point to each box (0 inside), keep the nearest
    best = np.full(len(play), np.inf)
    for i in range(len(boxes)):
        d = np.maximum(lo[i] - play, 0.0) + np.maximum(play - hi[i], 0.0)
        best = np.minimum(best, np.linalg.norm(d, axis=1))

    drift = best > TOL
    tall = play[:, 1] > MAX_H + TOL
    ok = True

    if drift.any():
        ok = False
        worst = play[np.argsort(-best)][:6]
        print(f"FAIL {int(drift.sum())} verts drift >{TOL} m off every collision box")
        for p, d in zip(worst, np.sort(best)[::-1][:6]):
            print(f"     ({p[0]:+.2f}, {p[1]:+.2f}, {p[2]:+.2f}) dist={d:.3f}")
    else:
        print(f"PASS every playable vert is within {TOL} m of a LEVEL_BOX "
              f"(max {best.max():.4f} m)")

    if tall.any():
        ok = False
        print(f"FAIL {int(tall.sum())} verts sit above the {MAX_H} m wall tops "
              f"(max {play[:, 1].max():.2f} m)")
    else:
        print(f"PASS nothing in the footprint exceeds {MAX_H} m "
              f"(max {play[:, 1].max():.3f} m)")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
