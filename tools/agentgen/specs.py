"""Per-agent build specs (v6). Meters, Blender Z-up, character faces +Y.

ZEPHYR v6 — clean-slate human wind runner built by build_zephyr_scratch.py on
the CC0 realistic female base with fitted eyes: lean athletic proportions,
pearl swept hair and high ponytail, sea-glass sleeveless shell over a petrol
compression top, loose tactical trousers, fingerless wraps, low runners and
two hip streamers. No helmet, faceplate, armor stack, fan pack or robot parts.

RECRUIT — the generic placeholder agent (every non-Zephyr agentId): clean
trooper read, full helmet with glow visor, vest, pads. Accent materials keep
the v2_teal / v2_glow_teal names the client retints for ally/enemy IFF.
"""

ZEPHYR = {
    "name": "zephyr",
    "height": 1.72,
    "head_scale": 0.92,
    "exposed_face": True,
    "builder": "scratch_human",
    "max_height": 1.80,          # client AGENT_MODEL_HEIGHT contract (bbox top)
    "tri_budget": 50000,
    "palette": {
        "suit":      ("#222A36", 0.02, 0.78),
        "jacket":    ("#E9F0EE", 0.00, 0.72),
        "jacket_in": ("#245E61", 0.00, 0.78),
        "pants":     ("#313C4B", 0.02, 0.80),
        "gear":      ("#17212B", 0.04, 0.76),
        "hair":      ("#D7EEE8", 0.00, 0.55),
        "hair_dark": ("#4AAFA7", 0.00, 0.62),
        "skin":      ("#A66F52", 0.00, 0.72),
        "skin_warm": ("#7A4137", 0.00, 0.78),
        "eye":       ("#173238", 0.00, 0.45),
        "eye_white": ("#E8EEE9", 0.00, 0.65),
        "accent":    ("#35BFAE", 0.02, 0.68),   # ag_zephyr_accent (IFF retint)
        "glow":      ("#78E6D5", 0.00, 0.48, "#3ED8C3"),  # ag_zephyr_glow
        "metal":     ("#82969B", 0.35, 0.52),
    },
    "gear": [
        # layered shells, inner→outer (region, offset, thick, mat)
        {"region": "pants",  "offset": 0.004, "thick": 0.006, "mat": "pants"},
        {"region": "boots",  "offset": 0.013, "thick": 0.010, "mat": "gear"},
        {"region": "gloves", "offset": 0.008, "thick": 0.007, "mat": "gear"},
        {"region": "jacket", "offset": 0.010, "thick": 0.009, "mat": "jacket"},
    ],
    "addons": "zephyr_v5",
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
