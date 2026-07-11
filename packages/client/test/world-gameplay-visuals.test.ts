import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { BARRIERS, WEAPON_FALCON, WEAPON_LONGBOW } from "@vg/sim";
import type { SnapshotDroppedWeapon } from "@vg/protocol";
import { createBuyPhaseBarrierRenderer, createDroppedWeaponRenderer } from "../src/worldGameplayVisuals.js";

function drop(overrides: Partial<SnapshotDroppedWeapon> = {}): SnapshotDroppedWeapon {
  return {
    id: 3,
    weaponId: WEAPON_FALCON,
    x: 4,
    y: 0,
    z: -2,
    mag: 17,
    ...overrides,
  };
}

describe("dropped weapon world visuals", () => {
  it("tracks authoritative snapshot ids, positions, ammo metadata, and despawns", () => {
    const scene = new THREE.Scene();
    const renderer = createDroppedWeaponRenderer(scene, { loadAuthoredModels: false });

    renderer.sync([drop()], 1);
    const visual = scene.getObjectByName("dropped-weapon-3");
    expect(visual).toBeDefined();
    expect(visual!.position.toArray()).toEqual([4, 0, -2]);
    expect(visual!.userData["weaponId"]).toBe(WEAPON_FALCON);
    expect(visual!.userData["mag"]).toBe(17);
    expect(visual!.getObjectByName("dropped-weapon-pickup-ring")).toBeDefined();

    renderer.sync([drop({ x: 8, mag: 4 })], 2);
    expect(scene.getObjectByName("dropped-weapon-3")!.position.x).toBe(8);
    expect(scene.getObjectByName("dropped-weapon-3")!.userData["mag"]).toBe(4);

    renderer.sync([], 3);
    expect(scene.getObjectByName("dropped-weapon-3")).toBeUndefined();
    renderer.dispose();
  });

  it("replaces a wrapped entity id when it names a different weapon", () => {
    const scene = new THREE.Scene();
    const renderer = createDroppedWeaponRenderer(scene, { loadAuthoredModels: false });
    renderer.sync([drop()], 1);
    const first = scene.getObjectByName("dropped-weapon-3");

    renderer.sync([drop({ weaponId: WEAPON_LONGBOW })], 2);
    const replacement = scene.getObjectByName("dropped-weapon-3");
    expect(replacement).not.toBe(first);
    expect(replacement!.userData["weaponId"]).toBe(WEAPON_LONGBOW);
    renderer.dispose();
  });
});

describe("buy-phase barrier world visuals", () => {
  it("uses every simulation barrier AABB and is visible only when activated", () => {
    const scene = new THREE.Scene();
    const renderer = createBuyPhaseBarrierRenderer(scene);
    const root = scene.getObjectByName("buy-phase-barriers") as THREE.Group;
    expect(root.visible).toBe(false);
    expect(root.children).toHaveLength(BARRIERS.length * 2); // field + edge outline

    for (let i = 0; i < BARRIERS.length; i++) {
      const box = BARRIERS[i]!.box;
      const field = root.getObjectByName(`buy-phase-barrier-${i}`) as THREE.Mesh;
      expect(field.position.x).toBe((box.minX + box.maxX) / 2);
      expect(field.position.y).toBe((box.minY + box.maxY) / 2);
      expect(field.position.z).toBe((box.minZ + box.maxZ) / 2);
      const size = new THREE.Vector3();
      field.geometry.computeBoundingBox();
      field.geometry.boundingBox!.getSize(size);
      expect(size.toArray()).toEqual([box.maxX - box.minX, box.maxY - box.minY, box.maxZ - box.minZ]);
    }

    renderer.sync(true, 12.5);
    expect(root.visible).toBe(true);
    const material = (root.getObjectByName("buy-phase-barrier-0") as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(material.uniforms["uTime"]!.value).toBe(12.5);

    renderer.sync(false, 13);
    expect(root.visible).toBe(false);
    renderer.dispose();
    expect(scene.getObjectByName("buy-phase-barriers")).toBeUndefined();
  });
});
