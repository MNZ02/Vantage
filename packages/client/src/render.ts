import * as THREE from "three";
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
  el.textContent = "fps: --";
  document.body.appendChild(el);
  return {
    update(fps: number) {
      el.textContent = `fps: ${fps.toFixed(0)}`;
    },
  };
}
