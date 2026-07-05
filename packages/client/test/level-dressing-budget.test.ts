import * as THREE from "three";
import { LEVEL_BOXES } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { FILL_LIGHT_BUDGET, LEVEL_DRESSING_LIGHT_BUDGET, LEVEL_DRESSING_MESH_BUDGET, buildLevelDressing } from "../src/graybox.js";
import { PROPS } from "../src/propPlacement.js";
import type { MaterialSet } from "../src/materials.js";
import type { Zone } from "../src/zones.js";

/** A DOM-free stand-in for materials.ts's createMaterialSet() — same shape, plain (non-canvas) materials, so this test never touches `document`. */
function fakeMaterialSet(): MaterialSet {
  const zones: Zone[] = ["attackerSide", "defenderSide", "mid", "siteA", "siteB"];
  const wallByZone = {} as Record<Zone, THREE.Material>;
  const floorByZone = {} as Record<Zone, THREE.Material>;
  for (const z of zones) {
    wallByZone[z] = new THREE.MeshBasicMaterial({ color: 0x888888 });
    floorByZone[z] = new THREE.MeshBasicMaterial({ color: 0x444444 });
  }
  return {
    wallByZone,
    floorByZone,
    metalPanel: new THREE.MeshBasicMaterial({ color: 0x999999 }),
    woodCrate: new THREE.MeshBasicMaterial({ color: 0xaa8855 }),
    hazardStripe: new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
    siteMarkerA: new THREE.MeshBasicMaterial({ color: 0xd4af37 }),
    siteMarkerB: new THREE.MeshBasicMaterial({ color: 0xa23b3b }),
  };
}

describe("level dressing static mesh/light budget (M5 acceptance criterion 4)", () => {
  it("stays within the documented mesh and light budgets (instancing counted once)", () => {
    const scene = new THREE.Scene();
    // Mimic createScene()'s hemisphere + sun (2 lights) without needing a WebGLRenderer/canvas.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1));
    scene.add(new THREE.DirectionalLight(0xffffff, 1));

    const handle = buildLevelDressing(scene, LEVEL_BOXES, fakeMaterialSet(), PROPS);

    expect(handle.meshCount).toBeLessThanOrEqual(LEVEL_DRESSING_MESH_BUDGET);
    expect(handle.lightCount).toBeLessThanOrEqual(FILL_LIGHT_BUDGET);

    let totalLightsInScene = 0;
    scene.traverse((obj) => {
      if (obj instanceof THREE.Light) totalLightsInScene++;
    });
    expect(totalLightsInScene).toBeLessThanOrEqual(LEVEL_DRESSING_LIGHT_BUDGET);

    handle.dispose(scene);
  });
});
