"""Per-agent build specs. All numbers in meters, Blender Z-up, character faces +Y.

Regions are predicates over face-center world positions on the normalized base
body (1.72 m, feet at z=0). Each gear entry:
  region: name of a region predicate in build_agent.REGIONS
  offset: shell inflation along normals (m)
  thick:  solidify thickness (m)
  mat:    material key in PALETTES[agent]
"""

ZEPHYR = {
    "name": "zephyr",
    "height": 1.72,
    "head_scale": 0.93,          # nudge toward ~7-head heroic proportion
    "palette": {
        "suit":   ("#232A36", 0.10, 0.75),   # navy under-suit
        "jacket": ("#EDF1F4", 0.05, 0.55),   # white
        "jacket_in": ("#2FB7A8", 0.20, 0.55),
        "pants":  ("#2A3140", 0.10, 0.70),
        "gear":   ("#1A1E26", 0.15, 0.70),   # boots/gloves/mask/straps
        "hair":   ("#E4EAEE", 0.05, 0.40),
        "accent": ("#2FB7A8", 0.25, 0.50),   # teal — Zephyr's color
        "glow":   ("#5FF2DE", 0.0, 0.35, "#33E0CC"),
        "metal":  ("#98A2AE", 0.7, 0.35),
    },
    "gear": [
        # layered shells, inner→outer
        {"kind": "shell", "region": "pants",  "offset": 0.004, "thick": 0.006, "mat": "pants"},
        {"kind": "shell", "region": "boots",  "offset": 0.010, "thick": 0.010, "mat": "gear"},
        {"kind": "shell", "region": "gloves", "offset": 0.009, "thick": 0.008, "mat": "gear"},
        {"kind": "shell", "region": "jacket", "offset": 0.010, "thick": 0.010, "mat": "jacket"},
        {"kind": "shell", "region": "mask",   "offset": 0.008, "thick": 0.006, "mat": "gear"},
        {"kind": "shell", "region": "hood",   "offset": 0.030, "thick": 0.008, "mat": "jacket"},
    ],
    # hard-surface add-ons built procedurally in build_agent.py
    "addons": ["visor", "ponytail", "belt", "chest_strap", "thigh_rig",
               "shin_guards", "shoulder_plate_l", "back_blades", "windlines"],
}

AGENTS = {"zephyr": ZEPHYR}
