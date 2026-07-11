// M5: first-person viewmodels. Real weapon models (assets/models/*.glb, see
// assets/README.md) are loaded async via assets.ts and swapped in over the
// procedural box silhouettes below, which remain as the instant placeholder
// and the fallback if a .glb fails to load. The WeaponVisualHandle contract
// (setVisible, fireKick, update, scope) is unchanged, so main.ts/render.ts
// call sites don't care which representation is currently showing.
import * as THREE from "three";
import { ABL_ZEPHYR_BLADES, AGENT_ZEPHYR, WEAPON_LONGBOW, WEAPON_MARSHAL6, WEAPON_VIPER, WEAPON_WASP, abilityWeaponId, getWeaponDef } from "@vg/sim";
import { cloneModel, cloneSkinnedModel, getModelAnimations, loadModel, type ModelName } from "./assets.js";

export type WeaponClass = "pistol" | "smg" | "rifle" | "sniper" | "knife";

/** Buckets a weapon id (including the 100+abilityId ult-weapon space) into a silhouette class for viewmodel purposes. */
export function weaponClassFor(weaponId: number): WeaponClass {
  if (weaponId === WEAPON_VIPER || weaponId === WEAPON_MARSHAL6) return "pistol";
  if (weaponId === WEAPON_WASP) return "smg";
  if (weaponId === WEAPON_LONGBOW) return "sniper";
  if (weaponId === abilityWeaponId(ABL_ZEPHYR_BLADES)) return "knife"; // Zephyr's Blades ult throws knives, not bullets
  return "rifle"; // Falcon/Kestrel and the Rail ult "weapon" default to a rifle-ish silhouette
}

/** Which authored .glb represents each silhouette class (no SMG model authored — the rifle, scaled down, reads correctly). */
export const MODEL_FOR_CLASS: Record<WeaponClass, { name: ModelName; scale: number }> = {
  pistol: { name: "weapon_pistol", scale: 1 },
  smg: { name: "weapon_rifle", scale: 0.72 },
  rifle: { name: "weapon_rifle", scale: 1 },
  sniper: { name: "weapon_sniper", scale: 1 },
  knife: { name: "weapon_knife", scale: 1 },
};

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
    case "knife": {
      const handle = boxMesh(0.03, 0.035, 0.12, bodyColor);
      handle.position.set(0, 0, 0.03);
      const blade = boxMesh(0.008, 0.03, 0.18, metalColor);
      blade.position.set(0, 0.005, -0.12);
      group.add(handle, blade);
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
    agentId: number;
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

export interface ViewmodelComposition {
  scale: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Portrait/narrow canvases have a much smaller horizontal field of view when
 * vertical FOV stays fixed. Pull and scale the first-person rig inward so it
 * remains a framing element instead of covering the aiming area and HUD.
 */
export function viewmodelCompositionForAspect(aspect: number): ViewmodelComposition {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const narrow = Math.max(0, Math.min(1, (1.2 - safeAspect) / 0.75));
  return {
    scale: 1 - narrow * 0.38,
    x: 0.16 - narrow * 0.085,
    y: -0.13 - narrow * 0.04,
    z: -0.35 - narrow * 0.07,
  };
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

const WEAPON_CLASSES: readonly WeaponClass[] = ["pistol", "smg", "rifle", "sniper", "knife"];

export function createViewmodel(camera: THREE.PerspectiveCamera): ViewmodelHandle {
  const anchor = new THREE.Group();
  anchor.position.set(0.16, -0.13, -0.35);
  anchor.rotation.y = 0.06;
  camera.add(anchor);

  // First-person arms: a CHILD of the weapon anchor (not the camera), so the
  // hands grip the weapon and inherit all of its motion (sway, bob, recoil,
  // reload drop/twist, ADS pull) as one rigid unit. The arms glb is authored
  // directly in ANCHOR space (tools/agentgen/build_viewmodel.py: weapon grip
  // at the origin, matching the weapon glbs' grip-origin convention, right
  // fist wrapped on the grip, left hand cradling the handguard), so it lands
  // on the weapon with no offset. Model is chosen by the local agent
  // (Zephyr's gauntlets vs generic arms) and swapped when it changes. Async —
  // no placeholder, so nothing shows until the .glb lands; culling is off
  // (arms sit on the near plane).
  //
  // viewmodel_zephyr ships skinned + equip/reload/inspect clips — cloned with
  // SkeletonUtils and driven by AnimationMixer when present; procedural
  // reloadPoseAt remains the fallback when clips aren't available.
  const armsGroup = new THREE.Group();
  anchor.add(armsGroup);
  let currentArmsModel: ModelName | null = null;
  let armsMixer: THREE.AnimationMixer | null = null;
  let equipAction: THREE.AnimationAction | null = null;
  let reloadAction: THREE.AnimationAction | null = null;
  /** True when the active arms glb has a reload clip — skip procedural reloadPoseAt. */
  let armsHasReloadClip = false;

  function clearArmsMixer(): void {
    if (armsMixer) {
      armsMixer.stopAllAction();
      armsMixer = null;
    }
    equipAction = null;
    reloadAction = null;
    armsHasReloadClip = false;
  }

  /** Arms are authored per weapon CLASS (a rifle handguard C-clamp can't hold
   *  a pistol or a knife) — the glb is picked by agent AND class.
   *  rifle/smg share the base pose file. */
  function armsModelFor(agentId: number, cls: WeaponClass): ModelName {
    const base = agentId === AGENT_ZEPHYR ? "viewmodel_zephyr" : "viewmodel_arms";
    const suffix = cls === "pistol" ? "_pistol" : cls === "knife" ? "_knife" : cls === "sniper" ? "_sniper" : "";
    return `${base}${suffix}` as ModelName;
  }

  function setArms(agentId: number, cls: WeaponClass, playEquip = false): void {
    const desired = armsModelFor(agentId, cls);
    if (desired === currentArmsModel) {
      // same arms glb (e.g. rifle<->smg): still sell the swap with the clip
      if (playEquip && equipAction && armsMixer) equipAction.reset().fadeIn(0.05).play();
      return;
    }
    currentArmsModel = desired;
    void loadModel(desired).then((master) => {
      if (currentArmsModel !== desired || !master) return; // superseded by a later selection, or load failed
      clearArmsMixer();
      const clips = getModelAnimations(desired);
      // Skinned clone when the glb has a skeleton (zephyr arms) so mixer bones
      // rebind correctly; plain clone for the generic box arms.
      const hasSkin = (() => {
        let skinned = false;
        master.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true;
        });
        return skinned;
      })();
      let root: THREE.Object3D;
      if (hasSkin) {
        root = cloneSkinnedModel(master).root;
      } else {
        root = cloneModel(master).group;
        root.traverse((o) => (o.frustumCulled = false));
      }
      armsGroup.clear();
      armsGroup.add(root);

      if (clips.length > 0) {
        armsMixer = new THREE.AnimationMixer(root);
        const equipClip = selectBestAnimationClip(clips, "equip");
        const reloadClip = selectBestAnimationClip(clips, "reload");
        if (equipClip) {
          equipAction = armsMixer.clipAction(equipClip);
          equipAction.setLoop(THREE.LoopOnce, 1);
          equipAction.clampWhenFinished = true;
        }
        if (reloadClip) {
          reloadAction = armsMixer.clipAction(reloadClip);
          reloadAction.setLoop(THREE.LoopOnce, 1);
          reloadAction.clampWhenFinished = true;
          armsHasReloadClip = true;
        }
        // arms swapped because the weapon class changed: play equip on the
        // freshly bound action so the draw reads even though the load is async
        if (playEquip && equipAction) equipAction.reset().fadeIn(0.05).play();
      }
    });
  }

  const meshes = new Map<WeaponClass, THREE.Group>();
  for (const cls of WEAPON_CLASSES) {
    const mesh = buildWeaponMesh(cls);
    mesh.visible = false;
    anchor.add(mesh);
    meshes.set(cls, mesh);
    // Swap in the authored .glb when it arrives (procedural boxes remain
    // until then, and forever if the load fails — loadModel resolves null).
    const { name, scale } = MODEL_FOR_CLASS[cls];
    void loadModel(name).then((master) => {
      if (!master) return;
      const { group } = cloneModel(master);
      group.scale.setScalar(scale);
      mesh.clear();
      mesh.add(group);
    });
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
      armsGroup.visible = v;
      if (!v) scope.setStage(0);
    },
    fireKick(weaponId: number) {
      const cls = weaponClassFor(weaponId);
      const kickByClass: Record<WeaponClass, number> = { pistol: 6, smg: 5, rifle: 7, sniper: 14, knife: 3 };
      kickRecoilSpring(recoil, kickByClass[cls]);
    },
    update(info) {
      const cls = weaponClassFor(info.weaponId);
      const clsChanged = cls !== currentClass;
      if (clsChanged) {
        meshes.get(currentClass)!.visible = false;
        meshes.get(cls)!.visible = true;
        currentClass = cls;
      }
      // Arms follow (agentId × weapon class); on a class change the selected
      // arms play their equip clip (setArms handles both the same-glb and the
      // async swap case).
      setArms(info.agentId, cls, clsChanged);

      if (armsMixer) armsMixer.update(Math.max(0, info.dtSeconds));

      stepRecoilSpring(recoil, Math.max(0, info.dtSeconds));

      const speedFrac = info.maxSpeed > 0 ? Math.min(1, info.horizontalSpeed / info.maxSpeed) : 0;
      const sway = idleSwayOffset(info.timeSeconds);
      const bob = movementBobOffset(info.distanceTraveled, speedFrac);

      let reloadDropY = 0;
      let reloadTwist = 0;
      if (info.reloadProgress01 !== null) {
        // Rising edge: start the authored reload clip once per reload cycle.
        if (lastReloadProgress === null && reloadAction && armsMixer) {
          reloadAction.reset().fadeIn(0.05).play();
        }
        // Procedural gun drop/twist only when the arms glb has no reload clip
        // (generic arms / failed load) — keeps the weapon motion readable.
        if (!armsHasReloadClip) {
          const pose = reloadPoseAt(info.reloadProgress01);
          reloadDropY = pose.dropY;
          reloadTwist = pose.twist;
        }
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
      const composition = viewmodelCompositionForAspect(camera.aspect);
      anchor.scale.setScalar(composition.scale);

      anchor.position.set(
        (1 - adsFrac) * composition.x + adsFrac * 0.02 + sway.x + bob.x,
        composition.y + sway.y + bob.y + reloadDropY,
        composition.z + zoomVisualPull,
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

/**
 * Blender can emit duplicate action names (`reload`, `reload.001`, ...).
 * Prefer the matching clip with the most actual keyframe variation instead
 * of blindly choosing the first/exact name: malformed exact-name actions can
 * otherwise suppress the procedural fallback while contributing almost no
 * visible rotation.
 */
export function selectBestAnimationClip(
  clips: readonly THREE.AnimationClip[],
  name: string,
): THREE.AnimationClip | undefined {
  const candidates = clips.filter((clip) => clip.name === name || clip.name.startsWith(`${name}.`));
  let best: THREE.AnimationClip | undefined;
  let bestScore = -1;

  for (const clip of candidates) {
    let score = 0;
    for (const track of clip.tracks) {
      const valueSize = track.getValueSize();
      const values = track.values;

      // Unit quaternions have a double-cover: q and -q describe the same
      // orientation. Exporters are free to flip that sign between adjacent
      // keys, so raw component ranges can report a large change for a pose
      // that did not rotate at all. Measure the shortest angular distance
      // between consecutive keys instead.
      if (track instanceof THREE.QuaternionKeyframeTrack && valueSize === 4) {
        for (let i = valueSize; i < values.length; i += valueSize) {
          const previous = i - valueSize;
          const previousLength = Math.hypot(values[previous]!, values[previous + 1]!, values[previous + 2]!, values[previous + 3]!);
          const currentLength = Math.hypot(values[i]!, values[i + 1]!, values[i + 2]!, values[i + 3]!);
          if (previousLength === 0 || currentLength === 0) continue;
          const dot =
            (values[previous]! * values[i]! +
              values[previous + 1]! * values[i + 1]! +
              values[previous + 2]! * values[i + 2]! +
              values[previous + 3]! * values[i + 3]!) /
            (previousLength * currentLength);
          const cosHalfAngle = Math.min(1, Math.abs(dot));
          score += 2 * Math.acos(cosHalfAngle);
        }
        continue;
      }

      for (let component = 0; component < valueSize; component++) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (let i = component; i < values.length; i += valueSize) {
          const value = values[i]!;
          if (value < min) min = value;
          if (value > max) max = value;
        }
        if (Number.isFinite(min) && Number.isFinite(max)) score += max - min;
      }
    }
    if (score > bestScore) {
      best = clip;
      bestScore = score;
    }
  }

  return best;
}
