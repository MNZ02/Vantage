// M5: articulated low-poly procedural humanoid replacing render.ts's
// capsule-proxy remote-player mesh. REAL-ASSET SWAP POINT: a future
// commissioned character model + animation rig would replace this file's
// buildRig()/applyPose() wholesale — the PlayerModelHandle contract
// (group/setPose/dispose) is deliberately the same shape the old capsule
// proxy exposed, so render.ts/main.ts don't need to change at the call site.
import * as THREE from "three";
import { CROUCH_HEIGHT, STAND_HEIGHT, CAPSULE_RADIUS } from "@vg/sim";
import { weaponClassFor, type WeaponClass } from "./viewmodel.js";

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

export function createPlayerModel(scene: THREE.Scene): PlayerModelHandle {
  const group = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: NEUTRAL_BASE, roughness: 0.8, transparent: true });
  const limbMat = new THREE.MeshStandardMaterial({ color: darken(NEUTRAL_BASE, 0.35), roughness: 0.8, transparent: true });
  const weaponMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, transparent: true });
  const materials = [bodyMat, limbMat, weaponMat];

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

  const weaponBox = mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), weaponMat);

  scene.add(group);

  let deathStartSeconds: number | null = null;
  let currentWeaponClass: WeaponClass | null = null;

  const weaponLengthByClass: Record<WeaponClass, number> = { pistol: 0.16, smg: 0.28, rifle: 0.42, sniper: 0.55 };

  function setLegGeometry(legMesh: THREE.Mesh, length: number, width: number, depth: number): void {
    legMesh.geometry.dispose();
    legMesh.geometry = new THREE.BoxGeometry(width, length, depth);
  }

  return {
    group,
    setPose(pose: PlayerModelPose) {
      group.visible = pose.connected;
      if (!pose.connected) return;

      group.position.set(pose.posX, pose.posY, pose.posZ);
      group.rotation.set(0, pose.yaw + Math.PI, 0);

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

      // ---- Stand/crouch rig heights ----
      const { legHeight, torsoHeight } = computeRigHeights(pose.crouching);
      const halfLeg = legHeight / 2;
      pelvis.position.set(0, legHeight, 0);
      torso.position.set(0, legHeight + torsoHeight / 2, 0);
      head.position.set(0, legHeight + torsoHeight + HEAD_DIAMETER / 2, 0);

      const shoulderY = legHeight + torsoHeight - 0.05;

      // ---- Walk cycle: swing amplitude from horizontal speed, phase from
      // distance traveled (spec) — silent/near-static when barely moving. ----
      const speedFrac = Math.min(1, pose.horizontalSpeed / 6.75); // RUN_SPEED-ish normalization for a full swing at a sprint
      const phase = pose.distanceTraveled * 2.4;
      const swing = pose.grounded ? Math.sin(phase) * 0.6 * speedFrac : 0;
      const swingOpp = pose.grounded ? Math.sin(phase + Math.PI) * 0.6 * speedFrac : 0;
      const airTuck = pose.grounded ? 0 : 0.35;

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

      // ---- Weapon box in right hand, sized per weapon class ----
      const cls = weaponClassFor(pose.weaponId);
      if (cls !== currentWeaponClass) {
        weaponBox.geometry.dispose();
        weaponBox.geometry = new THREE.BoxGeometry(0.06, 0.06, weaponLengthByClass[cls]);
        currentWeaponClass = cls;
      }
      weaponBox.position.set(ARM_X_OFFSET + 0.05, shoulderY - 0.14 - 0.3, -weaponLengthByClass[cls] / 2 + 0.05);
    },
    dispose(targetScene: THREE.Scene) {
      targetScene.remove(group);
      for (const m of group.children) {
        if (m instanceof THREE.Mesh) m.geometry.dispose();
      }
      bodyMat.dispose();
      limbMat.dispose();
      weaponMat.dispose();
    },
  };
}
