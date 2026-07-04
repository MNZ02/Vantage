import * as THREE from "three";
import { CROUCH_HEIGHT, STAND_HEIGHT } from "@vg/sim";
import type { RemotePose } from "./interpolation.js";
import type { GrayboxSurface } from "./graybox.js";

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

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
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

/** Brief crosshair accent shown to the shooter on a confirmed hit. */
export function createHitmarker(): { show(): void } {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.top = "50%";
  el.style.left = "50%";
  el.style.transform = "translate(-50%, -50%)";
  el.style.width = "18px";
  el.style.height = "18px";
  el.style.pointerEvents = "none";
  el.style.zIndex = "11";
  el.style.opacity = "0";
  el.style.transition = "opacity 150ms ease-out";
  el.style.font = "18px monospace";
  el.style.color = "#ff3b3b";
  el.style.textAlign = "center";
  el.style.lineHeight = "18px";
  el.textContent = "+";
  document.body.appendChild(el);
  return {
    show() {
      el.style.transition = "none";
      el.style.opacity = "1";
      requestAnimationFrame(() => {
        el.style.transition = "opacity 150ms ease-out";
        el.style.opacity = "0";
      });
    },
  };
}
