// M5: procedural first-person viewmodels, replacing render.ts's placeholder
// barrel+body proxy. Real weapon art (baked models/textures) is explicitly
// out of scope for this milestone — REAL-ASSET SWAP POINT: a future pass
// with commissioned weapon models would replace buildWeaponMesh() below
// wholesale, keeping the same WeaponVisualHandle contract (setVisible,
// playRecoilKick, playReload, setAds) so main.ts/render.ts don't need to
// change at the call site.
import * as THREE from "three";
import { WEAPON_LONGBOW, WEAPON_MARSHAL6, WEAPON_VIPER, WEAPON_WASP, getWeaponDef } from "@vg/sim";

export type WeaponClass = "pistol" | "smg" | "rifle" | "sniper";

/** Buckets a weapon id (including the 100+abilityId ult-weapon space) into a silhouette class for viewmodel purposes. */
export function weaponClassFor(weaponId: number): WeaponClass {
  if (weaponId === WEAPON_VIPER || weaponId === WEAPON_MARSHAL6) return "pistol";
  if (weaponId === WEAPON_WASP) return "smg";
  if (weaponId === WEAPON_LONGBOW) return "sniper";
  return "rifle"; // Falcon/Kestrel, and both ult "weapons" (Blades/Rail) default to a rifle-ish silhouette
}

// ---- Recoil spring (pure, testable — spec acceptance criterion: "recoil
// spring returns to rest within 500 ms simulated"). A critically-damped-ish
// 1D damped harmonic oscillator: kick() adds upward/backward velocity, and
// step() integrates it back toward rest each frame. No allocations per step. ----
export interface RecoilSpring {
  offset: number; // current displacement (kick units, applied as rotation/position in the viewmodel)
  velocity: number;
}

const RECOIL_STIFFNESS = 300; // rad/s^2 per unit displacement
const RECOIL_DAMPING = 34; // damping ratio ~0.98 at this stiffness — settles fast without a visible bounce-forever tail

export function createRecoilSpring(): RecoilSpring {
  return { offset: 0, velocity: 0 };
}

/** Adds an instantaneous kick (spec: "recoil kick on predicted shot"). `amount` > 0 kicks the model up/back. */
export function kickRecoilSpring(spring: RecoilSpring, amount: number): void {
  spring.velocity += amount;
}

/** Advances the spring by `dtSeconds` (fixed or variable — safe either way since it's just semi-implicit Euler). */
export function stepRecoilSpring(spring: RecoilSpring, dtSeconds: number): void {
  const accel = -RECOIL_STIFFNESS * spring.offset - RECOIL_DAMPING * spring.velocity;
  spring.velocity += accel * dtSeconds;
  spring.offset += spring.velocity * dtSeconds;
}

// ---- Reload animation (drop-twist-return over the weapon's reloadTicks
// duration) — pure progress->pose math, testable without a renderer. ----
export interface ReloadPose {
  dropY: number; // downward offset, meters
  twist: number; // roll, radians
}

/** `t` in [0,1] = elapsed/reloadTicks. Drops+twists down through the first half, returns through the second. */
export function reloadPoseAt(t: number): ReloadPose {
  const clamped = Math.max(0, Math.min(1, t));
  // Triangular envelope: 0 at start/end, 1 at the midpoint.
  const envelope = clamped < 0.5 ? clamped / 0.5 : (1 - clamped) / 0.5;
  return { dropY: -0.14 * envelope, twist: -0.6 * envelope };
}

// ---- Idle sway / movement bob (pure, driven by wall-clock time + speed) ----
export function idleSwayOffset(timeSeconds: number): { x: number; y: number } {
  return { x: Math.sin(timeSeconds * 1.3) * 0.004, y: Math.sin(timeSeconds * 2.1) * 0.003 };
}

export function movementBobOffset(distanceTraveled: number, speedFrac: number): { x: number; y: number } {
  const bobPhase = distanceTraveled * 3.2;
  return { x: Math.sin(bobPhase) * 0.01 * speedFrac, y: Math.abs(Math.sin(bobPhase * 2)) * 0.012 * speedFrac };
}

// ---- Three.js viewmodel construction (not unit-testable — visual only) ----

function boxMesh(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
}

/** Builds a 3-5 box silhouette per weapon class. Kept dirt cheap (a handful of boxes, one material each). */
function buildWeaponMesh(cls: WeaponClass): THREE.Group {
  const group = new THREE.Group();
  const bodyColor = 0x2b2f36;
  const metalColor = 0x50565f;
  switch (cls) {
    case "pistol": {
      const grip = boxMesh(0.045, 0.11, 0.05, bodyColor);
      grip.position.set(0, -0.05, 0.02);
      const slide = boxMesh(0.04, 0.045, 0.16, metalColor);
      slide.position.set(0, 0.02, -0.05);
      group.add(grip, slide);
      break;
    }
    case "smg": {
      const body = boxMesh(0.05, 0.08, 0.24, bodyColor);
      const mag = boxMesh(0.035, 0.14, 0.045, metalColor);
      mag.position.set(0, -0.1, 0.03);
      const stock = boxMesh(0.04, 0.05, 0.1, bodyColor);
      stock.position.set(0, 0, 0.16);
      const barrel = boxMesh(0.025, 0.025, 0.12, metalColor);
      barrel.position.set(0, 0.01, -0.18);
      group.add(body, mag, stock, barrel);
      break;
    }
    case "rifle": {
      const body = boxMesh(0.05, 0.09, 0.34, bodyColor);
      const mag = boxMesh(0.04, 0.18, 0.05, metalColor);
      mag.position.set(0, -0.13, 0.05);
      const stock = boxMesh(0.045, 0.06, 0.14, bodyColor);
      stock.position.set(0, -0.005, 0.22);
      const barrel = boxMesh(0.025, 0.025, 0.2, metalColor);
      barrel.position.set(0, 0.015, -0.28);
      const sight = boxMesh(0.02, 0.03, 0.06, metalColor);
      sight.position.set(0, 0.06, -0.05);
      group.add(body, mag, stock, barrel, sight);
      break;
    }
    case "sniper": {
      const body = boxMesh(0.055, 0.09, 0.5, bodyColor);
      const barrel = boxMesh(0.03, 0.03, 0.35, metalColor);
      barrel.position.set(0, 0.01, -0.45);
      const scope = boxMesh(0.04, 0.04, 0.22, 0x1c1e22);
      scope.position.set(0, 0.075, -0.1);
      const stock = boxMesh(0.05, 0.07, 0.2, bodyColor);
      stock.position.set(0, -0.01, 0.32);
      const bolt = boxMesh(0.03, 0.025, 0.05, metalColor);
      bolt.position.set(0.04, 0.02, 0.05);
      group.add(body, barrel, scope, stock, bolt);
      break;
    }
  }
  return group;
}

export interface ViewmodelHandle {
  setVisible(v: boolean): void;
  /** Called once per rendered frame with local-player state to drive idle/move/ADS motion. */
  update(info: {
    timeSeconds: number;
    dtSeconds: number;
    weaponId: number;
    horizontalSpeed: number;
    maxSpeed: number;
    distanceTraveled: number;
    ads: boolean;
    adsZoom: number;
    reloadProgress01: number | null; // null when not reloading
    castPulse01: number | null; // null when not casting; 0..1 progress of a brief hand-raise gesture
  }): void;
  /** Predicted-shot recoil kick — called from main.ts's local-fire path. */
  fireKick(weaponId: number): void;
  /** Scope overlay visibility for the Longbow's ADS stages (spec item 5). */
  scope: ScopeOverlay;
}

export interface ScopeOverlay {
  setStage(stage: 0 | 1 | 2): void;
}

/** DOM canvas overlay: dark vignette + crosshair lines for Longbow ADS stage 1/2. Stage 0 = hidden. */
function createScopeOverlay(): ScopeOverlay {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.pointerEvents = "none";
  el.style.zIndex = "17";
  el.style.display = "none";
  el.style.background = "radial-gradient(circle at center, transparent 0%, transparent 30%, rgba(0,0,0,0.92) 62%)";
  const crosshair = document.createElement("div");
  crosshair.style.position = "absolute";
  crosshair.style.top = "50%";
  crosshair.style.left = "50%";
  crosshair.style.transform = "translate(-50%, -50%)";
  crosshair.style.width = "2px";
  crosshair.style.height = "40vh";
  crosshair.style.background = "rgba(0,0,0,0.9)";
  const crosshairH = document.createElement("div");
  crosshairH.style.position = "absolute";
  crosshairH.style.top = "50%";
  crosshairH.style.left = "50%";
  crosshairH.style.transform = "translate(-50%, -50%)";
  crosshairH.style.height = "2px";
  crosshairH.style.width = "40vw";
  crosshairH.style.background = "rgba(0,0,0,0.9)";
  el.append(crosshair, crosshairH);
  document.body.appendChild(el);
  return {
    setStage(stage) {
      el.style.display = stage > 0 ? "block" : "none";
      el.style.opacity = stage === 2 ? "1" : "0.85";
    },
  };
}

const WEAPON_CLASSES: readonly WeaponClass[] = ["pistol", "smg", "rifle", "sniper"];

export function createViewmodel(camera: THREE.PerspectiveCamera): ViewmodelHandle {
  const anchor = new THREE.Group();
  anchor.position.set(0.16, -0.13, -0.35);
  anchor.rotation.y = 0.06;
  camera.add(anchor);

  const meshes = new Map<WeaponClass, THREE.Group>();
  for (const cls of WEAPON_CLASSES) {
    const mesh = buildWeaponMesh(cls);
    mesh.visible = false;
    anchor.add(mesh);
    meshes.set(cls, mesh);
  }
  let currentClass: WeaponClass = "rifle";
  meshes.get(currentClass)!.visible = true;

  const recoil = createRecoilSpring();
  let lastReloadProgress: number | null = null;
  let castPulseHandled = false;
  const scope = createScopeOverlay();

  return {
    setVisible(v: boolean) {
      anchor.visible = v;
    },
    fireKick(weaponId: number) {
      const cls = weaponClassFor(weaponId);
      const kickByClass: Record<WeaponClass, number> = { pistol: 6, smg: 5, rifle: 7, sniper: 14 };
      kickRecoilSpring(recoil, kickByClass[cls]);
    },
    update(info) {
      const cls = weaponClassFor(info.weaponId);
      if (cls !== currentClass) {
        meshes.get(currentClass)!.visible = false;
        meshes.get(cls)!.visible = true;
        currentClass = cls;
      }

      stepRecoilSpring(recoil, Math.max(0, info.dtSeconds));

      const speedFrac = info.maxSpeed > 0 ? Math.min(1, info.horizontalSpeed / info.maxSpeed) : 0;
      const sway = idleSwayOffset(info.timeSeconds);
      const bob = movementBobOffset(info.distanceTraveled, speedFrac);

      let reloadDropY = 0;
      let reloadTwist = 0;
      if (info.reloadProgress01 !== null) {
        const pose = reloadPoseAt(info.reloadProgress01);
        reloadDropY = pose.dropY;
        reloadTwist = pose.twist;
        lastReloadProgress = info.reloadProgress01;
        castPulseHandled = false;
      } else {
        lastReloadProgress = null;
      }

      let castPitch = 0;
      if (info.castPulse01 !== null) {
        const p = Math.max(0, Math.min(1, info.castPulse01));
        const envelope = p < 0.5 ? p / 0.5 : (1 - p) / 0.5;
        castPitch = -0.5 * envelope;
        castPulseHandled = true;
      } else if (castPulseHandled) {
        castPulseHandled = false;
      }

      const adsFrac = info.ads ? 1 : 0;
      const zoomVisualPull = info.ads ? Math.min(0.06, (info.adsZoom - 1) * 0.02) : 0;

      anchor.position.set(
        (1 - adsFrac) * 0.16 + adsFrac * 0.02 + sway.x + bob.x,
        -0.13 + sway.y + bob.y + reloadDropY,
        -0.35 + zoomVisualPull,
      );
      anchor.rotation.set(-recoil.offset * 0.05 + castPitch, 0.06 * (1 - adsFrac), reloadTwist - recoil.offset * 0.02);

      const weapon = getWeaponDef(info.weaponId);
      const isLongbow = weapon?.id === WEAPON_LONGBOW;
      const stage = isLongbow && info.ads ? (info.adsZoom > 3 ? 2 : 1) : 0;
      scope.setStage(stage as 0 | 1 | 2);
    },
    scope,
  };
}
