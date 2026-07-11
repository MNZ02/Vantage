"""Per-agent build specs (v4). Meters, Blender Z-up, character faces +Y.

ZEPHYR v4 — full redesign (wind duelist): cropped white jacket over a
graphite compression suit, asymmetric left pauldron + bracer, utility belt
with canisters, split tail panel off the belt, high swept ponytail, smooth
masked faceplate with a glowing chevron visor, compact 3-blade wind unit on
the back, teal glow seams. Faces stay fully masked (IP/style constraint).

RECRUIT — the generic placeholder agent (every non-Zephyr agentId): clean
trooper read, full helmet with glow visor, vest, pads. Accent materials keep
the v2_teal / v2_glow_teal names the client retints for ally/enemy IFF.
"""

ZEPHYR = {
    "name": "zephyr",
    "height": 1.72,
    "head_scale": 0.94,
    "max_height": 1.80,          # client AGENT_MODEL_HEIGHT contract (bbox top)
    "tri_budget": 50000,
    "palette": {
        "suit":      ("#2B303B", 0.10, 0.72),
        "jacket":    ("#F2F5F7", 0.05, 0.50),
        "jacket_in": ("#157F74", 0.15, 0.55),
        "pants":     ("#3C4456", 0.08, 0.68),
        "gear":      ("#1C2028", 0.15, 0.65),
        "hair":      ("#EAF0F3", 0.05, 0.35),
        "accent":    ("#2FB7A8", 0.25, 0.50),   # ag_zephyr_accent (IFF retint)
        "glow":      ("#5FF2DE", 0.00, 0.35, "#33E0CC"),  # ag_zephyr_glow
        "metal":     ("#9AA6B2", 0.80, 0.35),
    },
    "gear": [
        # layered shells, inner→outer (region, offset, thick, mat)
        {"region": "pants",  "offset": 0.004, "thick": 0.006, "mat": "pants"},
        {"region": "boots",  "offset": 0.013, "thick": 0.010, "mat": "gear"},
        {"region": "gloves", "offset": 0.008, "thick": 0.007, "mat": "gear"},
        {"region": "jacket", "offset": 0.010, "thick": 0.009, "mat": "jacket"},
        {"region": "mask",   "offset": 0.007, "thick": 0.005, "mat": "gear"},
    ],
    "addons": "zephyr_v4",
}

RECRUIT = {
    "name": "recruit",
    "height": 1.70,
    "head_scale": 1.0,
    "max_height": 1.745,
    "tri_budget": 30000,
    "mat_names": {"accent": "v2_teal", "glow": "v2_glow_teal"},
    "palette": {
        "suit":      ("#4A515C", 0.10, 0.75),
        "jacket":    ("#6E7681", 0.12, 0.60),   # vest
        "jacket_in": ("#3A414C", 0.10, 0.65),
        "pants":     ("#3E444E", 0.08, 0.72),
        "gear":      ("#23272E", 0.15, 0.65),
        "hair":      ("#2E333B", 0.10, 0.60),   # helmet shell
        "accent":    ("#2FB7A8", 0.25, 0.50),   # -> v2_teal
        "glow":      ("#5FF2DE", 0.00, 0.35, "#33E0CC"),  # -> v2_glow_teal
        "metal":     ("#8A94A0", 0.80, 0.40),
    },
    "gear": [
        {"region": "pants",  "offset": 0.004, "thick": 0.006, "mat": "pants"},
        {"region": "boots",  "offset": 0.013, "thick": 0.010, "mat": "gear"},
        {"region": "gloves", "offset": 0.008, "thick": 0.007, "mat": "gear"},
        {"region": "jacket", "offset": 0.012, "thick": 0.010, "mat": "jacket"},
        {"region": "mask",   "offset": 0.007, "thick": 0.005, "mat": "gear"},
        {"region": "helmet", "offset": 0.014, "thick": 0.008, "mat": "hair"},
    ],
    "addons": "recruit",
}

AGENTS = {"zephyr": ZEPHYR, "recruit": RECRUIT}
