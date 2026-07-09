import * as THREE from "three";
import { CAPSULE_RADIUS, CROUCH_HEIGHT, STAND_HEIGHT } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { computeRigHeights, createPlayerModel } from "../src/playerModel.js";

const TOLERANCE = 0.1; // spec: "within 10%"
const CAPSULE_DIAMETER = CAPSULE_RADIUS * 2;

function withinTolerance(actual: number, target: number, tolerance = TOLERANCE): boolean {
  return Math.abs(actual - target) <= target * tolerance;
}

describe("player model dimensions (M5 acceptance criterion 5)", () => {
  it("computeRigHeights sums to STAND_HEIGHT when standing and CROUCH_HEIGHT when crouching", () => {
    expect(computeRigHeights(false).totalHeight).toBeCloseTo(STAND_HEIGHT, 5);
    expect(computeRigHeights(true).totalHeight).toBeCloseTo(CROUCH_HEIGHT, 5);
  });

  it("the built mesh's standing bounding box height is within 10% of STAND_HEIGHT, width within 10% of the capsule diameter", () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel(scene);
    model.setPose({
      posX: 0,
      posY: 0,
      posZ: 0,
      yaw: 0,
      crouching: false,
      grounded: true,
      connected: true,
      alive: true,
      team: 0,
      isAlly: true,
      agentId: 255,
      weaponId: 3,
      horizontalSpeed: 0,
      distanceTraveled: 0,
      nowSeconds: 0,
    });
    const box = new THREE.Box3().setFromObject(model.group);
    const height = box.max.y - box.min.y;
    const width = box.max.x - box.min.x;
    expect(withinTolerance(height, STAND_HEIGHT)).toBe(true);
    expect(withinTolerance(width, CAPSULE_DIAMETER)).toBe(true);
    model.dispose(scene);
  });

  it("the built mesh's crouching bounding box height is within 10% of CROUCH_HEIGHT", () => {
    const scene = new THREE.Scene();
    const model = createPlayerModel(scene);
    model.setPose({
      posX: 0,
      posY: 0,
      posZ: 0,
      yaw: 0,
      crouching: true,
      grounded: true,
      connected: true,
      alive: true,
      team: 1,
      isAlly: false,
      agentId: 255,
      weaponId: 0,
      horizontalSpeed: 0,
      distanceTraveled: 0,
      nowSeconds: 0,
    });
    const box = new THREE.Box3().setFromObject(model.group);
    const height = box.max.y - box.min.y;
    expect(withinTolerance(height, CROUCH_HEIGHT)).toBe(true);
    model.dispose(scene);
  });
});
