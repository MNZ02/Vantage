// M5: articulated low-poly procedural humanoid replacing render.ts's
// capsule-proxy remote-player mesh. REAL-ASSET SWAP POINT: a future
// commissioned character model + animation rig would replace this file's
// buildRig()/applyPose() wholesale — the PlayerModelHandle contract
// (group/setPose/dispose) is deliberately the same shape the old capsule
// proxy exposed, so render.ts/main.ts don't need to change at the call site.
import * as THREE from "three";
import { AGENT_ZEPHYR, CROUCH_HEIGHT, STAND_HEIGHT, CAPSULE_RADIUS } from "@vg/sim";
import { MODEL_FOR_CLASS, weaponClassFor, type WeaponClass } from "./viewmodel.js";
import { cloneModel, cloneSkinnedModel, getLoadedModel, loadModel, type ModelName } from "./assets.js";

// ---- Pure rig-height math (spec acceptance criterion: "standing/crouch
// model bounds within 10% of capsule dims" — verified directly here, and
// again against the real built mesh's THREE.Box3 in tests). ----
const TORSO_HEIGHT = 0.6;
const HEAD_DIAMETER = 0.3;
const STAND_LEG_HEIGHT = STAND_HEIGHT - TORSO_HEIGHT - HEAD_DIAMETER; // 0.9
const CROUCH_LEG_HEIGHT = CROUCH_HEIGHT - TORSO_HEIGHT - HEAD_DIAMETER; // 0.4

export interface RigHeights {
  legHeight: number;
  torsoHeight: number;
  headDiameter: number;
  totalHeight: number;
}

export function computeRigHeights(crouching: boolean): RigHeights {
  const legHeight = crouching ? CROUCH_LEG_HEIGHT : STAND_LEG_HEIGHT;
  return { legHeight, torsoHeight: TORSO_HEIGHT, headDiameter: HEAD_DIAMETER, totalHeight: legHeight + TORSO_HEIGHT + HEAD_DIAMETER };
}

// Shoulder/arm layout, meters — chosen so overall model width (torso + arms
// hanging at the sides) lands within 10% of the capsule diameter (2 *
// CAPSULE_RADIUS = 0.8 m); see playerModel-dimensions.test.ts.
const TORSO_HALF_WIDTH = 0.25;
const ARM_HALF_WIDTH = 0.06;
const ARM_X_OFFSET = TORSO_HALF_WIDTH + ARM_HALF_WIDTH;

// ---- Color helpers (pure, small) ----
function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function blendColors(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = clamp255(ar + (br - ar) * t);
  const g = clamp255(ag + (bg - ag) * t);
  const bch = clamp255(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bch;
}

function darken(color: number, amount: number): number {
  return blendColors(color, 0x000000, amount);
}

const ATTACKER_BASE = 0xb08a5a; // sand/terracotta
const DEFENDER_BASE = 0x4a7a82; // teal/slate
const NEUTRAL_BASE = 0x7a7a7a;
const ALLY_TINT = 0x3fa7ff;
const ENEMY_TINT = 0xff3b3b;

/** Body/limb colors: primarily team-driven (attacker warm / defender cool), with an ally/enemy tint blended in so the existing minimap ally-blue/enemy-red language still reads at a glance. */
export function playerModelColors(team: number, isAlly: boolean): { body: number; limbs: number } {
  const base = team === 0 ? ATTACKER_BASE : team === 1 ? DEFENDER_BASE : NEUTRAL_BASE;
  const body = blendColors(base, isAlly ? ALLY_TINT : ENEMY_TINT, 0.3);
  return { body, limbs: darken(body, 0.35) };
}

export interface PlayerModelPose {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  crouching: boolean;
  grounded: boolean;
  connected: boolean;
  alive: boolean;
  team: number;
  isAlly: boolean;
  /** AGENT_ZEPHYR(0) renders the Zephyr hero model; anything else falls back to the generic placeholder rig. */
  agentId: number;
  weaponId: number;
  /** Horizontal speed, m/s — drives the walk-cycle swing amplitude. */
  horizontalSpeed: number;
  /** Monotonically-increasing distance traveled, m — drives walk-cycle phase (spec: "phase from distance traveled"). */
  distanceTraveled: number;
  /** Wall-clock seconds, for the death-fade timer. */
  nowSeconds: number;
}

export interface PlayerModelHandle {
  group: THREE.Group;
  setPose(pose: PlayerModelPose): void;
  dispose(scene: THREE.Scene): void;
}

interface Part {
  mesh: THREE.Mesh;
  /** Rest-local position, re-applied each frame before pose offsets. */
  restY: number;
}

const DEATH_FADE_SECONDS = 2;

// ---- Authored agent rigs ----
// Which authored skinned model represents a given agentId (Zephyr has a bespoke
// hero model; every other agent falls back to the generic placeholder rig).
// Both share the identical 18-bone rig, so the bone-driving code is agnostic.
function agentModelFor(agentId: number): ModelName {
  return agentId === AGENT_ZEPHYR ? "agent_zephyr" : "agent";
}

// Measured standing height of each skinned mesh (feet ≈ y0 to head top);
// the rig is scaled so this matches the sim capsule's STAND_HEIGHT.
const AGENT_MODEL_HEIGHT: Record<ModelName & ("agent" | "agent_zephyr"), number> = {
  agent: 1.745,
  agent_zephyr: 1.8,
};

// Accent material names (per model) retinted to the ally/enemy color for IFF.
// Includes the v2 placeholder accents, viewmodel-style v2_z_*, and the
// agent_zephyr hero materials (ag_zephyr_accent / ag_zephyr_glow).
const ACCENT_MATERIAL_NAMES = new Set([
  "v2_teal",
  "v2_glow_teal",
  "v2_z_teal",
  "v2_z_glow",
  "ag_zephyr_accent",
  "ag_zephyr_glow",
]);
// Rig bones carry a ~180°-about-X rest rotation, so their local X axis aligns
// with world X — the walk-cycle swing (and crouch knee-bend) is a delta about
// this axis applied on top of each bone's captured rest quaternion.
const BONE_X = new THREE.Vector3(1, 0, 0);
// Crouch pose tuning (radians / meters), applied ×crouchAmount. Bending the
// knees lifts the feet, so the wrapper drops by ~the same amount to keep the
// feet planted (cheap stand-in for 2-bone IK).
const CROUCH_THIGH = 0.9;
const CROUCH_SHIN = -1.5;
const CROUCH_HIP_DROP = 0.5;

interface AgentRig {
  modelName: ModelName;
  wrapper: THREE.Group;
  thighL: THREE.Object3D;
  thighR: THREE.Object3D;
  shinL: THREE.Object3D;
  shinR: THREE.Object3D;
  upperArmL: THREE.Object3D;
  upperArmR: THREE.Object3D;
  rest: Map<THREE.Object3D, THREE.Quaternion>;
  accentMats: THREE.MeshStandardMaterial[];
  glbMaterials: THREE.Material[];
}

/** Rotate `bone` to its rest orientation plus `angle` radians about world/local X. */
function poseBone(rig: AgentRig, bone: THREE.Object3D, angle: number, scratch: THREE.Quaternion): void {
  const restQ = rig.rest.get(bone)!;
  bone.quaternion.copy(restQ).multiply(scratch.setFromAxisAngle(BONE_X, angle));
}

export function createPlayerModel(scene: THREE.Scene): PlayerModelHandle {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: NEUTRAL_BASE, roughness: 0.8, transparent: true });
  const limbMat = new THREE.MeshStandardMaterial({ color: darken(NEUTRAL_BASE, 0.35), roughness: 0.8, transparent: true });
  const weaponMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, transparent: true });
  // Mutable: the held weapon's .glb materials are appended per class swap so
  // the death fade below dims them along with the body/limb materials.
  const materials: THREE.Material[] = [bodyMat, limbMat, weaponMat];

  function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    group.add(m);
    return m;
  }

  const head = mesh(new THREE.SphereGeometry(HEAD_DIAMETER / 2, 10, 8), bodyMat);
  const torso = mesh(new THREE.BoxGeometry(TORSO_HALF_WIDTH * 2, TORSO_HEIGHT, 0.28), bodyMat);
  const pelvis = mesh(new THREE.BoxGeometry(TORSO_HALF_WIDTH * 1.8, 0.14, 0.24), bodyMat);

  const upperArmL = mesh(new THREE.BoxGeometry(ARM_HALF_WIDTH * 2, 0.28, 0.14), limbMat);
  const lowerArmL = mesh(new THREE.BoxGeometry(ARM_HALF_WIDTH * 1.8, 0.26, 0.13), limbMat);
  const upperArmR = mesh(new THREE.BoxGeometry(ARM_HALF_WIDTH * 2, 0.28, 0.14), limbMat);
  const lowerArmR = mesh(new THREE.BoxGeometry(ARM_HALF_WIDTH * 1.8, 0.26, 0.13), limbMat);

  const upperLegL = mesh(new THREE.BoxGeometry(0.16, 0.01, 0.16), limbMat); // heights set per-pose (leg length varies stand/crouch)
  const lowerLegL = mesh(new THREE.BoxGeometry(0.14, 0.01, 0.14), limbMat);
  const upperLegR = mesh(new THREE.BoxGeometry(0.16, 0.01, 0.16), limbMat);
  const lowerLegR = mesh(new THREE.BoxGeometry(0.14, 0.01, 0.14), limbMat);

  // All the procedural body boxes above are the instant placeholder + the
  // permanent fallback. Once the authored agent rig (agent_placeholder.glb)
  // loads, these are hidden and the skinned mesh is driven instead (see
  // AgentRig / poseRig below).
  const proceduralBodyMeshes = [head, torso, pelvis, upperArmL, lowerArmL, upperArmR, lowerArmR, upperLegL, lowerLegL, upperLegR, lowerLegR];

  // Held weapon: a holder group positioned at the right hand. Starts as the
  // procedural box; swaps to the authored .glb (assets/models) once loaded —
  // getLoadedModel is probed on class change and per-frame until it hits, so
  // the swap happens whenever the async load lands. The .glb's materials are
  // cloned per player (cloneModel(…, true)) and appended to `materials` so
  // the death fade dims the gun with the body.
  const weaponHolder = new THREE.Group();
  group.add(weaponHolder);
  const weaponBox = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), weaponMat);
  weaponHolder.add(weaponBox);
  let weaponIsGlb = false;
  let weaponGlbMaterials: THREE.Material[] = [];

  scene.add(group);

  let deathStartSeconds: number | null = null;
  let currentWeaponClass: WeaponClass | null = null;

  // ---- Agent rig: null until the agent's .glb loads, then built and driven
  // per-frame in place of the procedural boxes. The model is chosen by the
  // pose's agentId (Zephyr vs generic placeholder) and rebuilt if it changes. ----
  let rig: AgentRig | null = null;
  const scratchQ = new THREE.Quaternion();

  function findBone(rootObj: THREE.Object3D, name: string): THREE.Object3D {
    const found = rootObj.getObjectByName(name);
    if (!found) throw new Error(`agent rig: missing bone "${name}"`);
    return found;
  }

  function disposeRig(old: AgentRig): void {
    group.remove(old.wrapper);
    for (const m of old.glbMaterials) {
      const idx = materials.indexOf(m);
      if (idx >= 0) materials.splice(idx, 1);
      m.dispose(); // geometry stays shared with the cached master; only per-instance materials are ours
    }
  }

  function buildRig(modelName: ModelName, master: THREE.Object3D): void {
    if (rig) disposeRig(rig);
    const { root, materials: glbMats } = cloneSkinnedModel(master);
    const wrapper = new THREE.Group();
    wrapper.scale.setScalar(STAND_HEIGHT / AGENT_MODEL_HEIGHT[modelName as "agent" | "agent_zephyr"]);
    wrapper.add(root);
    group.add(wrapper);
    for (const mesh of proceduralBodyMeshes) mesh.visible = false; // rig takes over the body; weaponHolder stays

    const bones: THREE.Object3D[] = [];
    const pick = (name: string): THREE.Object3D => {
      const b = findBone(root, name);
      bones.push(b);
      return b;
    };
    // GLTFLoader sanitizes node names (THREE.PropertyBinding.sanitizeNodeName
    // strips "." etc.), so the authored "thigh.L" loads as "thighL".
    const built: AgentRig = {
      modelName,
      wrapper,
      thighL: pick("thighL"),
      thighR: pick("thighR"),
      shinL: pick("shinL"),
      shinR: pick("shinR"),
      upperArmL: pick("upper_armL"),
      upperArmR: pick("upper_armR"),
      rest: new Map(bones.map((b) => [b, b.quaternion.clone()])),
      accentMats: glbMats.filter(
        (mtl): mtl is THREE.MeshStandardMaterial => mtl instanceof THREE.MeshStandardMaterial && ACCENT_MATERIAL_NAMES.has(mtl.name),
      ),
      glbMaterials: glbMats,
    };
    materials.push(...glbMats); // so the death fade dims the whole agent
    rig = built;
  }

  /** Ensures the rig matches `agentId`'s model — kicks the async load and (re)builds when the master is ready. */
  function syncRig(agentId: number): void {
    const desired = agentModelFor(agentId);
    if (rig && rig.modelName === desired) return;
    const master = getLoadedModel(desired);
    if (master) buildRig(desired, master);
    else void loadModel(desired); // per-frame probe rebuilds when it lands
  }

  const weaponLengthByClass: Record<WeaponClass, number> = { pistol: 0.16, smg: 0.28, rifle: 0.42, sniper: 0.55, knife: 0.2 };

  function setLegGeometry(legMesh: THREE.Mesh, length: number, width: number, depth: number): void {
    legMesh.geometry.dispose();
    legMesh.geometry = new THREE.BoxGeometry(width, length, depth);
  }

  /**
   * Drives the loaded rig from the same walk-cycle inputs as the procedural
   * boxes: legs swing in anti-phase, arms counter the legs, knees bend for
   * crouch (wrapper drops to keep feet planted), and the teal accent
   * materials retint to the ally/enemy color for at-a-glance IFF.
   */
  function poseRig(
    r: AgentRig,
    swing: number,
    swingOpp: number,
    airTuck: number,
    crouchAmount: number,
    accent: number,
  ): void {
    poseBone(r, r.thighL, swing - airTuck + CROUCH_THIGH * crouchAmount, scratchQ);
    poseBone(r, r.thighR, swingOpp - airTuck + CROUCH_THIGH * crouchAmount, scratchQ);
    poseBone(r, r.shinL, CROUCH_SHIN * crouchAmount, scratchQ);
    poseBone(r, r.shinR, CROUCH_SHIN * crouchAmount, scratchQ);
    poseBone(r, r.upperArmL, swingOpp * 0.5, scratchQ);
    poseBone(r, r.upperArmR, swing * 0.5, scratchQ);
    r.wrapper.position.y = -CROUCH_HIP_DROP * crouchAmount;
    for (const mtl of r.accentMats) mtl.color.setHex(accent);
  }

  return {
    group,
    setPose(pose: PlayerModelPose) {
      group.visible = pose.connected;
      if (!pose.connected) return;

      group.position.set(pose.posX, pose.posY, pose.posZ);
      group.rotation.set(0, pose.yaw + Math.PI, 0);

      // Swap to (or between) the authored rig(s) as the agentId's .glb loads.
      syncRig(pose.agentId);

      const colors = playerModelColors(pose.team, pose.isAlly);
      bodyMat.color.setHex(colors.body);
      limbMat.color.setHex(colors.limbs);

      // ---- Death: ragdoll-lite (topple + fade over 2s), tracked once per death. ----
      if (!pose.alive) {
        if (deathStartSeconds === null) deathStartSeconds = pose.nowSeconds;
        const elapsed = pose.nowSeconds - deathStartSeconds;
        const toppleT = Math.min(1, elapsed / 0.35);
        group.rotation.x = (Math.PI / 2) * toppleT;
        const fadeT = Math.max(0, Math.min(1, elapsed / DEATH_FADE_SECONDS));
        const opacity = 1 - fadeT;
        for (const m of materials) m.opacity = opacity;
        group.visible = opacity > 0.02;
        return;
      }
      deathStartSeconds = null;
      for (const m of materials) m.opacity = 1;

      // ---- Walk cycle: swing amplitude from horizontal speed, phase from
      // distance traveled (spec) — silent/near-static when barely moving.
      // Drives either the procedural boxes or the rig bones (whichever is live). ----
      const speedFrac = Math.min(1, pose.horizontalSpeed / 6.75); // RUN_SPEED-ish normalization for a full swing at a sprint
      const phase = pose.distanceTraveled * 2.4;
      const swing = pose.grounded ? Math.sin(phase) * 0.6 * speedFrac : 0;
      const swingOpp = pose.grounded ? Math.sin(phase + Math.PI) * 0.6 * speedFrac : 0;
      const airTuck = pose.grounded ? 0 : 0.35;

      // Stand/crouch reference heights — drive the box body below and the
      // shared weapon-hand height (the rig is scaled to the same STAND_HEIGHT,
      // so the group-space hand position matches either representation).
      const { legHeight, torsoHeight } = computeRigHeights(pose.crouching);
      const shoulderY = legHeight + torsoHeight - 0.05;

      if (rig) {
        poseRig(rig, swing, swingOpp, airTuck, pose.crouching ? 1 : 0, pose.isAlly ? ALLY_TINT : ENEMY_TINT);
      } else {
        // ---- Procedural box body: stand/crouch heights + swing ----
        const halfLeg = legHeight / 2;
        pelvis.position.set(0, legHeight, 0);
        torso.position.set(0, legHeight + torsoHeight / 2, 0);
        head.position.set(0, legHeight + torsoHeight + HEAD_DIAMETER / 2, 0);

        setLegGeometry(upperLegL, halfLeg, 0.16, 0.16);
        setLegGeometry(lowerLegL, halfLeg, 0.14, 0.14);
        setLegGeometry(upperLegR, halfLeg, 0.16, 0.16);
        setLegGeometry(lowerLegR, halfLeg, 0.14, 0.14);

        upperLegL.position.set(-0.11, legHeight - halfLeg / 2, 0);
        lowerLegL.position.set(-0.11, legHeight - halfLeg - halfLeg / 2, 0);
        upperLegR.position.set(0.11, legHeight - halfLeg / 2, 0);
        lowerLegR.position.set(0.11, legHeight - halfLeg - halfLeg / 2, 0);
        upperLegL.rotation.x = swing - airTuck;
        upperLegR.rotation.x = swingOpp - airTuck;
        lowerLegL.rotation.x = Math.max(0, -swing) * 0.5;
        lowerLegR.rotation.x = Math.max(0, -swingOpp) * 0.5;

        upperArmL.position.set(-ARM_X_OFFSET, shoulderY - 0.14, 0);
        lowerArmL.position.set(-ARM_X_OFFSET, shoulderY - 0.14 - 0.26, 0);
        upperArmR.position.set(ARM_X_OFFSET, shoulderY - 0.14, 0);
        lowerArmR.position.set(ARM_X_OFFSET, shoulderY - 0.14 - 0.26, 0);
        upperArmL.rotation.x = swingOpp * 0.5;
        upperArmR.rotation.x = swing * 0.5;
      }

      // ---- Weapon in right hand: .glb when loaded, sized box until then ----
      const cls = weaponClassFor(pose.weaponId);
      const model = MODEL_FOR_CLASS[cls];
      const master = getLoadedModel(model.name);
      if (cls !== currentWeaponClass || (!weaponIsGlb && master !== null)) {
        for (const m of weaponGlbMaterials) {
          const idx = materials.indexOf(m);
          if (idx >= 0) materials.splice(idx, 1);
          m.dispose();
        }
        weaponGlbMaterials = [];
        weaponHolder.clear();
        if (master) {
          const clone = cloneModel(master, true);
          clone.group.scale.setScalar(model.scale);
          weaponHolder.add(clone.group);
          materials.push(...clone.materials);
          weaponGlbMaterials = clone.materials;
          weaponIsGlb = true;
        } else {
          void loadModel(model.name); // fire the async load; the per-frame probe above swaps it in when ready
          weaponBox.geometry.dispose();
          weaponBox.geometry = new THREE.BoxGeometry(0.06, 0.06, weaponLengthByClass[cls]);
          weaponBox.position.set(0, 0, -weaponLengthByClass[cls] / 2);
          weaponHolder.add(weaponBox);
          weaponIsGlb = false;
        }
        currentWeaponClass = cls;
      }
      // Holder origin = grip position (the .glb origin is at the grip; the box offsets itself to match).
      weaponHolder.position.set(ARM_X_OFFSET + 0.05, shoulderY - 0.14 - 0.3, 0.05);
    },
    dispose(targetScene: THREE.Scene) {
      targetScene.remove(group);
      for (const m of group.children) {
        if (m instanceof THREE.Mesh) m.geometry.dispose();
      }
      // Every entry in `materials` is a per-instance clone (body/limb/weapon
      // procedural + cloned weapon-glb + cloned rig-glb mats) — all owned here,
      // safe to dispose. The rig's skinned geometry is shared with the cached
      // master, so (like the weapon .glb) it is never disposed here.
      for (const m of materials) m.dispose();
    },
  };
}
