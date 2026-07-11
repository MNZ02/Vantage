// M5 VFX polish: muzzle flash, pooled impact sparks, pooled death markers,
// and the planted-spike beacon. All pools are pre-allocated once at creation
// and reused frame to frame — no per-frame allocations in the hot path
// (spec: "no per-frame allocations in the new animation/audio paths").
import * as THREE from "three";
import { SPIKE_DROPPED, SPIKE_PLANTED, type SimState } from "@vg/sim";
import { cloneModel, loadModel } from "./assets.js";

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
  const colors = new Float32Array(totalParticles * 3);
  const velocities = new Float32Array(totalParticles * 3);
  for (let i = 0; i < totalParticles; i++) positions[i * 3 + 1] = -9999;
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffffff,
    vertexColors: true,
    size: 0.065,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  const burstBornAt = new Array<number>(SPARK_BURST_POOL_SIZE).fill(0);
  const burstExpiresAt = new Array<number>(SPARK_BURST_POOL_SIZE).fill(0);
  let cursor = 0;
  let animationRunning = false;
  let lastFrameMs = 0;

  function hideBurst(burstIndex: number): void {
    const base = burstIndex * SPARKS_PER_BURST * 3;
    for (let i = 0; i < SPARKS_PER_BURST; i++) {
      positions[base + i * 3 + 1] = -9999; // park off-screen rather than resizing the buffer
      colors[base + i * 3 + 0] = 0;
      colors[base + i * 3 + 1] = 0;
      colors[base + i * 3 + 2] = 0;
    }
  }

  function animate(nowMs: number): void {
    const dt = lastFrameMs > 0 ? Math.min(0.033, (nowMs - lastFrameMs) / 1000) : 0;
    lastFrameMs = nowMs;
    let hasActiveBurst = false;
    for (let burstIndex = 0; burstIndex < SPARK_BURST_POOL_SIZE; burstIndex++) {
      const expiresAt = burstExpiresAt[burstIndex]!;
      if (expiresAt <= 0) continue;
      if (nowMs >= expiresAt) {
        hideBurst(burstIndex);
        burstExpiresAt[burstIndex] = 0;
        continue;
      }
      hasActiveBurst = true;
      const life01 = (nowMs - burstBornAt[burstIndex]!) / SPARK_LIFETIME_MS;
      const brightness = Math.max(0, 1 - life01);
      const base = burstIndex * SPARKS_PER_BURST * 3;
      for (let i = 0; i < SPARKS_PER_BURST; i++) {
        const p = base + i * 3;
        velocities[p + 1] = velocities[p + 1]! - 4.8 * dt;
        positions[p + 0] = positions[p + 0]! + velocities[p + 0]! * dt;
        positions[p + 1] = positions[p + 1]! + velocities[p + 1]! * dt;
        positions[p + 2] = positions[p + 2]! + velocities[p + 2]! * dt;
        // White-hot core cooling toward amber, then black (PointsMaterial
        // multiplies these vertex colors by its white base color).
        colors[p + 0] = brightness;
        colors[p + 1] = brightness * (0.42 + brightness * 0.42);
        colors[p + 2] = brightness * 0.12;
      }
    }
    geometry.attributes["position"]!.needsUpdate = true;
    geometry.attributes["color"]!.needsUpdate = true;
    if (hasActiveBurst) {
      requestAnimationFrame(animate);
    } else {
      animationRunning = false;
      lastFrameMs = 0;
    }
  }

  return {
    spawn(position: THREE.Vector3) {
      const burstIndex = cursor;
      cursor = (cursor + 1) % SPARK_BURST_POOL_SIZE;
      const base = burstIndex * SPARKS_PER_BURST * 3;
      for (let i = 0; i < SPARKS_PER_BURST; i++) {
        const p = base + i * 3;
        const angle = Math.random() * Math.PI * 2;
        const horizontalSpeed = 0.35 + Math.random() * 0.9;
        positions[p + 0] = position.x + (Math.random() - 0.5) * 0.035;
        positions[p + 1] = position.y + (Math.random() - 0.5) * 0.035;
        positions[p + 2] = position.z + (Math.random() - 0.5) * 0.035;
        velocities[p + 0] = Math.cos(angle) * horizontalSpeed;
        velocities[p + 1] = 0.35 + Math.random() * 1.2;
        velocities[p + 2] = Math.sin(angle) * horizontalSpeed;
        colors[p + 0] = 1;
        colors[p + 1] = 0.84;
        colors[p + 2] = 0.12;
      }
      geometry.attributes["position"]!.needsUpdate = true;
      geometry.attributes["color"]!.needsUpdate = true;
      const nowMs = performance.now();
      burstBornAt[burstIndex] = nowMs;
      burstExpiresAt[burstIndex] = nowMs + SPARK_LIFETIME_MS;
      if (!animationRunning) {
        animationRunning = true;
        lastFrameMs = nowMs;
        requestAnimationFrame(animate);
      }
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

// ---- Spike world object: the authored prop_spike.glb (octahedron until it
// loads), shown while DROPPED on the ground or PLANTED, plus a pulsing red
// point light while planted. Dropped shows the model without the alarm
// light — you can find it by sight, matching the minimap's dropped marker. ----
export interface SpikeBeacon {
  /** Pass null to actively hide stale round-end/match-end spike state. */
  sync(state: SimState | null, nowSeconds: number): void;
}

export function createSpikeBeacon(scene: THREE.Scene): SpikeBeacon {
  const light = new THREE.PointLight(0xff3b3b, 0, 8);
  scene.add(light);
  const holder = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0x3a0d0d, emissive: 0xff2020, emissiveIntensity: 1 });
  let pulseMaterials: THREE.MeshStandardMaterial[] = [material];
  const placeholder = new THREE.Mesh(new THREE.OctahedronGeometry(0.18, 0), material);
  placeholder.position.y = 0.2;
  holder.add(placeholder);
  holder.visible = false;
  scene.add(holder);

  void loadModel("prop_spike").then((master) => {
    if (!master) return;
    // Clone materials because the spike's alarm pulse is per-instance state;
    // mutating the cached GLB master would leak emissive changes to any other
    // prop_spike clone. Keep concrete MeshStandardMaterial refs so the pulse
    // continues after the procedural placeholder is removed.
    const cloned = cloneModel(master, true);
    pulseMaterials = cloned.materials.filter((candidate): candidate is THREE.MeshStandardMaterial => candidate instanceof THREE.MeshStandardMaterial);
    for (const pulseMaterial of pulseMaterials) {
      pulseMaterial.emissive.setHex(0xff2020);
      pulseMaterial.emissiveIntensity = 0.3;
    }
    holder.clear(); // .glb origin is at the floor — no lift needed
    holder.add(cloned.group);
  });

  return {
    sync(state: SimState | null, nowSeconds: number) {
      if (!state) {
        holder.visible = false;
        light.intensity = 0;
        for (const pulseMaterial of pulseMaterials) pulseMaterial.emissiveIntensity = 0.3;
        return;
      }
      const planted = state.spikeState === SPIKE_PLANTED;
      const dropped = state.spikeState === SPIKE_DROPPED;
      holder.visible = planted || dropped;
      if (!holder.visible) {
        light.intensity = 0;
        for (const pulseMaterial of pulseMaterials) pulseMaterial.emissiveIntensity = 0.3;
        return;
      }
      holder.position.set(state.spikeX, state.spikeY, state.spikeZ);
      if (!planted) {
        light.intensity = 0;
        for (const pulseMaterial of pulseMaterials) pulseMaterial.emissiveIntensity = 0.3;
        return;
      }
      light.position.set(state.spikeX, state.spikeY + 0.3, state.spikeZ);
      const pulse = 0.5 + 0.5 * Math.sin(nowSeconds * 6);
      light.intensity = 1.5 + pulse * 2.5;
      for (const pulseMaterial of pulseMaterials) pulseMaterial.emissiveIntensity = 0.6 + pulse * 1.2;
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
