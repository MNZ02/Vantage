import { describe, expect, it } from "vitest";
import {
  createState,
  eyePosition,
  raycastBoxes,
  raycastPlayers,
  viewDirection,
  type Box,
} from "../src/index.js";

describe("raycastBoxes", () => {
  it("hits a box straight ahead at the expected distance", () => {
    const boxes: Box[] = [{ minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 5, maxZ: 7 }];
    const dist = raycastBoxes(boxes, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(dist).not.toBeNull();
    expect(dist!).toBeCloseTo(5, 6);
  });

  it("returns null when nothing is within maxDist", () => {
    const boxes: Box[] = [{ minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 50, maxZ: 52 }];
    const dist = raycastBoxes(boxes, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 10);
    expect(dist).toBeNull();
  });

  it("returns null for a ray pointing away from the box", () => {
    const boxes: Box[] = [{ minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 5, maxZ: 7 }];
    const dist = raycastBoxes(boxes, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, 20);
    expect(dist).toBeNull();
  });

  it("picks the nearest of multiple boxes", () => {
    const boxes: Box[] = [
      { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 10, maxZ: 12 },
      { minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: 3, maxZ: 4 },
    ];
    const dist = raycastBoxes(boxes, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(dist!).toBeCloseTo(3, 6);
  });
});

describe("raycastPlayers", () => {
  it("hits a standing player's capsule at roughly its surface distance", () => {
    const state = createState(1, 2);
    state.posX[1] = 0;
    state.posY[1] = 0;
    state.posZ[1] = 10;
    // shooter at origin, aiming straight down +z at the target's center mass
    const origin = { x: 0, y: 0.9, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    const hit = raycastPlayers(state, 0, origin, dir, 20);
    expect(hit).not.toBeNull();
    expect(hit!.playerIndex).toBe(1);
    // capsule surface is CAPSULE_RADIUS (0.4m) nearer than the center at z=10
    expect(hit!.dist).toBeCloseTo(9.6, 6);
  });

  it("skips the shooter itself", () => {
    const state = createState(2, 1);
    const hit = raycastPlayers(state, 0, { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(hit).toBeNull();
  });

  it("misses when aimed above a crouching player's head", () => {
    const state = createState(3, 2);
    state.posX[1] = 0;
    state.posY[1] = 0;
    state.posZ[1] = 10;
    state.crouching[1] = 1; // CROUCH_HEIGHT = 1.3
    const hit = raycastPlayers(state, 0, { x: 0, y: 1.6, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(hit).toBeNull();
  });

  it("returns null when the maxDist is shorter than the target's distance", () => {
    const state = createState(4, 2);
    state.posX[1] = 0;
    state.posY[1] = 0;
    state.posZ[1] = 10;
    const hit = raycastPlayers(state, 0, { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 }, 5);
    expect(hit).toBeNull();
  });
});

describe("eyePosition / viewDirection", () => {
  it("uses stand vs crouch eye height", () => {
    const state = createState(5, 1);
    state.posX[0] = 1;
    state.posY[0] = 2;
    state.posZ[0] = 3;
    const standing = eyePosition(state, 0);
    expect(standing.y).toBeCloseTo(2 + 1.65, 6);
    state.crouching[0] = 1;
    const crouched = eyePosition(state, 0);
    expect(crouched.y).toBeCloseTo(2 + 1.15, 6);
  });

  it("agrees with movement's horizontal wish direction at pitch=0", () => {
    const yaw = 0.7;
    const dir = viewDirection(yaw, 0);
    expect(dir.x).toBeCloseTo(Math.sin(yaw), 5);
    expect(dir.z).toBeCloseTo(Math.cos(yaw), 5);
    expect(dir.y).toBeCloseTo(0, 6);
  });

  it("is a unit vector across a sweep of yaw/pitch", () => {
    for (let i = 0; i < 20; i++) {
      const yaw = -3 + (6 * i) / 19;
      const pitch = -1 + (2 * i) / 19;
      const d = viewDirection(yaw, pitch);
      const len = Math.hypot(d.x, d.y, d.z);
      expect(len).toBeCloseTo(1, 4);
    }
  });
});
