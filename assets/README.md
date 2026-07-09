# Assets (v2 — mid-poly, Blender-authored)

Valorant-style original designs (see PLAN.md IP note). Source of truth:
**`assets/blender/assets_v2.blend`** — open in Blender, every model is a collection.

## Models (`assets/models/*.glb`)

| File | Contents | Tris | Size |
|---|---|---|---|
| weapon_rifle.glb | Vandal-class rifle — curved mag, rail, vents, skeleton stock | 4.2k | 287 KB |
| weapon_pistol.glb | Ghost-class sidearm — serrations, accent slide plate | 2.3k | 161 KB |
| weapon_sniper.glb | Operator-class — scope w/ lens glow, muzzle brake, bolt, bipod | 3.8k | 237 KB |
| weapon_knife.glb | Tanto knife — emissive edge | 1.0k | 70 KB |
| prop_crate.glb | 1 m metal crate, framed panels + teal stripes | 1.8k | 129 KB |
| prop_barrel.glb | 0.9 m drum, hazard band | 1.2k | 39 KB |
| prop_wall.glb | 3 × 2.5 m paneled wall segment | 1.0k | 70 KB |
| prop_spike.glb | Spike — opened petals, emissive red core/beacon | 1.4k | 71 KB |
| agent_placeholder.glb | Humanoid, 18-bone rig, rigid-skinned, armor + glow visor | 3.3k | 370 KB |
| viewmodel_arms.glb | FP arms in camera space (origin = camera, -Z forward) | 0.9k | 62 KB |
| agent_zephyr.glb | **Zephyr** (Duelist, agentId 0) hero model — organic body, vest, scarf, mask + glow visor; 18-bone rig, vertex-AO (COLOR_0) | ~15k | 1.3 MB |
| viewmodel_zephyr.glb | Zephyr FP arms — wraps, teal cuffs; clips: equip / reload / inspect | 2.6k | 307 KB |
| map_crossing.glb | Crossing visual mesh from sim `LEVEL_BOXES` + baked vertex AO (collision stays in sim) | — | 826 KB |

Total still well inside the <60 MB budget. Client loads these via `packages/client/src/assets.ts`
(async swap over procedural placeholders; `vertexColors: true` forced for COLOR_0 AO).

Conventions: meters, Y-up, weapons point down **-Z** (muzzle -Z), weapon origin ≈ grip,
prop origin at floor, character faces -Z. PBR flat-color materials (`v2_*` / `ag_zephyr_*`),
no external textures in-game (atlas bake abandoned for vertex AO). Emissive parts (spike core,
visor, scope lens, knife edge) use `emissiveFactor`. Retint accent materials per team IFF.

Agent rig: root → hips → spine → chest → neck → head; upper_arm/forearm/hand,
thigh/shin/foot with .L/.R suffixes (Mixamo-style). Body walk is client procedural bone pose;
viewmodel_zephyr carries equip/reload/inspect clips.

Previews: `assets/models/previews/` (`contact_sheet.png` shows everything).

## Editing

Open `assets/blender/assets_v2.blend`, edit, re-export selection as glTF (Y-up).
The v1 spec pipeline (`tools/modelgen/`, `assets/blender/build_from_spec.py`) is kept
for quick greybox placeholders but no longer matches the shipped v2 assets.
