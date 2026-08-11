# Assets (v6 — high-detail, fully regenerable)

Valorant-style original designs (see PLAN.md IP note). Source of truth is now
**the build scripts** — every shipped .glb regenerates headlessly (or via the
Blender MCP session) from `tools/weapongen`, `tools/agentgen`, `tools/mapgen`.

## Compression (`assets/models/compressed/`)

The client loads **Draco-compressed copies** from `assets/models/compressed/`
(16.1 MB → 2.4 MB total; decoder wasm ships in `packages/client/public/draco/`).
The uncompressed exports in `assets/models/` stay canonical — the Python
tooling (`tools/mapgen/check_gameplay_safe.py`, `tools/agentgen/
import_agent.py`) parses raw accessor bufferViews, which Draco removes.

**After ANY Blender re-export, run `pnpm assets:compress`** — otherwise the
client keeps serving the stale compressed copy of the asset you just rebuilt.
`assets/blender/zephyr_v6_build.blend` is the editable Zephyr build session;
`zephyr_v5_backup.blend` preserves the rejected robot-like redesign. The older
`assets_v4_build.blend` and `assets_v2.blend` sessions remain for inspection.

## Models (`assets/models/*.glb`)

| File | Contents | Tris | Size |
|---|---|---|---|
| weapon_rifle.glb | Falcon-class rifle — slotted rails, vented octagon handguard, fluted barrel, ported brake, grooved grip, ribbed curved mag, skeleton stock | 11.7k | 441 KB |
| weapon_pistol.glb | Ghost-class sidearm — slide serrations, ejection port, threaded muzzle, beavertail grip | 3.4k | 130 KB |
| weapon_sniper.glb | Operator-class — glow-lens scope w/ turrets+rings, fluted heavy barrel, big brake, bolt+knob, folded bipod, box mag, adjustable-look stock | 6.8k | 266 KB |
| weapon_knife.glb | Tanto — emissive edge line, fuller, cord-wrapped handle, pommel ring | 2.9k | 84 KB |
| prop_crate/barrel/wall/spike.glb | unchanged v2 props | — | — |
| agent_zephyr.glb | **Zephyr v6** (Duelist, agentId 0) — clean-slate human wind runner: visible expressive face and fitted eyes, swept pearl ponytail, sea-glass sleeveless shell over a petrol compression top, loose tactical trousers, forearm wraps, low runners and two hip streamers; 18-bone rig, vertex-AO COLOR_0, bbox height exactly 1.80 | 50k | ~2.1 MB |
| agent_placeholder.glb | RECRUIT trooper (all other agentIds) — full helmet+faceplate w/ glow visor, vest, pads; same 18-bone rig, vertex AO, height 1.745; accents named v2_teal / v2_glow_teal (client IFF retint) | 30k | 1.4 MB |
| viewmodel_zephyr[_pistol\|_knife\|_sniper].glb | Zephyr FP arms — **real fingered hands**, authored per weapon CLASS: base = rifle/smg (support hand C-clamps the guard), _pistol = two-handed cup grip at the origin, _knife = one-handed hammer grip (no left arm), _sniper = C-clamp dropped to the deeper forend. Gloves w/ knuckle plates, sleeves+wraps; skin: vm_root + vm_l_hand; clips: equip / reload (left hand works the mag, per-pose choreography) / inspect. Client picks by agentId × weaponClassFor() (viewmodel.ts armsModelFor) | 15.6k (knife 7.8k) | 561 KB (knife 285 KB) |
| viewmodel_arms[_pistol\|_knife\|_sniper].glb | same per-class arms, neutral palette (non-Zephyr agents), same clips | 15.6k (knife 7.8k) | 561 KB (knife 285 KB) |
| map_crossing.glb | Crossing visuals from sim `LEVEL_BOXES` + gameplay-safe detail: wainscot/plaster banding, seam fins, skirting, glow toplines, framed crates, step noses, site paint + spawn pads + orb rings, cosmetic skyline outside the perimeter; baked vertex AO (collision stays in sim) | 29k | 1.6 MB |

Conventions: meters, Y-up, weapons point down **-Z** (muzzle -Z), weapon origin ≈ grip,
prop origin at floor, character faces -Z. Flat-color PBR materials, no textures
(vertex-AO in COLOR_0 where noted; client forces `vertexColors: true`).
Emissive parts (visors, sight dots, scope lens, knife edge, glow seams) use
`emissiveFactor`. Agent accent materials are retinted per team IFF by name:
`ag_zephyr_accent` / `ag_zephyr_glow` (Zephyr), `v2_teal` / `v2_glow_teal`
(placeholder + weapons).

Agent rig (client contract, playerModel.ts): root → hips → spine → chest →
neck → head; upper_arm/forearm/hand, thigh/shin/foot with .L/.R. Exported
bbox heights match AGENT_MODEL_HEIGHT exactly (zephyr 1.80, placeholder 1.745).
Viewmodels are authored in anchor space (grip at origin, camera at
(-0.16, +0.13, +0.35) glTF) around the actual v3 rifle; `armsGroup` offset must
stay (0,0,0).

## Regenerating

Blender 5.x (live MCP session or `blender --background --python <script>`):

- Weapons: `tools/weapongen/build_weapons.py` — `build_all(export_glb=True)`
- FP arms: `tools/agentgen/build_viewmodel.py` — `build_variants()` exports all
  8 files (2 palettes × rifle/pistol/knife/sniper poses; POSES dict)
- Agents: `tools/agentgen/build_agent.py` dispatches Zephyr to the clean-slate
  `build_zephyr_scratch.py`; `rig_export.py` fits the shared runtime rig —
  `build("zephyr"); rig_and_export("zephyr")` (and `"recruit"` → agent_placeholder.glb)
- Map: `tools/mapgen/build_map.py` — `build()` (regenerate level_data.json from
  `@vg/sim` first if LEVEL_BOXES changed)

Previews: `assets/models/previews/` (harness studio renders; `tools/agentgen/harness.py`).
