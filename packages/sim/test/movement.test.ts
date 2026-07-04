import { describe, expect, it } from "vitest";
import {
  CROUCH_SPEED,
  RUN_SPEED,
  WALK_SPEED,
  createState,
  defaultInput,
  tick,
  type Box,
  type InputFrame,
  type SimState,
} from "../src/index.js";

const FLOOR: Box = { minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100 };

function speed(state: SimState, i = 0): number {
  return Math.hypot(state.velX[i]!, state.velZ[i]!);
}

function stepMany(state: SimState, input: InputFrame, boxes: Box[], n: number): SimState {
  let s = state;
  for (let i = 0; i < n; i++) {
    s = tick(s, [input], boxes);
  }
  return s;
}

describe("ground speed caps", () => {
  it("converges to run speed from rest and never exceeds it", () => {
    let state = createState(1, 1);
    const boxes = [FLOOR];
    const input: InputFrame = { ...defaultInput(0), forward: 1 };
    // let the player settle onto the floor first
    state = stepMany(state, defaultInput(0), boxes, 5);

    let maxSpeed = 0;
    for (let i = 0; i < 400; i++) {
      state = tick(state, [input], boxes);
      maxSpeed = Math.max(maxSpeed, speed(state));
    }
    expect(speed(state)).toBeGreaterThan(RUN_SPEED - 0.01);
    expect(speed(state)).toBeLessThan(RUN_SPEED + 0.01);
    expect(maxSpeed).toBeLessThanOrEqual(RUN_SPEED + 1e-9);
  });

  it("caps walk speed", () => {
    let state = createState(2, 1);
    const boxes = [FLOOR];
    state = stepMany(state, defaultInput(0), boxes, 5);
    const input: InputFrame = { ...defaultInput(0), forward: 1, walk: true };

    let maxSpeed = 0;
    for (let i = 0; i < 400; i++) {
      state = tick(state, [input], boxes);
      maxSpeed = Math.max(maxSpeed, speed(state));
    }
    expect(speed(state)).toBeGreaterThan(WALK_SPEED - 0.01);
    expect(speed(state)).toBeLessThan(WALK_SPEED + 0.01);
    expect(maxSpeed).toBeLessThanOrEqual(WALK_SPEED + 1e-9);
  });

  it("caps crouch speed", () => {
    let state = createState(3, 1);
    const boxes = [FLOOR];
    const crouchInput0: InputFrame = { ...defaultInput(0), crouch: true };
    state = stepMany(state, crouchInput0, boxes, 5);
    const input: InputFrame = { ...defaultInput(0), forward: 1, crouch: true };

    let maxSpeed = 0;
    for (let i = 0; i < 400; i++) {
      state = tick(state, [input], boxes);
      maxSpeed = Math.max(maxSpeed, speed(state));
    }
    expect(speed(state)).toBeGreaterThan(CROUCH_SPEED - 0.01);
    expect(speed(state)).toBeLessThan(CROUCH_SPEED + 0.01);
    expect(maxSpeed).toBeLessThanOrEqual(CROUCH_SPEED + 1e-9);
  });
});

describe("jump", () => {
  it("reaches ~0.9m apex and re-lands grounded", () => {
    let state = createState(4, 1);
    const boxes = [FLOOR];
    // settle onto the floor
    state = stepMany(state, defaultInput(0), boxes, 5);
    expect(state.grounded[0]).toBe(1);
    const groundY = state.posY[0]!;

    // one tick with jump pressed
    state = tick(state, [{ ...defaultInput(0), jump: true }], boxes);
    expect(state.grounded[0]).toBe(0);

    let apex = state.posY[0]!;
    let landedGrounded = false;
    for (let i = 0; i < 300; i++) {
      state = tick(state, [defaultInput(0)], boxes);
      apex = Math.max(apex, state.posY[0]!);
      if (state.grounded[0] === 1) {
        landedGrounded = true;
        break;
      }
    }
    const apexHeight = apex - groundY;
    expect(apexHeight).toBeGreaterThan(0.8);
    expect(apexHeight).toBeLessThan(1.0);
    expect(landedGrounded).toBe(true);
    expect(state.grounded[0]).toBe(1);
  });
});

describe("wall collision", () => {
  it("slides along a wall instead of tunneling through it, never penetrating more than 1e-3 m", () => {
    const WALL: Box = { minX: 3, minY: -1, minZ: -100, maxX: 4, maxY: 3, maxZ: 100 };
    const boxes = [FLOOR, WALL];
    let state = createState(5, 1);
    state = stepMany(state, defaultInput(0), boxes, 5);

    // approach the wall at a 45 degree angle so there is a tangential
    // component to slide along once the perpendicular component is blocked
    const yaw = Math.PI / 4; // fx = sin(yaw), fz = cos(yaw): moves toward +x and +z
    const input: InputFrame = { ...defaultInput(yaw), forward: 1 };

    let maxPenetration = -Infinity;
    let maxX = -Infinity;
    let zAtStart = 0;
    for (let i = 0; i < 600; i++) {
      state = tick(state, [input], boxes);
      const x = state.posX[0]!;
      const y = state.posY[0]!;
      const z = state.posZ[0]!;
      maxX = Math.max(maxX, x);

      // Horizontal penetration against every box in the scene (not just the
      // wall we're aiming at) — acceptance criterion 4d says "any box".
      for (const b of boxes) {
        const height = 1.8; // standing capsule height, matches STAND_HEIGHT
        if (y + height <= b.minY || y >= b.maxY) continue; // no vertical overlap
        const closestX = Math.min(b.maxX, Math.max(b.minX, x));
        const closestZ = Math.min(b.maxZ, Math.max(b.minZ, z));
        const dist = Math.hypot(x - closestX, z - closestZ);
        const penetration = 0.4 - dist; // capsule radius = 0.4
        maxPenetration = Math.max(maxPenetration, penetration);
      }

      if (i === 100) zAtStart = z;
    }

    expect(maxPenetration).toBeLessThan(1e-3);
    // never tunneled through to the far side of the (1 m thick) wall
    expect(maxX).toBeLessThan(WALL.minX + 0.5);
    // kept sliding tangentially (z kept increasing) after first making contact
    expect(state.posZ[0]!).toBeGreaterThan(zAtStart + 1);
  });
});

describe("grounded step-up (stairs)", () => {
  // Mirrors packages/client/src/graybox.ts's ramp: 10 steps, 0.2 m tall
  // (under MAX_STEP_HEIGHT), 0.9 m deep, topped by a flat landing.
  function buildStaircase(): { boxes: Box[]; topHeight: number } {
    const floor: Box = { minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100 };
    const stepCount = 10;
    const stepHeight = 0.2;
    const stepDepth = 0.9;
    const width = 3;
    const boxes: Box[] = [floor];
    for (let i = 0; i < stepCount; i++) {
      const top = (i + 1) * stepHeight;
      const z = 10 + i * stepDepth;
      boxes.push({
        minX: -width / 2,
        maxX: width / 2,
        minY: 0,
        maxY: top,
        minZ: z - stepDepth / 2,
        maxZ: z + stepDepth / 2,
      });
    }
    const topHeight = stepCount * stepHeight;
    const lastStepFarZ = 10 + (stepCount - 1) * stepDepth + stepDepth / 2;
    boxes.push({
      minX: -width / 2,
      maxX: width / 2,
      minY: 0,
      maxY: topHeight,
      minZ: lastStepFarZ,
      maxZ: lastStepFarZ + 4,
    });
    return { boxes, topHeight };
  }

  it("climbs the ramp to the top platform holding forward only, no jump", () => {
    const { boxes, topHeight } = buildStaircase();
    let state = createState(6, 1);
    state = stepMany(state, defaultInput(0), boxes, 5);

    const input: InputFrame = { ...defaultInput(0), forward: 1 }; // jump stays false throughout
    let maxY = 0;
    for (let i = 0; i < 500; i++) {
      state = tick(state, [input], boxes);
      maxY = Math.max(maxY, state.posY[0]!);
    }

    expect(maxY).toBeGreaterThan(topHeight - 0.05);
  });

  it("does not change flat-ground run speed convergence", () => {
    let state = createState(7, 1);
    const boxes = [FLOOR];
    state = stepMany(state, defaultInput(0), boxes, 5);
    const input: InputFrame = { ...defaultInput(0), forward: 1 };

    let maxSpeed = 0;
    for (let i = 0; i < 400; i++) {
      state = tick(state, [input], boxes);
      maxSpeed = Math.max(maxSpeed, speed(state));
    }
    expect(speed(state)).toBeGreaterThan(RUN_SPEED - 0.01);
    expect(speed(state)).toBeLessThan(RUN_SPEED + 0.01);
    expect(maxSpeed).toBeLessThanOrEqual(RUN_SPEED + 1e-9);
  });
});
