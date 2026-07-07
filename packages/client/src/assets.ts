// M5 real-asset loading: the low-poly GLB set authored in assets/models (see
// assets/README.md — spec-driven via tools/modelgen, meters, Y-up, weapons
// point down -Z with the origin at the grip). Loading is async and cached;
// every render-site keeps its existing procedural mesh as the instant
// placeholder AND the permanent fallback if a load fails, so the game never
// renders nothing while (or because) a .glb is unavailable.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

export type ModelName =
  | "weapon_rifle"
  | "weapon_pistol"
  | "weapon_sniper"
  | "weapon_knife"
  | "prop_barrel"
  | "prop_spike"
  | "prop_crate"
  | "prop_wall"
  | "agent"
  | "agent_zephyr"
  | "viewmodel_arms"
  | "viewmodel_zephyr"
  | "map_crossing";

// new URL(..., import.meta.url) so Vite serves the repo-root assets/ dir in
// dev (via /@fs) and fingerprints+bundles the .glb files on build — no
// vite.config publicDir wiring and no copy of the assets into the package.
const MODEL_URLS: Record<ModelName, string> = {
  weapon_rifle: new URL("../../../assets/models/weapon_rifle.glb", import.meta.url).href,
  weapon_pistol: new URL("../../../assets/models/weapon_pistol.glb", import.meta.url).href,
  weapon_sniper: new URL("../../../assets/models/weapon_sniper.glb", import.meta.url).href,
  weapon_knife: new URL("../../../assets/models/weapon_knife.glb", import.meta.url).href,
  prop_barrel: new URL("../../../assets/models/prop_barrel.glb", import.meta.url).href,
  prop_spike: new URL("../../../assets/models/prop_spike.glb", import.meta.url).href,
  prop_crate: new URL("../../../assets/models/prop_crate.glb", import.meta.url).href,
  prop_wall: new URL("../../../assets/models/prop_wall.glb", import.meta.url).href,
  // agent_placeholder.glb: skinned humanoid (18-bone rig). Clone with
  // cloneSkinnedModel below — never cloneModel — so the skeleton is rebound.
  // agent_zephyr.glb: the Zephyr hero (agentId 0), same 18-bone rig, so it
  // drives through the identical bone code — placeholder covers other agents.
  agent: new URL("../../../assets/models/agent_placeholder.glb", import.meta.url).href,
  agent_zephyr: new URL("../../../assets/models/agent_zephyr.glb", import.meta.url).href,
  viewmodel_arms: new URL("../../../assets/models/viewmodel_arms.glb", import.meta.url).href,
  viewmodel_zephyr: new URL("../../../assets/models/viewmodel_zephyr.glb", import.meta.url).href,
  // map_crossing.glb: visual-only level mesh generated from the SAME
  // @vg/sim LEVEL_BOXES that drive collision (tools/mapgen/build_map.py),
  // with baked vertex-color AO. Collision never reads this file.
  map_crossing: new URL("../../../assets/models/map_crossing.glb", import.meta.url).href,
};

const loader = new GLTFLoader();
const pending = new Map<ModelName, Promise<THREE.Group | null>>();
const loaded = new Map<ModelName, THREE.Group>();

/**
 * Loads (once, cached) the named model's master scene graph. Resolves null on
 * failure — callers keep their procedural fallback. Callers must NOT mutate
 * or re-parent the resolved group directly; clone it (cloneModel below).
 */
export function loadModel(name: ModelName): Promise<THREE.Group | null> {
  const existing = pending.get(name);
  if (existing) return existing;
  const promise = new Promise<THREE.Group | null>((resolve) => {
    loader.load(
      MODEL_URLS[name],
      (gltf) => {
        loaded.set(name, gltf.scene);
        resolve(gltf.scene);
      },
      undefined,
      () => {
        // eslint-disable-next-line no-console
        console.warn(`[assets] failed to load ${name} — keeping procedural fallback`);
        resolve(null);
      },
    );
  });
  pending.set(name, promise);
  return promise;
}

/** Synchronous cache probe: the master group if loadModel(name) has already resolved, else null. */
export function getLoadedModel(name: ModelName): THREE.Group | null {
  return loaded.get(name) ?? null;
}

/**
 * Deep-clones a loaded master for placing in the scene. Geometry stays shared
 * (cheap); materials are shared too UNLESS `cloneMaterials` — pass true when
 * the caller needs to animate opacity/emissive per-instance (e.g. the player
 * model's death fade). Returns the cloned materials so callers can register
 * them in whatever fade list they maintain.
 */
export function cloneModel(master: THREE.Group, cloneMaterials = false): { group: THREE.Group; materials: THREE.Material[] } {
  const group = master.clone(true);
  const materials: THREE.Material[] = [];
  if (cloneMaterials) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.material instanceof THREE.Material) {
        const cloned = obj.material.clone();
        cloned.transparent = true;
        obj.material = cloned;
        materials.push(cloned);
      }
    });
  }
  return { group, materials };
}

/**
 * Clones a SKINNED master (the agent rig) — plain Object3D.clone() leaves the
 * cloned SkinnedMesh bound to the master's bones, so every instance would move
 * in lockstep; SkeletonUtils.clone() rebuilds and rebinds a private skeleton.
 * Materials are cloned+made transparent (per-instance death fade), and each
 * cloned SkinnedMesh's frustum culling is disabled so the animated bounds
 * (bones move outside the rest-pose box) never pop the whole model off-screen.
 * Returns the cloned root plus the fresh materials for the caller's fade list.
 */
export function cloneSkinnedModel(master: THREE.Object3D): { root: THREE.Object3D; materials: THREE.Material[] } {
  const root = cloneSkeleton(master);
  const materials: THREE.Material[] = [];
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.frustumCulled = false;
      if (obj.material instanceof THREE.Material) {
        const cloned = obj.material.clone();
        cloned.transparent = true;
        obj.material = cloned;
        materials.push(cloned);
      }
    }
  });
  return { root, materials };
}
