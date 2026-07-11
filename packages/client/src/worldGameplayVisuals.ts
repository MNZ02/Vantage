// Phase-0 world readability: authoritative dropped weapons and the otherwise
// invisible buy-phase collision barriers. Both renderers are deliberately
// driven from simulation/protocol data rather than hand-authored positions so
// gameplay collision and presentation cannot drift apart.
import * as THREE from "three";
import type { SnapshotDroppedWeapon } from "@vg/protocol";
import { BARRIERS } from "@vg/sim";
import { cloneModel, loadModel } from "./assets.js";
import { MODEL_FOR_CLASS, weaponClassFor, type WeaponClass } from "./viewmodel.js";

export interface DroppedWeaponRenderer {
  sync(drops: readonly SnapshotDroppedWeapon[], nowSeconds: number): void;
  dispose(): void;
}

interface DroppedVisual {
  readonly id: number;
  readonly weaponId: number;
  readonly root: THREE.Group;
  readonly weaponHolder: THREE.Group;
  readonly pickupRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  seenGeneration: number;
}

export interface DroppedWeaponRendererOptions {
  /** Test/diagnostic escape hatch; production keeps the authored GLB swap on. */
  loadAuthoredModels?: boolean;
}

const DROP_COLOR = 0x58e6d2;

/**
 * Creates a snapshot-synchronised renderer for dropped weapons. A readable
 * procedural silhouette appears immediately; the matching authored weapon
 * replaces it once the cached GLB is ready. Snapshot entity ids are stable
 * for the lifetime of a drop, so pickup/despawn is a simple id diff.
 */
export function createDroppedWeaponRenderer(
  scene: THREE.Scene,
  options: DroppedWeaponRendererOptions = {},
): DroppedWeaponRenderer {
  const loadAuthoredModels = options.loadAuthoredModels !== false;
  const visuals = new Map<number, DroppedVisual>();
  let syncGeneration = 0;
  let disposed = false;

  // Shared by every live drop; a match caps the entity list at 32.
  const bodyGeometry = new THREE.BoxGeometry(0.16, 0.13, 0.62);
  const barrelGeometry = new THREE.BoxGeometry(0.055, 0.055, 0.48);
  const stockGeometry = new THREE.BoxGeometry(0.22, 0.16, 0.24);
  const accentGeometry = new THREE.BoxGeometry(0.175, 0.018, 0.2);
  const fallbackMaterial = new THREE.MeshStandardMaterial({
    color: 0x28373b,
    emissive: DROP_COLOR,
    emissiveIntensity: 0.18,
    roughness: 0.48,
    metalness: 0.62,
  });
  const accentMaterial = new THREE.MeshBasicMaterial({ color: DROP_COLOR });
  const ringGeometry = new THREE.TorusGeometry(0.36, 0.018, 6, 32);
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: DROP_COLOR,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  function makeFallback(className: WeaponClass): THREE.Group {
    const fallback = new THREE.Group();
    fallback.name = "dropped-weapon-fallback";

    const body = new THREE.Mesh(bodyGeometry, fallbackMaterial);
    body.position.z = 0.02;
    const barrel = new THREE.Mesh(barrelGeometry, fallbackMaterial);
    barrel.position.set(0, 0.015, -0.48);
    const stock = new THREE.Mesh(stockGeometry, fallbackMaterial);
    stock.position.set(0, -0.01, 0.38);
    const accent = new THREE.Mesh(accentGeometry, accentMaterial);
    accent.position.set(0, 0.075, -0.02);
    fallback.add(body, barrel, stock, accent);

    // Preserve the broad silhouette differences even before the GLB arrives.
    if (className === "pistol") fallback.scale.set(0.72, 0.8, 0.62);
    else if (className === "smg") fallback.scale.set(0.86, 0.88, 0.8);
    else if (className === "sniper") fallback.scale.set(0.92, 0.92, 1.3);
    else if (className === "knife") fallback.scale.set(0.3, 0.34, 0.9);
    return fallback;
  }

  function createVisual(drop: SnapshotDroppedWeapon): DroppedVisual {
    const className = weaponClassFor(drop.weaponId);
    const root = new THREE.Group();
    root.name = `dropped-weapon-${drop.id}`;
    root.userData["dropId"] = drop.id;
    root.userData["weaponId"] = drop.weaponId;
    root.userData["mag"] = drop.mag;

    const weaponHolder = new THREE.Group();
    weaponHolder.name = "dropped-weapon-model";
    weaponHolder.rotation.order = "YZX";
    weaponHolder.rotation.y = ((drop.id * 2.399963) % (Math.PI * 2)) - Math.PI;
    weaponHolder.rotation.z = Math.PI * 0.47; // rest the upright authored weapon on its side
    weaponHolder.add(makeFallback(className));

    const pickupRing = new THREE.Mesh(ringGeometry, ringMaterial);
    pickupRing.name = "dropped-weapon-pickup-ring";
    pickupRing.rotation.x = Math.PI / 2;
    pickupRing.position.y = 0.035;
    pickupRing.renderOrder = 3;
    root.add(weaponHolder, pickupRing);
    scene.add(root);

    const visual: DroppedVisual = {
      id: drop.id,
      weaponId: drop.weaponId,
      root,
      weaponHolder,
      pickupRing,
      seenGeneration: syncGeneration,
    };
    visuals.set(drop.id, visual);

    if (loadAuthoredModels) {
      const modelInfo = MODEL_FOR_CLASS[className];
      void loadModel(modelInfo.name).then((master) => {
        // The id may have despawned or wrapped to a different weapon while
        // the asset was loading. Never attach a late model to the new entity.
        if (disposed || !master || visuals.get(drop.id) !== visual) return;
        const model = cloneModel(master).group;
        model.name = "dropped-weapon-authored-model";
        model.scale.setScalar(modelInfo.scale);
        visual.weaponHolder.clear();
        visual.weaponHolder.add(model);
      });
    }
    return visual;
  }

  function removeVisual(visual: DroppedVisual): void {
    scene.remove(visual.root);
    visuals.delete(visual.id);
  }

  return {
    sync(drops, nowSeconds) {
      if (disposed) return;
      syncGeneration++;
      for (const drop of drops) {
        let visual = visuals.get(drop.id);
        // Entity ids are u8 and eventually wrap. A wrapped id that names a
        // different weapon is a new entity, not an in-place model mutation.
        if (visual && visual.weaponId !== drop.weaponId) {
          removeVisual(visual);
          visual = undefined;
        }
        if (!visual) visual = createVisual(drop);
        visual.seenGeneration = syncGeneration;
        visual.root.userData["mag"] = drop.mag;
        visual.root.position.set(drop.x, drop.y, drop.z);

        // A tiny hover and a breathing pickup ring make the object readable
        // against the map without suggesting that the gun itself is moving.
        visual.weaponHolder.position.y = 0.17 + Math.sin(nowSeconds * 2.6 + drop.id) * 0.012;
        const pulse = 1 + Math.sin(nowSeconds * 3.2 + drop.id * 0.7) * 0.08;
        visual.pickupRing.scale.setScalar(pulse);
      }

      for (const visual of visuals.values()) {
        if (visual.seenGeneration !== syncGeneration) removeVisual(visual);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const visual of visuals.values()) scene.remove(visual.root);
      visuals.clear();
      bodyGeometry.dispose();
      barrelGeometry.dispose();
      stockGeometry.dispose();
      accentGeometry.dispose();
      ringGeometry.dispose();
      fallbackMaterial.dispose();
      accentMaterial.dispose();
      ringMaterial.dispose();
    },
  };
}

export interface BuyPhaseBarrierRenderer {
  sync(active: boolean, nowSeconds: number): void;
  dispose(): void;
}

interface BarrierMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uTime: { value: number };
    uColor: { value: THREE.Color };
  };
}

function createBarrierMaterial(color: number): BarrierMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      varying vec3 vLocalPosition;
      void main() {
        vLocalPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uColor;
      varying vec3 vLocalPosition;
      void main() {
        float movingBand = pow(max(0.0, sin((vLocalPosition.y + uTime * 0.75) * 15.0)), 18.0);
        float fineGrid = pow(max(0.0, sin((vLocalPosition.x + uTime * 0.08) * 5.5)), 30.0);
        float alpha = 0.11 + movingBand * 0.23 + fineGrid * 0.07;
        gl_FragColor = vec4(uColor * (1.0 + movingBand * 0.8), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  }) as BarrierMaterial;
}

/**
 * Visualises the exact @vg/sim BARRIERS AABBs only while the buy phase is
 * active. Attacker-owned fields are warm red; defender-owned fields are cyan.
 */
export function createBuyPhaseBarrierRenderer(scene: THREE.Scene): BuyPhaseBarrierRenderer {
  const root = new THREE.Group();
  root.name = "buy-phase-barriers";
  root.visible = false;
  scene.add(root);

  const teamMaterials: readonly [BarrierMaterial, BarrierMaterial] = [createBarrierMaterial(0xff5d5d), createBarrierMaterial(0x49d9ff)];
  const edgeMaterials: readonly [THREE.LineBasicMaterial, THREE.LineBasicMaterial] = [
    new THREE.LineBasicMaterial({ color: 0xff8a72, transparent: true, opacity: 0.9 }),
    new THREE.LineBasicMaterial({ color: 0x7cecff, transparent: true, opacity: 0.9 }),
  ];
  const ownedGeometries: THREE.BufferGeometry[] = [];

  for (let i = 0; i < BARRIERS.length; i++) {
    const { box, team } = BARRIERS[i]!;
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const depth = box.maxZ - box.minZ;
    const geometry = new THREE.BoxGeometry(width, height, depth);
    const field = new THREE.Mesh(geometry, teamMaterials[team]);
    field.name = `buy-phase-barrier-${i}`;
    field.position.set((box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2);
    field.renderOrder = 2;

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const edges = new THREE.LineSegments(edgeGeometry, edgeMaterials[team]);
    edges.name = `buy-phase-barrier-edges-${i}`;
    edges.position.copy(field.position);
    edges.renderOrder = 3;
    root.add(field, edges);
    ownedGeometries.push(geometry, edgeGeometry);
  }

  return {
    sync(active, nowSeconds) {
      root.visible = active;
      if (!active) return;
      teamMaterials[0].uniforms.uTime.value = nowSeconds;
      teamMaterials[1].uniforms.uTime.value = nowSeconds;
    },
    dispose() {
      scene.remove(root);
      for (const geometry of ownedGeometries) geometry.dispose();
      for (const material of teamMaterials) material.dispose();
      for (const material of edgeMaterials) material.dispose();
    },
  };
}
