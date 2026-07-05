import * as THREE from "three";
import { CROUCH_HEIGHT, STAND_HEIGHT, WEAPONS } from "@vg/sim";
import type { RemotePose } from "./interpolation.js";
import type { GrayboxSurface } from "./graybox.js";

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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1d21);
  scene.fog = new THREE.Fog(0x1a1d21, 25, 55);

  const camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.05, 200);

  // Brightened for M2 (user feedback: the graybox read too dark to make out
  // geometry clearly at a glance) — one tasteful change, no post-processing:
  // raise both the hemisphere fill and the sun a step so floors/walls/props
  // separate visually without blowing out highlights.
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x40403a, 1.3);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(20, 30, 10);
  scene.add(sun);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}

/** Builds one mesh per graybox surface — the same box list drives sim collision (see graybox.ts). */
export function buildGrayboxMeshes(scene: THREE.Scene, boxes: readonly GrayboxSurface[]): void {
  for (const b of boxes) {
    const sizeX = b.maxX - b.minX;
    const sizeY = b.maxY - b.minY;
    const sizeZ = b.maxZ - b.minZ;
    const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
    const material = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.9, metalness: 0.05 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    scene.add(mesh);
  }
}

export interface FpsCounter {
  update(fps: number): void;
  /** Extra debug lines appended below the fps line (net stats — see net.ts's NetHud). */
  updateExtra(lines: readonly string[]): void;
}

export function createFpsCounter(): FpsCounter {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.top = "8px";
  el.style.left = "8px";
  el.style.padding = "2px 6px";
  el.style.font = "12px monospace";
  el.style.color = "#0f0";
  el.style.background = "rgba(0,0,0,0.5)";
  el.style.zIndex = "10";
  el.style.whiteSpace = "pre";
  el.textContent = "fps: --";
  document.body.appendChild(el);
  let fpsLine = "fps: --";
  let extraLines: readonly string[] = [];
  function render(): void {
    el.textContent = [fpsLine, ...extraLines].join("\n");
  }
  return {
    update(fps: number) {
      fpsLine = `fps: ${fps.toFixed(0)}`;
      render();
    },
    updateExtra(lines: readonly string[]) {
      extraLines = lines;
      render();
    },
  };
}

/** Team-agnostic capsule-proxy mesh for one remote player (cylinder + sphere caps). */
export interface RemotePlayerProxy {
  group: THREE.Group;
  setPose(pose: RemotePose): void;
  dispose(scene: THREE.Scene): void;
}

export function createRemotePlayerProxy(scene: THREE.Scene): RemotePlayerProxy {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x3fa7ff, roughness: 0.7, metalness: 0.1 });
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1, 12), material);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), material);
  group.add(cylinder, head);
  scene.add(group);

  return {
    group,
    setPose(pose: RemotePose) {
      const height = pose.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const cylinderHeight = Math.max(0.01, height - 0.8); // total height minus the two 0.4-radius caps
      cylinder.geometry.dispose();
      cylinder.geometry = new THREE.CylinderGeometry(0.4, 0.4, cylinderHeight, 12);
      cylinder.position.set(0, 0.4 + cylinderHeight / 2, 0);
      head.position.set(0, height - 0.4, 0);
      group.position.set(pose.posX, pose.posY, pose.posZ);
      group.rotation.set(0, pose.yaw + Math.PI, 0);
      group.visible = pose.connected;
    },
    dispose(targetScene: THREE.Scene) {
      targetScene.remove(group);
      cylinder.geometry.dispose();
      head.geometry.dispose();
      material.dispose();
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
  container.style.position = "fixed";
  container.style.top = "8px";
  container.style.right = "8px";
  container.style.zIndex = "10";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.gap = "2px";
  container.style.font = "13px monospace";
  container.style.color = "#fff";
  container.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  document.body.appendChild(container);

  function weaponName(weaponId: number): string {
    return WEAPONS.find((w) => w.id === weaponId)?.name ?? "?";
  }

  return {
    push(entry: KillFeedEntry) {
      const row = document.createElement("div");
      row.style.background = "rgba(0,0,0,0.35)";
      row.style.padding = "2px 6px";
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
}

export function createBuyMenu(onBuy: (itemId: number) => void): BuyMenu {
  const overlay = document.createElement("div");
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
  panel.style.background = "#1c1f24";
  panel.style.border = "1px solid #444";
  panel.style.borderRadius = "6px";
  panel.style.padding = "16px 20px";
  panel.style.minWidth = "320px";
  overlay.appendChild(panel);

  const title = document.createElement("div");
  title.textContent = "BUY (press 1-8, click, B or Esc to close)";
  title.style.marginBottom = "10px";
  title.style.opacity = "0.8";
  panel.appendChild(title);

  const creditsLine = document.createElement("div");
  creditsLine.style.marginBottom = "10px";
  panel.appendChild(creditsLine);

  const items: Array<{ itemId: number; label: string; price: number }> = [
    ...WEAPONS.map((w) => ({ itemId: w.id, label: w.name, price: w.price })),
    { itemId: 200, label: "Light Armor", price: 400 },
    { itemId: 201, label: "Heavy Armor", price: 1000 },
  ];

  let credits = 0;
  const rows: HTMLDivElement[] = [];
  items.forEach((item, i) => {
    const row = document.createElement("div");
    row.style.padding = "4px 8px";
    row.style.cursor = "pointer";
    row.style.borderRadius = "3px";
    row.textContent = `${i + 1}. ${item.label} — ${item.price}cr`;
    row.addEventListener("mouseenter", () => (row.style.background = "rgba(255,255,255,0.1)"));
    row.addEventListener("mouseleave", () => (row.style.background = "transparent"));
    row.addEventListener("click", () => onBuy(item.itemId));
    panel.appendChild(row);
    rows.push(row);
  });

  document.body.appendChild(overlay);

  return {
    setOpen(open: boolean) {
      overlay.style.display = open ? "flex" : "none";
    },
    setState(newCredits: number, alive: boolean) {
      credits = newCredits;
      creditsLine.textContent = `Credits: ${credits}${alive ? "" : " (dead — can't buy)"}`;
      rows.forEach((row, i) => {
        const affordable = alive && items[i]!.price <= credits;
        row.style.opacity = affordable ? "1" : "0.4";
      });
    },
  };
}

/** Health/armor/weapon/credits/respawn-countdown HUD overlay. */
export interface CombatHud {
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
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.bottom = "12px";
  el.style.left = "50%";
  el.style.transform = "translateX(-50%)";
  el.style.zIndex = "10";
  el.style.font = "15px monospace";
  el.style.color = "#fff";
  el.style.textShadow = "0 0 3px rgba(0,0,0,0.9)";
  el.style.textAlign = "center";
  el.style.whiteSpace = "pre";
  document.body.appendChild(el);

  const respawnEl = document.createElement("div");
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

  return {
    update({ health, armor, weaponName, magAmmo, reserveAmmo, credits, alive, respawnSecondsLeft }) {
      el.textContent = `HP ${health}  AR ${armor}   ${weaponName} ${magAmmo}/${reserveAmmo}   $${credits}`;
      if (!alive) {
        respawnEl.style.display = "block";
        respawnEl.textContent = `respawning in ${Math.ceil(respawnSecondsLeft)}s`;
      } else {
        respawnEl.style.display = "none";
      }
    },
  };
}
