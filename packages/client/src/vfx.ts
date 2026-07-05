// M5 VFX polish: muzzle flash, pooled impact sparks, pooled death markers,
// and the planted-spike beacon. All pools are pre-allocated once at creation
// and reused frame to frame — no per-frame allocations in the hot path
// (spec: "no per-frame allocations in the new animation/audio paths").
import * as THREE from "three";
import { SPIKE_PLANTED, type SimState } from "@vg/sim";

// ---- Muzzle flash: a brief point light + small sprite-like quad at the shot origin. ----
export interface MuzzleFlashPool {
  spawn(position: THREE.Vector3): void;
}

const MUZZLE_FLASH_POOL_SIZE = 4;
const MUZZLE_FLASH_LIFETIME_MS = 45;

export function createMuzzleFlashPool(scene: THREE.Scene): MuzzleFlashPool {
  const lights: THREE.PointLight[] = [];
  const expiresAt: number[] = [];
  for (let i = 0; i < MUZZLE_FLASH_POOL_SIZE; i++) {
    const light = new THREE.PointLight(0xffdd88, 0, 4);
    scene.add(light);
    lights.push(light);
    expiresAt.push(0);
  }
  let cursor = 0;
  return {
    spawn(position: THREE.Vector3) {
      const i = cursor;
      cursor = (cursor + 1) % MUZZLE_FLASH_POOL_SIZE;
      const light = lights[i]!;
      light.position.copy(position);
      light.intensity = 6;
      expiresAt[i] = performance.now() + MUZZLE_FLASH_LIFETIME_MS;
      const thisIndex = i;
      setTimeout(() => {
        if (performance.now() >= expiresAt[thisIndex]!) lights[thisIndex]!.intensity = 0;
      }, MUZZLE_FLASH_LIFETIME_MS);
    },
  };
}

// ---- Impact sparks: a small pooled particle burst (5-8 particles) at a hit point. ----
export interface ImpactSparksPool {
  spawn(position: THREE.Vector3): void;
}

const SPARKS_PER_BURST = 6;
const SPARK_BURST_POOL_SIZE = 6; // concurrent bursts
const SPARK_LIFETIME_MS = 220;

export function createImpactSparksPool(scene: THREE.Scene): ImpactSparksPool {
  const geometry = new THREE.BufferGeometry();
  const totalParticles = SPARK_BURST_POOL_SIZE * SPARKS_PER_BURST;
  const positions = new Float32Array(totalParticles * 3);
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({ color: 0xffcc66, size: 0.05, transparent: true, opacity: 1 });
  const points = new THREE.Points(geometry, material);
  scene.add(points);

  const burstExpiresAt = new Array<number>(SPARK_BURST_POOL_SIZE).fill(0);
  let cursor = 0;

  function hideBurst(burstIndex: number): void {
    const base = burstIndex * SPARKS_PER_BURST * 3;
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      positions[base + i * 3 + 1] = -9999; // park off-screen rather than resizing the buffer
    }
    geometry.attributes["position"]!.needsUpdate = true;
  }

  return {
    spawn(position: THREE.Vector3) {
      const burstIndex = cursor;
      cursor = (cursor + 1) % SPARK_BURST_POOL_SIZE;
      const base = burstIndex * SPARKS_PER_BURST * 3;
      for (let i = 0; i < SPARKS_PER_BURST; i++) {
        const spread = 0.08;
        positions[base + i * 3 + 0] = position.x + (Math.random() - 0.5) * spread;
        positions[base + i * 3 + 1] = position.y + (Math.random() - 0.5) * spread;
        positions[base + i * 3 + 2] = position.z + (Math.random() - 0.5) * spread;
      }
      geometry.attributes["position"]!.needsUpdate = true;
      burstExpiresAt[burstIndex] = performance.now() + SPARK_LIFETIME_MS;
      setTimeout(() => {
        if (performance.now() >= burstExpiresAt[burstIndex]!) hideBurst(burstIndex);
      }, SPARK_LIFETIME_MS);
    },
  };
}

// ---- Death marker: a small cross fading at the death spot. ----
export interface DeathMarkerPool {
  spawn(position: THREE.Vector3): void;
}

const DEATH_MARKER_POOL_SIZE = 8;
const DEATH_MARKER_LIFETIME_MS = 4000;

export function createDeathMarkerPool(scene: THREE.Scene): DeathMarkerPool {
  const markers: THREE.Group[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  const expiresAt: number[] = [];
  for (let i = 0; i < DEATH_MARKER_POOL_SIZE; i++) {
    const material = new THREE.MeshBasicMaterial({ color: 0xff3b3b, transparent: true, opacity: 0 });
    const barA = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.03, 0.03), material);
    barA.rotation.z = Math.PI / 4;
    const barB = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.03, 0.03), material);
    barB.rotation.z = -Math.PI / 4;
    const group = new THREE.Group();
    group.add(barA, barB);
    group.rotation.x = Math.PI / 2; // lie flat on the ground
    scene.add(group);
    markers.push(group);
    materials.push(material);
    expiresAt.push(0);
  }
  let cursor = 0;

  function fade(i: number): void {
    const remaining = expiresAt[i]! - performance.now();
    if (remaining <= 0) {
      materials[i]!.opacity = 0;
      return;
    }
    materials[i]!.opacity = Math.max(0, remaining / DEATH_MARKER_LIFETIME_MS);
    requestAnimationFrame(() => fade(i));
  }

  return {
    spawn(position: THREE.Vector3) {
      const i = cursor;
      cursor = (cursor + 1) % DEATH_MARKER_POOL_SIZE;
      markers[i]!.position.set(position.x, position.y + 0.02, position.z);
      materials[i]!.opacity = 0.9;
      expiresAt[i] = performance.now() + DEATH_MARKER_LIFETIME_MS;
      requestAnimationFrame(() => fade(i));
    },
  };
}

// ---- Spike beacon: pulsing red light + emissive marker while planted. ----
export interface SpikeBeacon {
  sync(state: SimState, nowSeconds: number): void;
}

export function createSpikeBeacon(scene: THREE.Scene): SpikeBeacon {
  const light = new THREE.PointLight(0xff3b3b, 0, 8);
  scene.add(light);
  const material = new THREE.MeshStandardMaterial({ color: 0x3a0d0d, emissive: 0xff2020, emissiveIntensity: 1 });
  const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), material);
  mesh.visible = false;
  scene.add(mesh);

  return {
    sync(state: SimState, nowSeconds: number) {
      const planted = state.spikeState === SPIKE_PLANTED;
      mesh.visible = planted;
      if (!planted) {
        light.intensity = 0;
        return;
      }
      mesh.position.set(state.spikeX, state.spikeY + 0.2, state.spikeZ);
      light.position.copy(mesh.position);
      const pulse = 0.5 + 0.5 * Math.sin(nowSeconds * 6);
      light.intensity = 1.5 + pulse * 2.5;
      material.emissiveIntensity = 0.6 + pulse * 1.2;
    },
  };
}

// ---- Flash whiteout: an afterimage-style fade curve (fast rise, slow
// exponential-ish decay) instead of the old linear ramp — matches how a
// real flashbang afterimage lingers before falling off. Pure math, reused by
// render.ts's FlashOverlay. ----
export function flashAfterimageCurve(fraction01: number): number {
  const f = Math.max(0, Math.min(1, fraction01));
  // Ease-out cubic: stays bright longer, then falls away quickly at the end.
  return 1 - Math.pow(1 - f, 3);
}
