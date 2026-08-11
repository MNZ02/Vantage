"""Model specs for the Vantage low-poly asset set.

Each model is a list of parts. A part is a dict:
  type:  box | cyl | cone | sphere
  name:  part name
  size:  box -> [x, y, z] extents (m)
         cyl/cone -> [radius, height]  (built along +Y)
         sphere -> [radius]
  scale: optional [x, y, z] non-uniform scale applied before rotation
  rot:   optional euler XYZ degrees
  pos:   center position [x, y, z]
  mat:   material key

Conventions: meters, Y up, weapons point down -Z (glTF forward),
origin at grip/floor so models drop into Three.js unchanged.
"""

MATERIALS = {
    "gunmetal":  {"color": "#2B2F3A", "metallic": 0.8, "roughness": 0.45},
    "steel":     {"color": "#A9B2BD", "metallic": 0.9, "roughness": 0.35},
    "teal":      {"color": "#33C6B5", "metallic": 0.2, "roughness": 0.6},
    "orange":    {"color": "#E1523D", "metallic": 0.1, "roughness": 0.7},
    "grip":      {"color": "#1B1E26", "metallic": 0.0, "roughness": 0.9},
    "wood":      {"color": "#8A6A45", "metallic": 0.0, "roughness": 0.85},
    "wood_dark": {"color": "#4A3826", "metallic": 0.0, "roughness": 0.85},
    "drum":      {"color": "#5A6B7A", "metallic": 0.6, "roughness": 0.5},
    "drum_rim":  {"color": "#39434E", "metallic": 0.7, "roughness": 0.45},
    "wall":      {"color": "#B8B2A6", "metallic": 0.0, "roughness": 0.95},
    "wall_trim": {"color": "#6E6659", "metallic": 0.0, "roughness": 0.9},
    "spike":     {"color": "#23262E", "metallic": 0.5, "roughness": 0.5},
    "glow_red":  {"color": "#FF3B30", "emissive": "#FF3B30", "metallic": 0.0, "roughness": 0.4},
    "glow_teal": {"color": "#33C6B5", "emissive": "#1EA897", "metallic": 0.0, "roughness": 0.4},
}


def _b(name, size, pos, mat, rot=None, scale=None):
    p = {"type": "box", "name": name, "size": size, "pos": pos, "mat": mat}
    if rot: p["rot"] = rot
    if scale: p["scale"] = scale
    return p


def _c(name, r, h, pos, mat, rot=None, scale=None, sections=12, kind="cyl"):
    p = {"type": kind, "name": name, "size": [r, h], "pos": pos, "mat": mat,
         "sections": sections}
    if rot: p["rot"] = rot
    if scale: p["scale"] = scale
    return p


def _s(name, r, pos, mat, scale=None):
    p = {"type": "sphere", "name": name, "size": [r], "pos": pos, "mat": mat}
    if scale: p["scale"] = scale
    return p


# --------------------------------------------------------------------------- weapons

RIFLE = [  # ~0.88 m, Vandal-class analog
    _b("receiver",  [0.062, 0.085, 0.34], [0, 0.02, 0.02], "gunmetal"),
    _b("rail",      [0.03, 0.018, 0.30], [0, 0.072, 0.00], "grip"),
    _b("handguard", [0.055, 0.055, 0.24], [0, 0.025, -0.27], "grip"),
    _c("barrel",    0.013, 0.26, [0, 0.03, -0.50], "steel", rot=[90, 0, 0]),
    _c("muzzle",    0.019, 0.055, [0, 0.03, -0.615], "gunmetal", rot=[90, 0, 0], sections=8),
    _b("front_sight", [0.012, 0.045, 0.02], [0, 0.075, -0.36], "gunmetal"),
    _b("rear_sight",  [0.03, 0.025, 0.02], [0, 0.09, 0.10], "gunmetal"),
    _b("mag",       [0.032, 0.15, 0.065], [0, -0.09, -0.045], "teal", rot=[-12, 0, 0]),
    _b("grip",      [0.032, 0.10, 0.045], [0, -0.075, 0.115], "grip", rot=[15, 0, 0]),
    _b("stock",     [0.045, 0.062, 0.20], [0, 0.005, 0.28], "gunmetal"),
    _b("buttplate", [0.05, 0.10, 0.03], [0, -0.005, 0.385], "grip"),
    _b("accent",    [0.064, 0.02, 0.12], [0, 0.045, -0.05], "teal"),
    _b("eject",     [0.066, 0.03, 0.07], [0, 0.03, 0.05], "steel"),
]

PISTOL = [  # ~0.23 m
    _b("slide",     [0.028, 0.034, 0.185], [0, 0.055, -0.03], "steel"),
    _b("slide_top", [0.02, 0.012, 0.185], [0, 0.078, -0.03], "gunmetal"),
    _c("barrel",    0.008, 0.02, [0, 0.055, -0.132], "gunmetal", rot=[90, 0, 0], sections=8),
    _b("frame",     [0.026, 0.022, 0.15], [0, 0.028, -0.02], "gunmetal"),
    _b("grip",      [0.028, 0.095, 0.042], [0, -0.028, 0.035], "grip", rot=[18, 0, 0]),
    _b("guard_f",   [0.008, 0.032, 0.006], [0, -0.002, -0.052], "gunmetal"),
    _b("guard_b",   [0.008, 0.006, 0.05], [0, -0.016, -0.028], "gunmetal"),
    _b("trigger",   [0.006, 0.022, 0.008], [0, 0.002, -0.022], "teal", rot=[10, 0, 0]),
    _b("front_sight", [0.006, 0.012, 0.012], [0, 0.088, -0.115], "teal"),
    _b("rear_sight",  [0.02, 0.012, 0.012], [0, 0.088, 0.055], "gunmetal"),
]

SNIPER = [  # ~1.25 m, Operator-class analog
    _b("receiver",  [0.075, 0.095, 0.42], [0, 0.02, 0.03], "gunmetal"),
    _c("barrel",    0.016, 0.52, [0, 0.035, -0.48], "gunmetal", rot=[90, 0, 0]),
    _b("muzzle",    [0.05, 0.05, 0.09], [0, 0.035, -0.75], "steel"),
    _b("shroud",    [0.065, 0.065, 0.18], [0, 0.03, -0.30], "grip"),
    _c("scope",     0.028, 0.28, [0, 0.125, -0.02], "grip", rot=[90, 0, 0]),
    _c("scope_obj", 0.034, 0.05, [0, 0.125, -0.15], "teal", rot=[90, 0, 0], sections=10),
    _c("scope_eye", 0.032, 0.04, [0, 0.125, 0.12], "gunmetal", rot=[90, 0, 0], sections=10),
    _b("mount_f",   [0.02, 0.045, 0.025], [0, 0.085, -0.08], "steel"),
    _b("mount_b",   [0.02, 0.045, 0.025], [0, 0.085, 0.05], "steel"),
    _b("mag",       [0.04, 0.11, 0.09], [0, -0.075, -0.02], "teal", rot=[-8, 0, 0]),
    _b("grip",      [0.034, 0.105, 0.05], [0, -0.075, 0.14], "grip", rot=[16, 0, 0]),
    _b("stock",     [0.05, 0.075, 0.26], [0, 0.0, 0.36], "gunmetal"),
    _b("cheek",     [0.052, 0.03, 0.14], [0, 0.06, 0.37], "orange"),
    _b("buttplate", [0.055, 0.12, 0.03], [0, -0.01, 0.50], "grip"),
    _c("bipod_l",   0.006, 0.16, [-0.045, -0.06, -0.55], "steel", rot=[0, 0, 25]),
    _c("bipod_r",   0.006, 0.16, [0.045, -0.06, -0.55], "steel", rot=[0, 0, -25]),
    _b("bolt",      [0.05, 0.014, 0.014], [0.05, 0.055, 0.12], "steel", rot=[0, 0, -30]),
]

KNIFE = [  # ~0.31 m
    _b("blade",     [0.005, 0.032, 0.13], [0, 0.004, -0.115], "steel"),
    _c("blade_tip", 0.016, 0.05, [0, 0.004, -0.205], "steel",
       rot=[90, 0, 0], scale=[0.16, 1.0, 1.0], sections=4, kind="cone"),
    _b("edge",      [0.003, 0.008, 0.13], [0, -0.014, -0.115], "teal"),
    _b("guard",     [0.014, 0.05, 0.012], [0, 0.0, -0.048], "gunmetal"),
    _b("handle",    [0.018, 0.028, 0.105], [0, -0.002, 0.012], "grip", rot=[-4, 0, 0]),
    _b("pommel",    [0.02, 0.032, 0.018], [0, -0.006, 0.07], "gunmetal"),
]

# ----------------------------------------------------------------------------- props

def _crate_edges():
    t, h = 0.09, 1.0
    e = []
    for i, (x, y) in enumerate([(-1, -1), (-1, 1), (1, -1), (1, 1)]):
        e.append(_b(f"edge_z{i}", [t, t, h], [x * (h - t) / 2, y * (h - t) / 2 + h / 2, 0], "wood_dark"))
        e.append(_b(f"edge_x{i}", [h, t, t], [0, y * (h - t) / 2 + h / 2, x * (h - t) / 2], "wood_dark"))
        e.append(_b(f"edge_y{i}", [t, h, t], [x * (h - t) / 2, h / 2, y * (h - t) / 2], "wood_dark"))
    return e

CRATE = [  # 1 m cube, origin at floor
    _b("body", [0.96, 0.96, 0.96], [0, 0.5, 0], "wood"),
    _b("cross_f", [1.22, 0.07, 0.05], [0, 0.5, 0.475], "wood_dark", rot=[0, 0, 45]),
    _b("cross_b", [1.22, 0.07, 0.05], [0, 0.5, -0.475], "wood_dark", rot=[0, 0, -45]),
] + _crate_edges()

BARREL = [  # 0.9 m tall, origin at floor
    _c("body", 0.30, 0.86, [0, 0.45, 0], "drum", sections=14),
    _c("rim_t", 0.315, 0.05, [0, 0.82, 0], "drum_rim", sections=14),
    _c("rim_m", 0.315, 0.05, [0, 0.45, 0], "drum_rim", sections=14),
    _c("rim_b", 0.315, 0.05, [0, 0.08, 0], "drum_rim", sections=14),
    _c("lid",   0.26, 0.03, [0, 0.885, 0], "drum_rim", sections=14),
    _b("hazard", [0.46, 0.14, 0.46], [0, 0.62, 0], "orange", rot=[0, 22.5, 0]),
]

WALL = [  # modular 3 x 2.5 x 0.2 segment, origin at floor center
    _b("body",   [3.0, 2.5, 0.20], [0, 1.25, 0], "wall"),
    _b("base",   [3.0, 0.22, 0.26], [0, 0.11, 0], "wall_trim"),
    _b("cap",    [3.0, 0.12, 0.26], [0, 2.44, 0], "wall_trim"),
    _b("stripe", [3.0, 0.10, 0.21], [0, 1.9, 0], "teal"),
    _b("pill_l", [0.18, 2.5, 0.26], [-1.41, 1.25, 0], "wall_trim"),
    _b("pill_r", [0.18, 2.5, 0.26], [1.41, 1.25, 0], "wall_trim"),
]

def _spike_fins():
    import math
    fins = []
    for i in range(3):
        a = i * 120.0
        r = math.radians(a)
        x, z = 0.125 * math.sin(r), 0.125 * math.cos(r)
        fins.append(_b(f"fin_{i}", [0.016, 0.36, 0.055], [x, 0.19, z], "spike", rot=[0, a, 0]))
        fins.append(_b(f"fin_glow_{i}", [0.02, 0.18, 0.022], [x, 0.17, z], "glow_teal", rot=[0, a, 0]))
    return fins

SPIKE = [  # ~0.42 m tall, origin at floor
    _c("core", 0.085, 0.30, [0, 0.17, 0], "spike", sections=10),
    _s("dome", 0.085, [0, 0.32, 0], "spike", scale=[1, 0.7, 1]),
    _c("base", 0.11, 0.05, [0, 0.025, 0], "spike", sections=10),
    _c("ring", 0.092, 0.03, [0, 0.30, 0], "glow_red", sections=10),
    _s("beacon", 0.028, [0, 0.40, 0], "glow_red"),
] + _spike_fins()

MODELS = {
    "weapon_rifle": RIFLE,
    "weapon_pistol": PISTOL,
    "weapon_sniper": SNIPER,
    "weapon_knife": KNIFE,
    "prop_crate": CRATE,
    "prop_barrel": BARREL,
    "prop_wall": WALL,
    "prop_spike": SPIKE,
}
