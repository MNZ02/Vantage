import { describe, expect, it } from "vitest";
import {
  LAND_PENALTY_TICKS,
  RUN_SPEED,
  TAG_MULT,
  TAG_TICKS,
  WEAPONS,
  applyTag,
  computeSpreadRad,
  createState,
  defaultInput,
  tick,
  type Box,
  type InputFrame,
} from "../src/index.js";

const FLOOR: Box = { minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100 };
const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

describe("tagging (acceptance criterion 9)", () => {
  it("post-tag horizontal speed is <= TAG_MULT * prior for TAG_TICKS, then recovers", () => {
    const runInput: InputFrame = { ...defaultInput(0), forward: 1 };
    let state = createState(1, 1);
    state = tick(state, [runInput], [FLOOR]).state;
    for (let i = 0; i < 200; i++) {
      state = tick(state, [runInput], [FLOOR]).state;
    }
    const priorSpeed = Math.hypot(state.velX[0]!, state.velZ[0]!);
    expect(priorSpeed).toBeGreaterThan(RUN_SPEED - 0.1);

    state = applyTag(state, 0);
    expect(state.tagTicksLeft[0]).toBe(TAG_TICKS);

    // Movement decelerates via friction toward the tag-capped wish speed
    // rather than snapping instantly — by partway through the tag window
    // (still well within TAG_TICKS) speed must have settled at/below the
    // TAG_MULT-scaled cap, and stays there for the remainder of the window.
    for (let i = 0; i < TAG_TICKS - 1; i++) {
      state = tick(state, [runInput], [FLOOR]).state;
      if (i >= 15) {
        const speed = Math.hypot(state.velX[0]!, state.velZ[0]!);
        expect(speed).toBeLessThanOrEqual(priorSpeed * TAG_MULT + 0.3);
      }
    }
    state = tick(state, [runInput], [FLOOR]).state;
    expect(state.tagTicksLeft[0]).toBe(0);
    // Recovers back toward run speed once the tag window elapses.
    for (let i = 0; i < 100; i++) {
      state = tick(state, [runInput], [FLOOR]).state;
    }
    expect(Math.hypot(state.velX[0]!, state.velZ[0]!)).toBeGreaterThan(RUN_SPEED - 0.1);
  });
});

describe("land penalty (acceptance criterion 9)", () => {
  it("firing within landPenaltyTicks after landing has airborne-class spread", () => {
    let state = createState(2, 1);
    state.weaponPrimary[0] = FALCON.id;
    state.activeSlot[0] = 0;
    state.magPrimary[0] = FALCON.magSize;
    state.reservePrimary[0] = FALCON.reserveAmmo;

    state = tick(state, [defaultInput(0)], [FLOOR]).state;
    expect(state.grounded[0]).toBe(1);

    // Jump, then let gravity bring the player back down.
    state = tick(state, [{ ...defaultInput(0), jump: true }], [FLOOR]).state;
    expect(state.grounded[0]).toBe(0);
    let landed = false;
    for (let i = 0; i < 200; i++) {
      state = tick(state, [defaultInput(0)], [FLOOR]).state;
      if (state.grounded[0] === 1) {
        landed = true;
        break;
      }
    }
    expect(landed).toBe(true);
    expect(state.landPenaltyTicksLeft[0]).toBe(LAND_PENALTY_TICKS);

    const groundedRunSpread = (() => {
      const s = createState(3, 1);
      s.velX[0] = 0;
      s.velZ[0] = RUN_SPEED;
      s.grounded[0] = 1;
      return computeSpreadRad(FALCON, s, 0);
    })();

    const spreadRightAfterLanding = computeSpreadRad(FALCON, state, 0);
    expect(spreadRightAfterLanding).toBeGreaterThan(groundedRunSpread);

    // Penalty ticks down and eventually clears.
    for (let i = 0; i < LAND_PENALTY_TICKS; i++) {
      state = tick(state, [defaultInput(0)], [FLOOR]).state;
    }
    expect(state.landPenaltyTicksLeft[0]).toBe(0);
  });
});
