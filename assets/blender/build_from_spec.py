"""Rebuild all Vantage models inside Blender from assets/models/specs.json.

Run headless:
    blender --background --python assets/blender/build_from_spec.py -- [--export]

Or open Blender, paste into the Scripting tab, and press Run — every model is
created in its own collection, laid out in a row, materials assigned, ready to
tweak. With --export, each model is also exported to assets/models/<name>.glb
(overwriting the procedurally generated ones).

Blender 3.x / 4.x compatible.
"""
import json
import math
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]  # assets/
SPEC = json.loads((ROOT / "models" / "specs.json").read_text())
EXPORT = "--export" in sys.argv


def hex_rgb(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def make_material(key, spec):
    mat = bpy.data.materials.get(f"vc_{key}")
    if mat:
        return mat
    mat = bpy.data.materials.new(f"vc_{key}")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = hex_rgb(spec["color"]) + [1.0]
    bsdf.inputs["Metallic"].default_value = spec.get("metallic", 0.0)
    bsdf.inputs["Roughness"].default_value = spec.get("roughness", 0.8)
    if "emissive" in spec:
        # input name differs across Blender versions
        for name in ("Emission Color", "Emission"):
            if name in bsdf.inputs:
                bsdf.inputs[name].default_value = hex_rgb(spec["emissive"]) + [1.0]
                break
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 2.0
    return mat


def add_part(p):
    t = p["type"]
    if t == "box":
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.object
        obj.scale = [s / 1.0 for s in p["size"]]
    elif t == "cyl":
        r, h = p["size"]
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=p.get("sections", 12), radius=r, depth=h,
            rotation=(math.radians(90), 0, 0))  # Z axis -> Y axis
        obj = bpy.context.object
    elif t == "cone":
        r, h = p["size"]
        bpy.ops.mesh.primitive_cone_add(
            vertices=p.get("sections", 12), radius1=r, radius2=0, depth=h,
            rotation=(math.radians(90), 0, 0))
        obj = bpy.context.object
    elif t == "sphere":
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=p["size"][0])
        obj = bpy.context.object
    else:
        raise ValueError(t)

    bpy.ops.object.transform_apply(scale=(t == "box"), rotation=(t in ("cyl", "cone")))

    if p.get("scale"):
        obj.scale = p["scale"]
        bpy.ops.object.transform_apply(scale=True)
    if p.get("rot"):
        obj.rotation_euler = [math.radians(d) for d in p["rot"]]
        bpy.ops.object.transform_apply(rotation=True)
    obj.location = p["pos"]
    obj.name = p["name"]

    mat = make_material(p["mat"], SPEC["materials"][p["mat"]])
    obj.data.materials.append(mat)
    return obj


def main():
    # wipe default scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    offset = 0.0
    for model_name, parts in SPEC["models"].items():
        coll = bpy.data.collections.new(model_name)
        bpy.context.scene.collection.children.link(coll)
        objs = []
        for p in parts:
            obj = add_part(p)
            for c in obj.users_collection:
                c.objects.unlink(obj)
            coll.objects.link(obj)
            objs.append(obj)

        # join into one object per model
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        model = bpy.context.object
        model.name = model_name

        if EXPORT:
            bpy.ops.object.select_all(action="DESELECT")
            model.select_set(True)
            bpy.ops.export_scene.gltf(
                filepath=str(ROOT / "models" / f"{model_name}.glb"),
                use_selection=True, export_yup=True)

        model.location.x = offset  # lay out in a row for viewing
        offset += max(model.dimensions.x, 0.5) + 0.6

    print(f"Built {len(SPEC['models'])} models" + (" and exported .glb files" if EXPORT else ""))


main()
