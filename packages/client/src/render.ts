import * as THREE from "three";
import {
  ABILITIES,
  ABILITY_WEAPON_ID_BASE,
  AGENT_LUMEN,
  AGENT_NONE,
  AGENT_SONAR,
  AGENT_UMBRA,
  AGENT_ZEPHYR,
  ENT_NONE,
  ENT_PROJECTILE,
  ENT_RECON_DART,
  ENT_SLOW_ZONE,
  ENT_SMOKE,
  ENT_ULT_ORB,
  ENT_WALL_BOX,
  FLASH_FULL,
  MAX_ABILITY_ENTITIES,
  WALL_BOX_MAX_HP,
  LEVEL_BOXES,
  LEVEL_HALF_EXTENT,
  WEAPONS,
  type Box,
  type SimState,
} from "@vg/sim";
import type { RemotePose } from "./interpolation.js";
import { cloneModel, loadModel } from "./assets.js";
import { surfaceKindForIndex, type GrayboxSurface } from "./graybox.js";
import type { MaterialSet } from "./materials.js";
import { createPlayerModel } from "./playerModel.js";
import { flashAfterimageCurve } from "./vfx.js";
import { trapModalFocus } from "./focusTrap.js";
import type { Zone } from "./zones.js";
import { minimapBackingStoreSize, worldToMinimapPoint } from "./hudLayout.js";
import {
  DEBUG_HUD_EVENT,
  dispatchDebugHudVisibility,
  loadDebugHudVisible,
  saveDebugHudVisible,
  type DebugHudVisibilityDetail,
} from "./hudPreferences.js";

/** Minimal shape render.ts's killfeed needs — kept decoupled from net.ts's full NetClient event type. */
export interface KillFeedEntry {
  killerIndex: number;
  victimIndex: number;
  weaponId: number;
  headshot: boolean;
}

export interface SceneHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  // logarithmicDepthBuffer: large outdoor extents (map ~72 m, far=200) + a
  // tight near plane for the viewmodel otherwise chew z-precision and make
  // coplanar/flush surfaces (floor decals, joined box edges) shimmer.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Filmic tone mapping, previously left at the three.js default of none.
  // Without it linear radiance is encoded straight to sRGB with no highlight
  // rolloff, which is why the snow courtyard and a shadowed facade sat at
  // opposite ends of the range with no midtones between them — the sky gradient
  // banded for the same reason. ACES compresses the highlights and lifts the
  // mids. This is a GLOBAL change: it affects agents and the viewmodel too.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;

  const scene = new THREE.Scene();
  // Daylight palette locked to graybox.ts's sky dome (zenith 0x1b4a87 →
  // horizon haze 0xcfe0ea). Fog matches that horizon haze so distant walls
  // fall off into the sky rather than into a flat gray wall — with the fog
  // still the old dusk purple, everything past mid-map read as bruised.
  scene.background = new THREE.Color(0x8fb4d2);
  scene.fog = new THREE.Fog(0xc2d6e2, 40, 115);

  const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 250);

  // Near-white key from the sky sun direction + cool sky fill. The hemisphere
  // GROUND term is snow bounce, not dirt: it was 0x4a3828 for the dusk scene,
  // which lit the undersides of a snow courtyard dark brown.
  const hemi = new THREE.HemisphereLight(0xbfd9f2, 0xb4bcc0, 1.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff6e2, 1.9);
  sun.position.set(20, 30, 10);
  scene.add(sun);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  scene.add(camera); // so camera-attached children (viewmodel) render

  return { renderer, scene, camera };
}

// M5: the placeholder barrel+body viewmodel proxy that used to live here has
// been replaced by viewmodel.ts's createViewmodel() (per-weapon-class
// procedural models with recoil/reload/ADS motion) — see main.ts's import.

/**
 * Builds instanced graybox meshes grouped by material — the same box list drives sim
 * collision (see graybox.ts). M5: if a MaterialSet is supplied, each surface
 * gets its zone-tinted textured material (floor/wall by zone, crates get the
 * wood-crate texture, ramp gets the metal panel texture — see
 * graybox.ts's surfaceKindForIndex()); otherwise falls back to the flat
 * per-box color it always had (kept so tests / a materials-less boot path
 * still render something sane).
 */
export function buildGrayboxMeshes(scene: THREE.Scene, boxes: readonly GrayboxSurface[], materials?: MaterialSet): void {
  const placeholders: THREE.Mesh[] = [];
  const fallbackMaterial = materials ? null : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.05, vertexColors: true });
  const grouped = new Map<THREE.Material, Array<{ box: GrayboxSurface; index: number }>>();
  boxes.forEach((box, index) => {
    const material = materials ? materialForSurface(index, box.zone, materials) : fallbackMaterial!;
    const entries = grouped.get(material) ?? [];
    entries.push({ box, index });
    grouped.set(material, entries);
  });

  const transform = new THREE.Object3D();
  for (const [material, entries] of grouped) {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, entries.length);
    for (let instance = 0; instance < entries.length; instance++) {
      const b = entries[instance]!.box;
      transform.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
      transform.scale.set(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
      transform.updateMatrix();
      mesh.setMatrixAt(instance, transform.matrix);
      if (!materials) mesh.setColorAt(instance, new THREE.Color(b.color));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    placeholders.push(mesh);
  }
  // Baked-lighting swap (same placeholder/fallback contract as every other
  // .glb in assets.ts): map_crossing.glb is generated from the SAME
  // LEVEL_BOXES by tools/mapgen/build_map.py, with AO baked into vertex
  // colors (COLOR_0). On load it visually replaces the procedural boxes; on
  // failure the graybox stays. Collision is unaffected either way — it
  // lives in @vg/sim and never reads render meshes.
  //
  // vertexColors is forced in loadModel/enableVertexColors so the baked AO
  // actually multiplies into MeshStandardMaterial base color.
  void loadModel("map_crossing").then((master) => {
    if (!master) return;
    // Clone materials so we can fix doubleSided (exporter marks every map
    // material double-sided → front/back coplanars shimmer at grazing angles)
    // without mutating the cached master.
    const { group } = cloneModel(master, true);
    group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        m.side = THREE.FrontSide;
        // Keep vertex AO; cloneModel(…, true) only forced transparent for
        // death-fade paths — map surfaces should be opaque (depth-stable).
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
        m.needsUpdate = true;
      }
    });
    scene.add(group);
    for (const mesh of placeholders) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      // Shared MaterialSet materials are reused across placeholders — do NOT
      // dispose materials here (only the per-placeholder BoxGeometry).
    }
    fallbackMaterial?.dispose();
    // Wall panels + cover-crate skins sit on the same faces as this mesh.
    // Hide them so they don't z-fight the baked map (they stay for graybox
    // fallback when this load fails).
    scene.traverse((obj) => {
      if (obj.userData?.mapCoplanarDressing) obj.visible = false;
    });
  });
}

function materialForSurface(index: number, zone: Zone, materials: MaterialSet): THREE.Material {
  const kind = surfaceKindForIndex(index);
  if (kind === "floor") return materials.floorByZone[zone];
  if (kind === "wall") return materials.wallByZone[zone];
  if (kind === "crate") return materials.woodCrate;
  return materials.metalPanel; // ramp
}

export interface FpsCounter {
  update(fps: number): void;
  /** Extra debug lines appended below the fps line (net stats — see net.ts's NetHud). */
  updateExtra(lines: readonly string[]): void;
  /** Performance telemetry is opt-in (F3/settings), never painted over gameplay by default. */
  setVisible(visible: boolean): void;
  toggle(): void;
  isVisible(): boolean;
}

export function createFpsCounter(): FpsCounter {
  const el = document.createElement("div");
  el.className = "vg-hud vg-debug-hud";
  el.setAttribute("aria-label", "Performance telemetry");
  el.setAttribute("aria-live", "off");
  el.style.position = "fixed";
  el.style.padding = "2px 6px";
  el.style.font = "12px monospace";
  el.style.color = "#8dffb1";
  el.style.background = "rgba(0,0,0,0.5)";
  el.style.zIndex = "10";
  el.style.whiteSpace = "pre";
  el.textContent = "fps: --";
  document.body.appendChild(el);
  let fpsLine = "fps: --";
  let extraLines: readonly string[] = [];
  let visible = loadDebugHudVisible(window.localStorage);
  let lastPaintMs = Number.NEGATIVE_INFINITY;
  let lastPaintedText = "";

  function setVisible(next: boolean, persist = true): void {
    if (visible === next && persist) return;
    visible = next;
    el.style.display = visible ? "block" : "none";
    if (visible) render(true);
    if (persist) saveDebugHudVisible(window.localStorage, visible);
  }

  function render(force = false): void {
    if (!visible) return;
    const now = performance.now();
    if (!force && now - lastPaintMs < 250) return;
    const text = [fpsLine, ...extraLines].join("\n");
    if (text !== lastPaintedText) {
      el.textContent = text;
      lastPaintedText = text;
    }
    lastPaintMs = now;
  }

  setVisible(visible, false);
  document.addEventListener("keydown", (event) => {
    if (event.code !== "F3" || event.repeat) return;
    event.preventDefault();
    setVisible(!visible);
    dispatchDebugHudVisibility(visible);
  });
  window.addEventListener(DEBUG_HUD_EVENT, ((event: CustomEvent<DebugHudVisibilityDetail>) => {
    setVisible(event.detail.visible);
  }) as EventListener);

  return {
    update(fps: number) {
      if (!visible) return;
      fpsLine = `fps: ${fps.toFixed(0)}`;
      render();
    },
    updateExtra(lines: readonly string[]) {
      if (!visible) return;
      extraLines = lines;
      render();
    },
    setVisible,
    toggle() {
      setVisible(!visible);
      dispatchDebugHudVisibility(visible);
    },
    isVisible: () => visible,
  };
}

/**
 * M5: replaces the old capsule-proxy mesh (cylinder + sphere caps) with an
 * articulated procedural player model (see playerModel.ts) — walk cycle,
 * crouch pose, death ragdoll-lite, team/ally-tinted, weapon-in-hand. This
 * wrapper tracks the bookkeeping playerModel.ts's pose needs but isn't on
 * the wire (horizontal speed and distance traveled — derived from
 * consecutive interpolated positions, since RemotePose carries neither
 * velocity nor an odometer).
 */
export interface RemotePlayerProxy {
  group: THREE.Group;
  /** `localTeam` (255 = unassigned) decides the ally/enemy tint — see playerModel.ts's playerModelColors(). */
  setPose(pose: RemotePose, localTeam: number): void;
  dispose(scene: THREE.Scene): void;
}

export function createRemotePlayerProxy(scene: THREE.Scene): RemotePlayerProxy {
  const model = createPlayerModel(scene);
  let lastX = 0;
  let lastZ = 0;
  let lastTimeMs = performance.now();
  let distanceTraveled = 0;
  let hasPrior = false;

  return {
    group: model.group,
    setPose(pose: RemotePose, localTeam: number) {
      const nowMs = performance.now();
      const dtSeconds = Math.max(0, Math.min(0.25, (nowMs - lastTimeMs) / 1000));
      lastTimeMs = nowMs;
      const dx = hasPrior ? pose.posX - lastX : 0;
      const dz = hasPrior ? pose.posZ - lastZ : 0;
      const stepDist = Math.hypot(dx, dz);
      distanceTraveled += stepDist;
      const horizontalSpeed = dtSeconds > 0 ? stepDist / dtSeconds : 0;
      lastX = pose.posX;
      lastZ = pose.posZ;
      hasPrior = true;

      model.setPose({
        posX: pose.posX,
        posY: pose.posY,
        posZ: pose.posZ,
        yaw: pose.yaw,
        crouching: pose.crouching,
        grounded: pose.grounded,
        connected: pose.connected,
        alive: pose.alive,
        team: pose.team,
        isAlly: localTeam !== 255 && pose.team === localTeam,
        agentId: pose.agentId,
        weaponId: pose.activeSlot === 0 ? pose.weaponPrimary : pose.weaponSecondary,
        horizontalSpeed,
        distanceTraveled,
        nowSeconds: nowMs / 1000,
      });
    },
    dispose(targetScene: THREE.Scene) {
      model.dispose(targetScene);
    },
  };
}

/** A short-lived tracer line from `from` to `to`, fading out over `lifetimeMs`. */
export function spawnTracer(
  scene: THREE.Scene,
  from: THREE.Vector3,
  to: THREE.Vector3,
  lifetimeMs = 100,
): void {
  const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
  const material = new THREE.LineBasicMaterial({ color: 0xfff6c9, transparent: true, opacity: 0.9 });
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  const start = performance.now();
  function fade(): void {
    const t = (performance.now() - start) / lifetimeMs;
    if (t >= 1) {
      scene.remove(line);
      geometry.dispose();
      material.dispose();
      return;
    }
    material.opacity = 0.9 * (1 - t);
    requestAnimationFrame(fade);
  }
  requestAnimationFrame(fade);
}

/** Brief red screen-edge flash shown when the local player is hit. */
export function createHitFlashOverlay(): { flash(): void } {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.pointerEvents = "none";
  el.style.boxShadow = "inset 0 0 0 0 rgba(255,0,0,0)";
  el.style.transition = "box-shadow 250ms ease-out";
  el.style.zIndex = "9";
  document.body.appendChild(el);
  return {
    flash() {
      el.style.transition = "none";
      el.style.boxShadow = "inset 0 0 120px 20px rgba(255,0,0,0.55)";
      requestAnimationFrame(() => {
        el.style.transition = "box-shadow 250ms ease-out";
        el.style.boxShadow = "inset 0 0 0 0 rgba(255,0,0,0)";
      });
    },
  };
}

/** Persistent first-person aiming reticle. Scope/ADS and gameplay visibility
 * are separate inputs so menus, death/spectate, and scoped weapons can hide it
 * without coupling this renderer to simulation state. */
export interface Crosshair {
  setVisible(visible: boolean): void;
  setAds(ads: boolean): void;
}

export function createCrosshair(): Crosshair {
  const el = document.createElement("div");
  el.className = "vg-crosshair";
  el.setAttribute("aria-hidden", "true");
  for (const direction of ["top", "right", "bottom", "left"] as const) {
    const arm = document.createElement("span");
    arm.className = `vg-crosshair__arm vg-crosshair__arm--${direction}`;
    el.appendChild(arm);
  }
  const dot = document.createElement("span");
  dot.className = "vg-crosshair__dot";
  el.appendChild(dot);
  document.body.appendChild(el);

  const syncPointerLockClass = (): void => {
    document.body.classList.toggle("vg-pointer-locked", document.pointerLockElement !== null);
  };
  document.addEventListener("pointerlockchange", syncPointerLockClass);
  syncPointerLockClass();

  let gameplayVisible = true;
  let adsActive = false;
  function render(): void {
    el.style.display = gameplayVisible && !adsActive ? "block" : "none";
  }
  render();

  return {
    setVisible(visible) {
      gameplayVisible = visible;
      render();
    },
    setAds(ads) {
      adsActive = ads;
      render();
    },
  };
}

/**
 * Crosshair hitmarker(s): a predicted hit (client's own cosmetic raycast,
 * instant) shows a hollow marker; a server-confirmed hit shows a solid
 * marker plus a floating damage number — visually distinct per spec, since
 * the predicted one can occasionally be wrong (fringe/lag-comp cases).
 */
export interface Hitmarker {
  showPredicted(): void;
  showConfirmed(damage: number): void;
}

export function createHitmarker(): Hitmarker {
  const predictedEl = document.createElement("div");
  predictedEl.style.position = "fixed";
  predictedEl.style.top = "50%";
  predictedEl.style.left = "50%";
  predictedEl.style.transform = "translate(-50%, -50%)";
  predictedEl.style.width = "20px";
  predictedEl.style.height = "20px";
  predictedEl.style.pointerEvents = "none";
  predictedEl.style.zIndex = "11";
  predictedEl.style.opacity = "0";
  predictedEl.style.transition = "opacity 120ms ease-out";
  predictedEl.style.font = "18px monospace";
  predictedEl.style.color = "#ffffff";
  predictedEl.style.textAlign = "center";
  predictedEl.style.lineHeight = "20px";
  predictedEl.textContent = "+"; // hollow: thin plain plus
  document.body.appendChild(predictedEl);

  const confirmedEl = document.createElement("div");
  confirmedEl.style.position = "fixed";
  confirmedEl.style.top = "50%";
  confirmedEl.style.left = "50%";
  confirmedEl.style.transform = "translate(-50%, -50%)";
  confirmedEl.style.width = "20px";
  confirmedEl.style.height = "20px";
  confirmedEl.style.pointerEvents = "none";
  confirmedEl.style.zIndex = "11";
  confirmedEl.style.opacity = "0";
  confirmedEl.style.transition = "opacity 180ms ease-out";
  confirmedEl.style.font = "bold 22px monospace";
  confirmedEl.style.color = "#ff3b3b";
  confirmedEl.style.textAlign = "center";
  confirmedEl.style.lineHeight = "20px";
  confirmedEl.style.textShadow = "0 0 3px rgba(0,0,0,0.8)";
  confirmedEl.textContent = "+"; // solid: bold red plus
  document.body.appendChild(confirmedEl);

  const damageEl = document.createElement("div");
  damageEl.style.position = "fixed";
  damageEl.style.top = "calc(50% - 26px)";
  damageEl.style.left = "50%";
  damageEl.style.transform = "translate(-50%, -50%)";
  damageEl.style.pointerEvents = "none";
  damageEl.style.zIndex = "11";
  damageEl.style.opacity = "0";
  damageEl.style.transition = "opacity 400ms ease-out, top 400ms ease-out";
  damageEl.style.font = "bold 14px monospace";
  damageEl.style.color = "#ffd54a";
  damageEl.style.textShadow = "0 0 3px rgba(0,0,0,0.8)";
  document.body.appendChild(damageEl);

  return {
    showPredicted() {
      predictedEl.style.transition = "none";
      predictedEl.style.opacity = "0.9";
      requestAnimationFrame(() => {
        predictedEl.style.transition = "opacity 120ms ease-out";
        predictedEl.style.opacity = "0";
      });
    },
    showConfirmed(damage: number) {
      confirmedEl.style.transition = "none";
      confirmedEl.style.opacity = "1";
      damageEl.textContent = String(Math.round(damage));
      damageEl.style.transition = "none";
      damageEl.style.top = "calc(50% - 26px)";
      damageEl.style.opacity = "1";
      requestAnimationFrame(() => {
        confirmedEl.style.transition = "opacity 180ms ease-out";
        confirmedEl.style.opacity = "0";
        damageEl.style.transition = "opacity 400ms ease-out, top 400ms ease-out";
        damageEl.style.top = "calc(50% - 46px)";
        damageEl.style.opacity = "0";
      });
    },
  };
}

/** Last-5, 6s-fade killfeed ("A > B", headshot marker), per spec. */
export interface KillFeed {
  push(entry: KillFeedEntry): void;
}

const KILLFEED_MAX_ENTRIES = 5;
const KILLFEED_FADE_MS = 6000;

export function createKillFeed(playerLabel: (index: number) => string): KillFeed {
  const container = document.createElement("div");
  container.className = "vg-hud vg-killfeed";
  container.style.position = "fixed";
  container.style.zIndex = "10";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "2px";
  container.style.font = "13px monospace";
  container.style.color = "#fff";
  container.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  document.body.appendChild(container);

  function weaponName(weaponId: number): string {
    // M4a: ability kills ride the 100+abilityId id space (see @vg/sim
    // abilities/data.ts abilityWeaponId) — resolve those to the ability's
    // name instead of falling through to "?".
    if (weaponId >= ABILITY_WEAPON_ID_BASE) {
      const abilityId = weaponId - ABILITY_WEAPON_ID_BASE;
      return ABILITIES.find((a) => a.id === abilityId)?.name ?? "ability";
    }
    return WEAPONS.find((w) => w.id === weaponId)?.name ?? "?";
  }

  return {
    push(entry: KillFeedEntry) {
      const row = document.createElement("div");
      row.className = "vg-killfeed__row";
      row.style.transition = `opacity ${KILLFEED_FADE_MS}ms linear`;
      const marker = entry.headshot ? "[HS]" : "▸";
      row.textContent = `${playerLabel(entry.killerIndex)} ${marker} ${playerLabel(entry.victimIndex)} (${weaponName(entry.weaponId)})`;
      container.appendChild(row);
      while (container.children.length > KILLFEED_MAX_ENTRIES) {
        container.removeChild(container.children[0]!);
      }
      requestAnimationFrame(() => {
        row.style.opacity = "0";
      });
      setTimeout(() => row.remove(), KILLFEED_FADE_MS + 100);
    },
  };
}

/** Screen-edge red arc pointing toward the attacker's screen-relative direction. */
export interface DamageDirectionIndicator {
  show(screenAngleRad: number): void;
}

export function createDamageDirectionIndicator(): DamageDirectionIndicator {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.top = "50%";
  el.style.left = "50%";
  el.style.width = "260px";
  el.style.height = "260px";
  el.style.marginLeft = "-130px";
  el.style.marginTop = "-130px";
  el.style.pointerEvents = "none";
  el.style.zIndex = "9";
  el.style.opacity = "0";
  el.style.transition = "opacity 500ms ease-out";
  el.style.borderRadius = "50%";
  el.style.background =
    "conic-gradient(from -20deg, rgba(255,40,40,0.85) 0deg, rgba(255,40,40,0.85) 40deg, transparent 40deg, transparent 320deg)";
  document.body.appendChild(el);
  return {
    show(screenAngleRad: number) {
      el.style.transition = "none";
      el.style.transform = `rotate(${screenAngleRad}rad)`;
      el.style.opacity = "1";
      requestAnimationFrame(() => {
        el.style.transition = "opacity 500ms ease-out";
        el.style.opacity = "0";
      });
    },
  };
}

/** DOM buy menu overlay: 6 weapons + 2 armors with prices; B/Escape closes (wired in input.ts). */
export interface BuyMenu {
  setOpen(open: boolean): void;
  setState(credits: number, alive: boolean): void;
  /**
   * M3 match mode: shows a "Sell" button next to each row whose itemId is in
   * `purchasedItemIds` (items bought THIS buy phase — see @vg/sim's
   * purchasedThisBuy tracking), and whether the buy phase itself is even
   * open right now (buy/sell are only valid during it in match mode).
   */
  setMatchState(purchasedItemIds: ReadonlySet<number>, isBuyPhase: boolean): void;
}

export function createBuyMenu(onBuy: (itemId: number) => void, onSell?: (itemId: number) => void): BuyMenu {
  const overlay = document.createElement("div");
  overlay.className = "vg-hud vg-modal-backdrop";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "20";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(0,0,0,0.55)";
  overlay.style.font = "14px monospace";
  overlay.style.color = "#fff";

  const panel = document.createElement("div");
  panel.className = "vg-panel vg-buy-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "vg-buy-title");
  panel.tabIndex = -1;
  panel.style.background = "#1c1f24";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "6px";
  panel.style.padding = "16px 20px";
  overlay.appendChild(panel);

  const title = document.createElement("div");
  title.textContent = "ARMORY";
  title.className = "vg-panel__title";
  title.id = "vg-buy-title";
  title.style.marginBottom = "10px";
  title.style.opacity = "0.8";
  panel.appendChild(title);

  const phaseLine = document.createElement("div");
  phaseLine.className = "vg-buy-panel__phase";
  phaseLine.textContent = "BUY PHASE · 1–8 TO PURCHASE · B / ESC TO CLOSE";
  panel.appendChild(phaseLine);

  const creditsLine = document.createElement("div");
  creditsLine.style.marginBottom = "10px";
  panel.appendChild(creditsLine);

  const items: Array<{ itemId: number; label: string; price: number }> = [
    ...WEAPONS.map((w) => ({ itemId: w.id, label: w.name, price: w.price })),
    { itemId: 200, label: "Light Armor", price: 400 },
    { itemId: 201, label: "Heavy Armor", price: 1000 },
  ];

  let credits = 0;
  let playerAlive = true;
  let buyPhaseOpen = true; // offline/DM preserves the existing always-buy behavior
  const rows: HTMLDivElement[] = [];
  const purchaseButtons: HTMLButtonElement[] = [];
  const sellButtons: HTMLButtonElement[] = [];

  function refreshRows(): void {
    creditsLine.textContent = `CREDITS  ${credits.toLocaleString()}${playerAlive ? "" : "  ·  ELIMINATED"}`;
    phaseLine.textContent = buyPhaseOpen
      ? "BUY PHASE · 1–8 TO PURCHASE · B / ESC TO CLOSE"
      : "ARMORY CLOSED · AVAILABLE DURING BUY PHASE";
    phaseLine.dataset.closed = String(!buyPhaseOpen);
    rows.forEach((row, i) => {
      const interactive = playerAlive && buyPhaseOpen && items[i]!.price <= credits;
      row.style.opacity = interactive ? "1" : "0.38";
      row.style.pointerEvents = interactive || (buyPhaseOpen && playerAlive) ? "auto" : "none";
      purchaseButtons[i]!.disabled = !interactive;
    });
  }

  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.className = "vg-buy-panel__row";
    row.style.padding = "4px 8px";
    row.style.borderRadius = "3px";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "10px";

    const label = document.createElement("button");
    label.type = "button";
    label.style.cursor = "pointer";
    label.style.border = "0";
    label.style.padding = "0";
    label.style.background = "transparent";
    label.style.color = "inherit";
    label.style.font = "inherit";
    label.style.textAlign = "left";
    label.textContent = `${i + 1}  ${item.label}`;
    const price = document.createElement("strong");
    price.textContent = `${item.price.toLocaleString()} CR`;
    label.appendChild(price);
    label.addEventListener("click", () => {
      if (playerAlive && buyPhaseOpen && item.price <= credits) onBuy(item.itemId);
    });
    row.appendChild(label);
    purchaseButtons.push(label);

    const sellBtn = document.createElement("button");
    sellBtn.textContent = "Sell";
    sellBtn.style.display = "none";
    sellBtn.style.font = "12px monospace";
    sellBtn.style.cursor = "pointer";
    sellBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      onSell?.(item.itemId);
    });
    row.appendChild(sellBtn);
    sellButtons.push(sellBtn);

    row.addEventListener("mouseenter", () => (row.style.background = "rgba(255,255,255,0.1)"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    panel.appendChild(row);
    rows.push(row);
  });

  document.body.appendChild(overlay);
  let open = false;
  let previouslyFocused: HTMLElement | null = null;
  panel.addEventListener("keydown", (event) => {
    if (open) trapModalFocus(event, panel);
  });

  return {
    setOpen(nextOpen: boolean) {
      if (open === nextOpen) return;
      open = nextOpen;
      overlay.style.display = open ? "flex" : "none";
      overlay.setAttribute("aria-hidden", String(!open));
      if (open) {
        previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        (purchaseButtons.find((button) => !button.disabled) ?? panel).focus();
      } else if (previouslyFocused) {
        previouslyFocused.focus();
        previouslyFocused = null;
      }
    },
    setState(newCredits: number, alive: boolean) {
      credits = newCredits;
      playerAlive = alive;
      refreshRows();
    },
    setMatchState(purchasedItemIds: ReadonlySet<number>, isBuyPhase: boolean) {
      buyPhaseOpen = isBuyPhase;
      items.forEach((item, i) => {
        sellButtons[i]!.style.display = onSell && isBuyPhase && purchasedItemIds.has(item.itemId) ? "inline-block" : "none";
      });
      refreshRows();
    },
  };
}

/** Health/armor/weapon/credits/respawn-countdown HUD overlay. */
export interface CombatHud {
  /** Hides all lower combat presentation outside active buy/round play. */
  setVisible(visible: boolean): void;
  update(state: {
    health: number;
    armor: number;
    weaponName: string;
    magAmmo: number;
    reserveAmmo: number;
    credits: number;
    alive: boolean;
    respawnSecondsLeft: number;
  }): void;
}

export function createCombatHud(): CombatHud {
  const container = document.createElement("div");
  container.className = "vg-hud vg-combat-hud";
  container.setAttribute("aria-label", "Combat status");
  container.style.display = "none";

  const vitals = document.createElement("div");
  vitals.className = "vg-combat-hud__vitals";
  const healthValue = document.createElement("strong");
  const armorValue = document.createElement("strong");
  const health = document.createElement("span");
  health.className = "vg-combat-hud__stat vg-combat-hud__stat--health";
  health.append("HP ", healthValue);
  const armor = document.createElement("span");
  armor.className = "vg-combat-hud__stat vg-combat-hud__stat--armor";
  armor.append("ARMOR ", armorValue);
  vitals.append(health, armor);

  const loadout = document.createElement("div");
  loadout.className = "vg-combat-hud__loadout";
  const weaponValue = document.createElement("span");
  weaponValue.className = "vg-combat-hud__weapon";
  const ammoValue = document.createElement("strong");
  ammoValue.className = "vg-combat-hud__ammo";
  const reserveValue = document.createElement("span");
  reserveValue.className = "vg-combat-hud__reserve";
  const creditsValue = document.createElement("span");
  creditsValue.className = "vg-combat-hud__credits";
  loadout.append(weaponValue, ammoValue, reserveValue, creditsValue);

  container.append(vitals, loadout);
  document.body.appendChild(container);

  const respawnEl = document.createElement("div");
  respawnEl.className = "vg-hud vg-respawn-banner";
  respawnEl.style.position = "fixed";
  respawnEl.style.top = "40%";
  respawnEl.style.left = "50%";
  respawnEl.style.transform = "translate(-50%, -50%)";
  respawnEl.style.zIndex = "12";
  respawnEl.style.font = "bold 28px monospace";
  respawnEl.style.color = "#fff";
  respawnEl.style.textShadow = "0 0 6px rgba(0,0,0,0.9)";
  respawnEl.style.display = "none";
  document.body.appendChild(respawnEl);

  let visible = false;

  return {
    setVisible(nextVisible) {
      visible = nextVisible;
      container.style.display = visible ? "block" : "none";
      if (!visible) respawnEl.style.display = "none";
    },
    update({ health, armor, weaponName, magAmmo, reserveAmmo, credits, alive, respawnSecondsLeft }) {
      healthValue.textContent = String(Math.max(0, Math.round(health)));
      armorValue.textContent = String(Math.max(0, Math.round(armor)));
      weaponValue.textContent = weaponName.toUpperCase();
      ammoValue.textContent = String(Math.max(0, magAmmo));
      reserveValue.textContent = `/ ${Math.max(0, reserveAmmo)}`;
      creditsValue.textContent = `${credits.toLocaleString()} CR`;
      container.dataset.eliminated = String(!alive);
      if (visible && !alive && respawnSecondsLeft > 0) {
        respawnEl.style.display = "block";
        respawnEl.textContent = `RESPAWNING IN ${Math.ceil(respawnSecondsLeft)}S`;
      } else {
        respawnEl.style.display = "none";
      }
    },
  };
}

// ---- M3: match phase/round/spike HUD, minimap, spectate, reconnect banner ----

const PHASE_NAMES = ["Waiting for players…", "BUY PHASE", "", "Round over", "MATCH OVER"];

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export interface MatchHudView {
  /** Called every frame with the settled snapshot state — phase name/timer, score, and spike countdown/progress. */
  update(info: {
    mode: number;
    matchPhase: number;
    phaseSecondsLeft: number;
    roundNumber: number;
    scoreTeam0: number;
    scoreTeam1: number;
    myTeam: number;
    spikeState: number;
    isCarrier: boolean;
    detonateSecondsLeft: number;
    /** 0..1, or null if this client isn't the one currently channeling. */
    ownChannelProgress01: number | null;
    ownChannelKind: "plant" | "defuse" | null;
  }): void;
  /** Event-driven: shown for a few seconds on a roundEnd MatchEvent. */
  showRoundEnd(winnerTeam: number, reason: number, myTeam: number): void;
  /** Event-driven: shown (and stays) on a matchEnd MatchEvent. */
  showMatchEnd(scoreTeam0: number, scoreTeam1: number, myTeam: number): void;
}

const REASON_NAMES = ["Eliminated", "Spike detonated", "Spike defused", "Time expired"];

export function createMatchHud(): MatchHudView {
  const top = document.createElement("div");
  top.className = "vg-hud vg-match-hud";
  top.style.position = "fixed";
  top.style.display = "none";
  top.style.zIndex = "10";
  top.style.color = "#fff";
  top.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  top.style.textAlign = "center";

  const phaseLabel = document.createElement("span");
  phaseLabel.className = "vg-match-hud__phase";
  const clockLabel = document.createElement("strong");
  clockLabel.className = "vg-match-hud__clock";
  const scoreLabel = document.createElement("strong");
  scoreLabel.className = "vg-match-hud__score";
  const contextLabel = document.createElement("span");
  contextLabel.className = "vg-match-hud__context";
  top.append(phaseLabel, clockLabel, scoreLabel, contextLabel);
  document.body.appendChild(top);

  const spikeHud = document.createElement("div");
  spikeHud.className = "vg-hud vg-spike-hud";
  spikeHud.style.position = "fixed";
  spikeHud.style.zIndex = "10";
  spikeHud.style.color = "#ff4d4d";
  spikeHud.style.textShadow = "0 0 4px rgba(0,0,0,0.9)";
  spikeHud.style.textAlign = "center";
  document.body.appendChild(spikeHud);

  const progressBar = document.createElement("div");
  progressBar.className = "vg-channel-progress";
  progressBar.style.position = "fixed";
  progressBar.style.zIndex = "10";
  progressBar.style.display = "none";
  const progressFill = document.createElement("div");
  progressFill.className = "vg-channel-progress__fill";
  progressFill.style.height = "100%";
  progressFill.style.background = "#ffd54a";
  progressFill.style.width = "0%";
  progressBar.appendChild(progressFill);
  document.body.appendChild(progressBar);

  const banner = document.createElement("div");
  banner.className = "vg-hud vg-round-banner";
  banner.style.position = "fixed";
  banner.style.top = "35%";
  banner.style.left = "50%";
  banner.style.transform = "translate(-50%, -50%)";
  banner.style.zIndex = "15";
  banner.style.color = "#fff";
  banner.style.textShadow = "0 0 6px rgba(0,0,0,0.9)";
  banner.style.textAlign = "center";
  banner.style.display = "none";
  document.body.appendChild(banner);

  let bannerTimeout: ReturnType<typeof setTimeout> | null = null;
  let bannerKind: "round" | "match" | null = null;
  let bannerObservedAuthoritativePhase = false;
  let lastMatchPhase: number | null = null;

  function hideBanner(): void {
    if (bannerTimeout) clearTimeout(bannerTimeout);
    bannerTimeout = null;
    bannerKind = null;
    bannerObservedAuthoritativePhase = false;
    banner.style.display = "none";
  }

  return {
    update(info) {
      if (info.mode !== 1) {
        lastMatchPhase = null;
        top.style.display = "none";
        spikeHud.textContent = "";
        progressBar.style.display = "none";
        hideBanner();
        return;
      }
      top.style.display = "flex";
      const phaseName = info.matchPhase === 2 ? "ROUND" : (PHASE_NAMES[info.matchPhase] ?? "");
      const teamName = info.myTeam === 0 ? "ATTACK" : info.myTeam === 1 ? "DEFENSE" : "—";
      phaseLabel.textContent = phaseName;
      clockLabel.textContent = formatClock(info.phaseSecondsLeft);
      scoreLabel.textContent = `${info.scoreTeam0}  —  ${info.scoreTeam1}`;
      contextLabel.textContent = `R${info.roundNumber} · ${teamName}`;

      // Match events can arrive before their matching phase snapshot. Wait
      // until the authoritative end phase has actually been observed, then
      // clear only when play advances into the next phase/new match.
      if (bannerKind === "round") {
        if (info.matchPhase === 3) bannerObservedAuthoritativePhase = true;
        else if (bannerObservedAuthoritativePhase && info.matchPhase === 1) hideBanner();
      } else if (bannerKind === "match") {
        if (info.matchPhase === 4) bannerObservedAuthoritativePhase = true;
        else if (bannerObservedAuthoritativePhase) hideBanner();
      }
      lastMatchPhase = info.matchPhase;

      const roundActive = info.matchPhase === 2;
      const canCarrySpike = info.matchPhase === 1 || roundActive;
      if (roundActive && info.spikeState === 2) {
        spikeHud.textContent = `SPIKE PLANTED  ${formatClock(info.detonateSecondsLeft)}`;
      } else if (canCarrySpike && info.isCarrier) {
        spikeHud.textContent = "CARRYING THE SPIKE";
      } else {
        spikeHud.textContent = "";
      }

      if (roundActive && info.ownChannelProgress01 !== null) {
        progressBar.style.display = "block";
        progressFill.style.width = `${Math.round(info.ownChannelProgress01 * 100)}%`;
        progressFill.style.background = info.ownChannelKind === "defuse" ? "#4dafff" : "#ffd54a";
      } else {
        progressBar.style.display = "none";
      }
    },
    showRoundEnd(winnerTeam, reason, myTeam) {
      const won = winnerTeam === myTeam;
      const winnerName = winnerTeam === 0 ? "ATTACKERS" : "DEFENDERS";
      banner.textContent = `${winnerName} WIN — ${REASON_NAMES[reason] ?? ""}${myTeam !== 255 ? (won ? "  (you won)" : "  (you lost)") : ""}`;
      banner.style.display = "block";
      bannerKind = "round";
      bannerObservedAuthoritativePhase = lastMatchPhase === 3;
      if (bannerTimeout) clearTimeout(bannerTimeout);
      bannerTimeout = setTimeout(() => {
        banner.style.display = "none";
        bannerKind = null;
        bannerObservedAuthoritativePhase = false;
      }, 4500);
    },
    showMatchEnd(scoreTeam0, scoreTeam1, myTeam) {
      if (bannerTimeout) clearTimeout(bannerTimeout);
      const leader = scoreTeam0 > scoreTeam1 ? 0 : 1;
      const won = leader === myTeam;
      banner.textContent = `MATCH OVER — ${scoreTeam0} : ${scoreTeam1}${myTeam !== 255 ? (won ? "  YOU WIN" : "  YOU LOSE") : ""}`;
      banner.style.display = "block";
      bannerKind = "match";
      bannerObservedAuthoritativePhase = lastMatchPhase === 4;
    },
  };
}

/** Team-only spectate label — camera attachment itself lives in main.ts. */
export interface SpectateOverlay {
  update(spectatingIndex: number | null, overheadFallback: boolean): void;
}

export function createSpectateOverlay(): SpectateOverlay {
  const el = document.createElement("div");
  el.className = "vg-hud vg-spectate-label";
  el.style.position = "fixed";
  el.style.bottom = "60px";
  el.style.left = "50%";
  el.style.transform = "translateX(-50%)";
  el.style.zIndex = "10";
  el.style.font = "14px monospace";
  el.style.color = "#fff";
  el.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  el.style.display = "none";
  document.body.appendChild(el);
  return {
    update(spectatingIndex, overheadFallback) {
      if (spectatingIndex === null && !overheadFallback) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.textContent = overheadFallback ? "Spectating — overhead view (no living teammates)" : `Spectating P${spectatingIndex} (click to cycle)`;
    },
  };
}

/** Connection-state banner for retrying and terminal disconnect states. */
export function createReconnectBanner(): { setState(state: "connected" | "reconnecting" | "disconnected"): void } {
  const el = document.createElement("div");
  el.className = "vg-hud vg-reconnect-banner";
  el.setAttribute("role", "alert");
  el.style.position = "fixed";
  el.style.top = "50%";
  el.style.left = "50%";
  el.style.transform = "translate(-50%, -50%)";
  el.style.zIndex = "40";
  el.style.pointerEvents = "none";
  el.style.font = "bold 20px monospace";
  el.style.color = "#fff";
  el.style.background = "rgba(0,0,0,0.7)";
  el.style.padding = "16px 24px";
  el.style.borderRadius = "6px";
  el.style.display = "none";
  el.textContent = "Connection lost — reconnecting…";
  document.body.appendChild(el);
  let currentState: "connected" | "reconnecting" | "disconnected" = "connected";
  return {
    setState(state) {
      if (state === currentState) return;
      currentState = state;
      el.style.display = state === "connected" ? "none" : "block";
      el.textContent = state === "reconnecting" ? "Connection lost — reconnecting…" : "Connection lost — reconnect failed. Reload to try again.";
    },
  };
}

/** One player marker fed into Minimap.update() per living/relevant player. */
export interface MinimapPlayerMarker {
  x: number;
  z: number;
  yaw?: number;
}

export interface MinimapPing {
  x: number;
  z: number;
  ageMs: number;
}

export interface Minimap {
  /** Match-only by default; callers opt in for modes that have meaningful team information. */
  setVisible(visible: boolean): void;
  update(state: {
    self: MinimapPlayerMarker | null;
    teammates: readonly MinimapPlayerMarker[];
    visibleEnemies: readonly MinimapPlayerMarker[];
    spike: { state: number; x: number; z: number } | null;
    pings: readonly MinimapPing[];
  }): void;
}

const MINIMAP_FALLBACK_SIZE_PX = 200;
const MINIMAP_PING_LIFETIME_MS = 5000;

/**
 * Responsive top-down minimap, top-left: a prerendered outline of `boxes` (drawn
 * once), then per-frame overlay of self (arrow), living teammates (dots),
 * visible enemies (red dots, per the server's team-shared visibility mask —
 * see @vg/server ServerHost.updateVisibility()), the spike marker, and
 * fading TeamPing markers. World (x, z) maps to canvas space by centering
 * on the level's bounding box — LEVEL_BOXES span ±LEVEL_HALF_EXTENT on both
 * axes (see @vg/sim levels.ts), so a fixed world-half-extent works for our
 * single graybox map without needing per-map calibration.
 */
export function createMinimap(boxes: readonly Box[] = LEVEL_BOXES): Minimap {
  const WORLD_HALF_EXTENT = LEVEL_HALF_EXTENT + 1; // small margin so perimeter walls don't touch the canvas edge

  const canvas = document.createElement("canvas");
  canvas.className = "vg-minimap";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Tactical minimap, north is up");
  canvas.style.position = "fixed";
  canvas.style.zIndex = "10";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d")!;

  const outline = document.createElement("canvas");
  const octx = outline.getContext("2d")!;
  let logicalSize = MINIMAP_FALLBACK_SIZE_PX;
  let visible = false;

  function worldToCanvas(x: number, z: number): { cx: number; cy: number } {
    const point = worldToMinimapPoint(x, z, WORLD_HALF_EXTENT, logicalSize);
    return { cx: point.x, cy: point.y };
  }

  function drawOutline(): void {
    octx.clearRect(0, 0, logicalSize, logicalSize);
    octx.fillStyle = "rgba(215,225,230,0.07)";
    octx.strokeStyle = "rgba(215,225,230,0.28)";
    octx.lineWidth = 0.75;
    for (const box of boxes) {
      const a = worldToCanvas(box.minX, box.minZ);
      const b = worldToCanvas(box.maxX, box.maxZ);
      const left = Math.min(a.cx, b.cx);
      const top = Math.min(a.cy, b.cy);
      const width = Math.abs(b.cx - a.cx);
      const height = Math.abs(b.cy - a.cy);
      octx.fillRect(left, top, width, height);
      octx.strokeRect(left, top, width, height);
    }

    // A tiny north index makes the corrected +Z/up orientation legible at a glance.
    octx.fillStyle = "rgba(255,255,255,0.72)";
    octx.font = "600 9px system-ui, sans-serif";
    octx.textAlign = "center";
    octx.textBaseline = "top";
    octx.fillText("N", logicalSize / 2, 5);
  }

  function resizeBackingStore(): void {
    const measured = Math.round(canvas.getBoundingClientRect().width);
    const nextLogicalSize = measured > 0 ? measured : MINIMAP_FALLBACK_SIZE_PX;
    const backingSize = minimapBackingStoreSize(nextLogicalSize, window.devicePixelRatio);
    if (canvas.width === backingSize && logicalSize === nextLogicalSize) return;

    logicalSize = nextLogicalSize;
    canvas.width = backingSize;
    canvas.height = backingSize;
    outline.width = backingSize;
    outline.height = backingSize;
    const backingScale = backingSize / logicalSize;
    ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    octx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
    drawOutline();
  }

  // Configure once while the element participates in layout, then keep it
  // hidden until match mode explicitly enables it.
  resizeBackingStore();
  canvas.hidden = true;
  window.addEventListener("resize", resizeBackingStore);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeBackingStore).observe(canvas);

  return {
    setVisible(nextVisible) {
      if (visible === nextVisible) return;
      visible = nextVisible;
      canvas.hidden = !visible;
      if (visible) resizeBackingStore();
    },
    update({ self, teammates, visibleEnemies, spike, pings }) {
      if (!visible) return;
      ctx.clearRect(0, 0, logicalSize, logicalSize);
      ctx.drawImage(outline, 0, 0, logicalSize, logicalSize);

      for (const ping of pings) {
        if (ping.ageMs > MINIMAP_PING_LIFETIME_MS) continue;
        const { cx, cy } = worldToCanvas(ping.x, ping.z);
        const alpha = 1 - ping.ageMs / MINIMAP_PING_LIFETIME_MS;
        ctx.strokeStyle = `rgba(255,220,80,${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 6 + (1 - alpha) * 6, 0, Math.PI * 2);
        ctx.stroke();
      }

      if (spike) {
        const { cx, cy } = worldToCanvas(spike.x, spike.z);
        ctx.fillStyle = spike.state === 2 ? "#ff3b3b" : "#ffd54a";
        ctx.beginPath();
        ctx.arc(cx, cy, spike.state === 2 ? 5 : 4, 0, Math.PI * 2);
        ctx.fill();
        if (spike.state === 2) {
          ctx.strokeStyle = "rgba(255,59,59,0.6)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(cx, cy, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.fillStyle = "#3fa7ff";
      for (const t of teammates) {
        const { cx, cy } = worldToCanvas(t.x, t.z);
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = "#ff3b3b";
      for (const e of visibleEnemies) {
        const { cx, cy } = worldToCanvas(e.x, e.z);
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      if (self) {
        const { cx, cy } = worldToCanvas(self.x, self.z);
        const yaw = self.yaw ?? 0;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(yaw);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(4, 5);
        ctx.lineTo(-4, 5);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    },
  };
}

// ---- M4a: agent select, ability HUD, flash overlay, ability world-entity rendering ----

const AGENT_INFO: ReadonlyArray<{ id: number; name: string; role: string; blurb: string }> = [
  { id: AGENT_ZEPHYR, name: "Zephyr", role: "Duelist", blurb: "Updraft, Gust, Dash, Blades (ult knives)." },
  { id: AGENT_UMBRA, name: "Umbra", role: "Controller", blurb: "Blind Orb, Step, Shroud, Veil (ult smoke wall)." },
  { id: AGENT_SONAR, name: "Sonar", role: "Initiator", blurb: "Shock Dart, Pulse, Recon Dart, Rail (ult through-wall shots)." },
  { id: AGENT_LUMEN, name: "Lumen", role: "Sentinel", blurb: "Slow Zone, Wall, Mend, Resurrect (ult)." },
];

/** DOM overlay: agent select, shown only during the waiting phase (spec). Click sends an AgentSelectCmd via `onPick`; teammates' current picks are shown from the latest Snapshot via `setPicks()`. */
export interface AgentSelectOverlay {
  setOpen(open: boolean): void;
  /** `picks[i]` = agentId picked by player i (AGENT_NONE/255 if unpicked), `myTeam[i]` = that player's team, `localIndex`/`localTeam` identify self for the "taken by teammate" grey-out. */
  setPicks(picks: readonly number[], teams: readonly number[], localIndex: number, myAgentId: number): void;
}

export function createAgentSelectOverlay(onPick: (agentId: number) => void): AgentSelectOverlay {
  const overlay = document.createElement("div");
  overlay.className = "vg-hud vg-modal-backdrop";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "25";
  overlay.style.display = "none";
  overlay.style.alignItems = "center";
  overlay.style.justifyContent = "center";
  overlay.style.background = "rgba(0,0,0,0.7)";
  overlay.style.font = "14px monospace";
  overlay.style.color = "#fff";

  const panel = document.createElement("div");
  panel.className = "vg-panel vg-agent-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "vg-agent-select-title");
  panel.tabIndex = -1;
  panel.style.background = "#1c1f24";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "6px";
  panel.style.padding = "20px 24px";
  panel.style.display = "flex";
  panel.style.flexDirection = "column";
  panel.style.gap = "8px";
  overlay.appendChild(panel);

  const title = document.createElement("div");
  title.className = "vg-panel__title";
  title.id = "vg-agent-select-title";
  title.textContent = "SELECT AGENT (waiting for match start)";
  title.style.marginBottom = "6px";
  title.style.opacity = "0.85";
  panel.appendChild(title);

  const rows = AGENT_INFO.map((agent) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "vg-agent-panel__row";
    row.setAttribute("aria-pressed", "false");
    row.style.padding = "8px 10px";
    row.style.borderRadius = "4px";
    row.style.cursor = "pointer";
    row.style.border = "1px solid transparent";
    row.style.width = "100%";
    row.style.background = "transparent";
    row.style.color = "inherit";
    row.style.font = "inherit";
    row.style.textAlign = "left";
    const heading = document.createElement("span");
    heading.style.display = "block";
    heading.textContent = `${agent.name} — ${agent.role}`;
    heading.style.fontWeight = "bold";
    const blurb = document.createElement("span");
    blurb.style.display = "block";
    blurb.textContent = agent.blurb;
    blurb.style.opacity = "0.75";
    blurb.style.fontSize = "12px";
    const takenLabel = document.createElement("span");
    takenLabel.style.display = "block";
    takenLabel.style.fontSize = "11px";
    takenLabel.style.color = "#ffd54a";
    row.append(heading, blurb, takenLabel);
    row.addEventListener("click", () => onPick(agent.id));
    row.addEventListener("mouseenter", () => (row.style.background = "rgba(255,255,255,0.08)"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    panel.appendChild(row);
    return { row, takenLabel, agentId: agent.id };
  });

  document.body.appendChild(overlay);
  let open = false;
  let previouslyFocused: HTMLElement | null = null;
  panel.addEventListener("keydown", (event) => {
    if (open) trapModalFocus(event, panel);
  });

  return {
    setOpen(nextOpen: boolean) {
      if (open === nextOpen) return;
      open = nextOpen;
      overlay.style.display = open ? "flex" : "none";
      overlay.setAttribute("aria-hidden", String(!open));
      if (open) {
        previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        (rows.find(({ row }) => !row.disabled)?.row ?? panel).focus();
      } else if (previouslyFocused) {
        previouslyFocused.focus();
        previouslyFocused = null;
      }
    },
    setPicks(picks, teams, localIndex, myAgentId) {
      const localTeam = teams[localIndex] ?? 255;
      for (const { row, takenLabel, agentId } of rows) {
        let takenByTeammate = false;
        let pickerIndex = -1;
        for (let i = 0; i < picks.length; i++) {
          if (i === localIndex) continue;
          if (picks[i] === agentId && teams[i] === localTeam && localTeam !== 255) {
            takenByTeammate = true;
            pickerIndex = i;
            break;
          }
        }
        const isMine = myAgentId === agentId;
        row.style.opacity = takenByTeammate && !isMine ? "0.35" : "1";
        row.style.borderColor = isMine ? "#4dafff" : "transparent";
        row.disabled = takenByTeammate && !isMine;
        row.style.cursor = row.disabled ? "not-allowed" : "pointer";
        row.setAttribute("aria-pressed", String(isMine));
        takenLabel.textContent = isMine ? "— your pick" : takenByTeammate ? `— taken by teammate P${pickerIndex}` : "";
      }
    },
  };
}

const ABILITY_SLOT_KEYS = ["C", "Q", "F", "X"] as const;

/** Bottom ability bar: 4 slots (basic1/basic2/signature/ult) with charge counts and ult N/cost dots. */
export interface AbilityHud {
  /** Matches combat HUD phase gating; agent data may keep updating while hidden. */
  setVisible(visible: boolean): void;
  update(info: { agentId: number; charges: readonly [number, number, number, number]; ultPoints: number }): void;
}

export function createAbilityHud(): AbilityHud {
  const container = document.createElement("div");
  container.className = "vg-hud vg-ability-hud";
  container.style.position = "fixed";
  container.style.zIndex = "10";
  container.style.display = "none";
  container.style.gap = "8px";
  container.style.font = "12px monospace";
  container.style.color = "#fff";
  container.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  document.body.appendChild(container);

  const slots = ABILITY_SLOT_KEYS.map((key) => {
    const box = document.createElement("div");
    box.className = "vg-ability-hud__slot";
    box.style.background = "rgba(0,0,0,0.4)";
    box.style.border = "1px solid rgba(255,255,255,0.35)";
    box.style.borderRadius = "4px";
    box.style.padding = "4px 8px";
    box.style.minWidth = "44px";
    box.style.textAlign = "center";
    const keyLabel = document.createElement("div");
    keyLabel.textContent = key;
    keyLabel.style.opacity = "0.6";
    const valueLabel = document.createElement("div");
    valueLabel.style.fontWeight = "bold";
    box.append(keyLabel, valueLabel);
    container.appendChild(box);
    return { box, valueLabel };
  });

  let visible = false;
  let hasAgent = false;

  function syncVisibility(): void {
    container.style.display = visible && hasAgent ? "flex" : "none";
  }

  return {
    setVisible(nextVisible) {
      visible = nextVisible;
      syncVisibility();
    },
    update({ agentId, charges, ultPoints }) {
      hasAgent = agentId !== AGENT_NONE;
      syncVisibility();
      if (!hasAgent) return;
      const def = AGENT_INFO.find((a) => a.id === agentId);
      const abilities = ABILITIES.filter((a) => a.agentId === agentId).sort((a, b) => a.slot - b.slot);
      for (let slot = 0; slot < 4; slot++) {
        const ability = abilities[slot];
        const { valueLabel } = slots[slot]!;
        if (!ability) {
          valueLabel.textContent = "--";
          continue;
        }
        if (slot === 3) {
          valueLabel.textContent = `${ultPoints}/${ability.ultCost}`;
          slots[slot]!.box.style.opacity = ultPoints >= ability.ultCost ? "1" : "0.6";
        } else {
          valueLabel.textContent = ability.maxCharges > 0 ? String(charges[slot]) : "•";
        }
      }
      void def;
    },
  };
}

/** Fullscreen white flash overlay (Umbra's Blind Orb / Zephyr's-not-this-one — any FLASH_HALF/FULL debuff), opacity driven by flashedTicksLeft. */
export interface FlashOverlay {
  update(flashedTicksLeft: number, flashIntensity: number): void;
}

const FLASH_FULL_TICKS = 128; // 2s @ 64Hz — see @vg/sim abilities/effects.ts applyFlash
const FLASH_HALF_TICKS = 51; // 0.8s

/**
 * M5: opacity now follows vfx.ts's flashAfterimageCurve() (an ease-out-cubic
 * "afterimage" shape — stays bright longer, then falls away quickly at the
 * very end) instead of a flat linear ramp, closer to how a real flashbang
 * afterimage actually lingers before fading.
 */
export function createFlashOverlay(): FlashOverlay {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.pointerEvents = "none";
  el.style.background = "#ffffff";
  el.style.opacity = "0";
  el.style.zIndex = "18";
  document.body.appendChild(el);
  return {
    update(flashedTicksLeft, flashIntensity) {
      if (flashedTicksLeft <= 0) {
        el.style.opacity = "0";
        return;
      }
      const totalTicks = flashIntensity === FLASH_FULL ? FLASH_FULL_TICKS : FLASH_HALF_TICKS;
      const maxOpacity = flashIntensity === FLASH_FULL ? 1 : 0.55;
      const fraction = flashAfterimageCurve(flashedTicksLeft / totalTicks);
      el.style.opacity = String(Math.max(0, Math.min(maxOpacity, fraction * maxOpacity)));
    },
  };
}

/**
 * Syncs one Three.js mesh per live ability world-entity to `state`'s
 * entType/entX../entParam arrays each frame: smoke = opaque lambert sphere
 * (no transparency games, per spec), walls = HP-tinted boxes, slow zones =
 * flat discs, projectiles = small spheres, recon darts = expanding wire
 * rings (approximated here as a static wire torus, re-created per pulse
 * would need pulse timing data this renderer doesn't track — a reasonable
 * simplification left for a follow-up pass), orbs = floating icosahedra.
 */
export interface AbilityEntityRenderer {
  sync(state: SimState): void;
}

export function createAbilityEntityRenderer(scene: THREE.Scene): AbilityEntityRenderer {
  const meshes = new Map<number, THREE.Mesh>();
  // M5: smoke's "soft fresnel-ish edge" — a second, larger, more-transparent
  // outer shell layered over the original opaque inner sphere. Shader-free
  // (spec: "two-layer opacity trick") — no fresnel shader, just two spheres.
  const smokeOuterShells = new Map<number, THREE.Mesh>();

  function smokeOuterShellFor(slot: number): THREE.Mesh {
    const existing = smokeOuterShells.get(slot);
    if (existing) return existing;
    const geometry = new THREE.SphereGeometry(1, 16, 12);
    const material = new THREE.MeshBasicMaterial({ color: 0xeef2f6, transparent: true, opacity: 0.25, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);
    smokeOuterShells.set(slot, mesh);
    return mesh;
  }

  function removeSmokeOuterShell(slot: number): void {
    const existing = smokeOuterShells.get(slot);
    if (!existing) return;
    scene.remove(existing);
    existing.geometry.dispose();
    (existing.material as THREE.Material).dispose();
    smokeOuterShells.delete(slot);
  }

  function meshFor(slot: number, entType: number): THREE.Mesh {
    const existing = meshes.get(slot);
    if (existing && existing.userData["entType"] === entType) return existing;
    if (existing) {
      scene.remove(existing);
      existing.geometry.dispose();
      (existing.material as THREE.Material).dispose();
      meshes.delete(slot);
    }
    let geometry: THREE.BufferGeometry;
    let material: THREE.Material;
    switch (entType) {
      case ENT_SMOKE:
        geometry = new THREE.SphereGeometry(1, 16, 12);
        material = new THREE.MeshLambertMaterial({ color: 0xd8dee6 });
        break;
      case ENT_WALL_BOX:
        geometry = new THREE.BoxGeometry(1, 1, 1);
        material = new THREE.MeshStandardMaterial({ color: 0x4dafff });
        break;
      case ENT_SLOW_ZONE:
        geometry = new THREE.CylinderGeometry(1, 1, 0.05, 24);
        material = new THREE.MeshBasicMaterial({ color: 0x8855ff, transparent: true, opacity: 0.4 });
        break;
      case ENT_PROJECTILE:
        geometry = new THREE.SphereGeometry(0.15, 8, 6);
        material = new THREE.MeshStandardMaterial({ color: 0xffaa33 });
        break;
      case ENT_RECON_DART:
        geometry = new THREE.TorusGeometry(0.6, 0.03, 6, 16);
        material = new THREE.MeshBasicMaterial({ color: 0xff5555, wireframe: true });
        break;
      case ENT_ULT_ORB:
        geometry = new THREE.IcosahedronGeometry(0.35, 0);
        material = new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x554400 });
        break;
      default:
        geometry = new THREE.SphereGeometry(0.1, 4, 4);
        material = new THREE.MeshBasicMaterial({ color: 0xff00ff });
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData["entType"] = entType;
    scene.add(mesh);
    meshes.set(slot, mesh);
    return mesh;
  }

  return {
    sync(state: SimState) {
      for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) {
        const entType = state.entType[e]!;
        if (entType === ENT_NONE) {
          const existing = meshes.get(e);
          if (existing) {
            scene.remove(existing);
            existing.geometry.dispose();
            (existing.material as THREE.Material).dispose();
            meshes.delete(e);
          }
          removeSmokeOuterShell(e);
          continue;
        }
        const mesh = meshFor(e, entType);
        mesh.position.set(state.entX[e]!, state.entY[e]!, state.entZ[e]!);
        if (entType !== ENT_SMOKE) removeSmokeOuterShell(e);
        if (entType === ENT_SMOKE) {
          const abilityId = state.entAbilityId[e]!;
          const radius = ABILITIES.find((a) => a.id === abilityId)?.radius ?? 3;
          mesh.scale.setScalar(radius);
          const outer = smokeOuterShellFor(e);
          outer.position.copy(mesh.position);
          outer.scale.setScalar(radius * 1.12);
        } else if (entType === ENT_WALL_BOX) {
          const alignX = state.entVelX[e]! !== 0;
          mesh.scale.set(alignX ? 2 : 0.4, 2, alignX ? 0.4 : 2);
          const hpFrac = Math.max(0, Math.min(1, state.entParam[e]! / WALL_BOX_MAX_HP));
          (mesh.material as THREE.MeshStandardMaterial).color.setRGB(1 - hpFrac, hpFrac, 0.3);
        } else if (entType === ENT_SLOW_ZONE) {
          const abilityId = state.entAbilityId[e]!;
          const radius = ABILITIES.find((a) => a.id === abilityId)?.radius ?? 4;
          mesh.scale.set(radius, 1, radius);
        }
      }
    },
  };
}
