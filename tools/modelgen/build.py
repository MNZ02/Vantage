"""Build .glb models + PNG previews from specs.py (no Blender needed).

Usage: python3 build.py [out_dir]
Also writes specs.json for the Blender script (assets/blender/build_from_spec.py).
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial

from specs import MATERIALS, MODELS


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def euler_matrix(deg):
    rx, ry, rz = [math.radians(d) for d in deg]
    return trimesh.transformations.euler_matrix(rx, ry, rz, "sxyz")


def make_part(p):
    t = p["type"]
    if t == "box":
        m = trimesh.creation.box(extents=p["size"])
    elif t == "cyl":
        r, h = p["size"]
        m = trimesh.creation.cylinder(radius=r, height=h, sections=p.get("sections", 12))
        m.apply_transform(euler_matrix([90, 0, 0]))  # Z-axis -> Y-axis
    elif t == "cone":
        r, h = p["size"]
        m = trimesh.creation.cone(radius=r, height=h, sections=p.get("sections", 12))
        m.apply_translation([0, 0, -h / 2])
        m.apply_transform(euler_matrix([90, 0, 0]))
    elif t == "sphere":
        m = trimesh.creation.icosphere(subdivisions=2, radius=p["size"][0])
    else:
        raise ValueError(t)
    if "scale" in p and p["scale"]:
        m.apply_transform(np.diag(list(p["scale"]) + [1.0]))
    if "rot" in p:
        m.apply_transform(euler_matrix(p["rot"]))
    m.apply_translation(p["pos"])
    return m


def material_for(key):
    spec = MATERIALS[key]
    kw = dict(
        baseColorFactor=hex_rgb(spec["color"]) + [1.0],
        metallicFactor=spec.get("metallic", 0.0),
        roughnessFactor=spec.get("roughness", 0.8),
        name=key,
    )
    if "emissive" in spec:
        kw["emissiveFactor"] = hex_rgb(spec["emissive"])
    return PBRMaterial(**kw)


def build_model(name, parts):
    scene = trimesh.Scene()
    by_mat = {}
    for p in parts:
        by_mat.setdefault(p["mat"], []).append(make_part(p))
    for mat_key, meshes in by_mat.items():
        merged = trimesh.util.concatenate(meshes)
        merged.visual = trimesh.visual.TextureVisuals(material=material_for(mat_key))
        scene.add_geometry(merged, node_name=f"{name}_{mat_key}", geom_name=f"{name}_{mat_key}")
    return scene


def preview(name, parts, path):
    """Preview with Y-up data mapped to matplotlib's Z-up."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    fig = plt.figure(figsize=(6, 5), facecolor="#14161c")
    ax = fig.add_subplot(111, projection="3d", facecolor="#14161c")
    all_pts = []
    for p in parts:
        m = make_part(p)
        c = hex_rgb(MATERIALS[p["mat"]]["color"])
        v = m.vertices[:, [0, 2, 1]] * [1, -1, 1]  # x, -z, y
        tri = v[m.faces]
        ax.add_collection3d(Poly3DCollection(
            tri, facecolors=[c + [1.0]], edgecolors=(0, 0, 0, 0.25), linewidths=0.4))
        all_pts.append(v)
    pts = np.vstack(all_pts)
    ctr, rad = pts.mean(0), (pts.max(0) - pts.min(0)).max() / 2 * 1.05
    ax.set_xlim(ctr[0] - rad, ctr[0] + rad)
    ax.set_ylim(ctr[1] - rad, ctr[1] + rad)
    ax.set_zlim(ctr[2] - rad, ctr[2] + rad)
    ax.set_box_aspect((1, 1, 1))
    ax.view_init(elev=20, azim=-50)
    ax.set_axis_off()
    ax.set_title(name, color="#A9B2BD", fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "../../assets/models").resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "previews").mkdir(exist_ok=True)

    spec_json = {"materials": MATERIALS, "models": MODELS}
    (out / "specs.json").write_text(json.dumps(spec_json, indent=1))

    report = []
    for name, parts in MODELS.items():
        scene = build_model(name, parts)
        glb = out / f"{name}.glb"
        scene.export(glb)
        tris = sum(len(g.faces) for g in scene.geometry.values())
        report.append((name, tris, glb.stat().st_size))
        preview(name, parts, out / "previews" / f"{name}.png")

    for name, tris, size in report:
        print(f"{name:16s} {tris:5d} tris  {size/1024:6.1f} KB")


if __name__ == "__main__":
    main()
