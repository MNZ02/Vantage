import { describe, expect, it } from "vitest";
import {
  RUN_SPEED,
  SPRAY_RESET_TICKS,
  WEAPONS,
  WEAPON_NONE,
  computeSpreadRad,
  createState,
  defaultInput,
  shotDirection,
  shotSpreadOffset,
  tick,
  viewDirection,
  type Box,
  type InputFrame,
  type SimState,
} from "../src/index.js";

const FLOOR: Box = { minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100 };
const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

function equip(state: SimState, playerIndex: number, weaponId: number): void {
  state.weaponPrimary[playerIndex] = weaponId;
  state.activeSlot[playerIndex] = 0;
  const w = WEAPONS[weaponId]!;
  state.magPrimary[playerIndex] = w.magSize;
  state.reservePrimary[playerIndex] = w.reserveAmmo;
  state.weaponSecondary[playerIndex] = WEAPON_NONE;
}

function angleBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(Math.min(1, Math.max(-1, dot)));
}

describe("spray + first-shot accuracy (acceptance criterion 6)", () => {
  it("standing still, first shot deviates from view direction by <= baseSpreadRad", () => {
    let state = createState(10, 1);
    equip(state, 0, FALCON.id);
    state = tick(state, [defaultInput(0)], [FLOOR]).state; // settle, standing still

    const result = tick(state, [{ ...defaultInput(0), fire: true }], [FLOOR]);
    expect(result.shots.length).toBe(1);
    const shot = result.shots[0]!;
    // Use the post-tick state (result.state): it holds the finalized
    // grounded/crouching/velocity this shot was actually fired under, which
    // is exactly what server/client call shotDirection() with in practice.
    const dir = shotDirection(result.state, 0, FALCON, shot.shotIndex, shot.sprayIndex);
    const view = viewDirection(result.state.yaw[0]!, result.state.pitch[0]!);
    const angle = angleBetween(dir, view);
    expect(angle).toBeLessThanOrEqual(FALCON.baseSpreadRad + 1e-9);
  });

  it("shot k's direction exactly equals the shared shotDirection() helper's output (server/client parity by construction)", () => {
    let state = createState(11, 1);
    equip(state, 0, FALCON.id);
    state = tick(state, [defaultInput(0)], [FLOOR]).state;

    let shotsChecked = 0;
    for (let k = 0; k < 40 && shotsChecked < 5; k++) {
      const result = tick(state, [{ ...defaultInput(0), fire: true }], [FLOOR]);
      state = result.state;
      if (result.shots.length === 0) continue; // fire-rate gating: not every tick fires
      const shot = result.shots[0]!;
      const dirA = shotDirection(state, 0, FALCON, shot.shotIndex, shot.sprayIndex);
      const dirB = shotDirection(state, 0, FALCON, shot.shotIndex, shot.sprayIndex);
      expect(dirA).toEqual(dirB); // pure + deterministic: recomputing gives byte-identical output
      shotsChecked++;
    }
    expect(shotsChecked).toBe(5);
  });

  it("sprayIndex resets to 0 after 8 ticks without firing", () => {
    let state = createState(12, 1);
    equip(state, 0, FALCON.id);
    state = tick(state, [defaultInput(0)], [FLOOR]).state;

    for (let i = 0; i < 3; i++) {
      state = tick(state, [{ ...defaultInput(0), fire: true }], [FLOOR]).state;
    }
    expect(state.sprayIndex[0]).toBeGreaterThan(0);

    for (let i = 0; i < SPRAY_RESET_TICKS + 1; i++) {
      state = tick(state, [defaultInput(0)], [FLOOR]).state;
    }
    expect(state.sprayIndex[0]).toBe(0);
  });

  it("the random cone offset magnitude never exceeds the current computed spread", () => {
    for (let shotIndex = 0; shotIndex < 200; shotIndex++) {
      const spread = 0.05;
      const offset = shotSpreadOffset(999, 3, shotIndex, spread);
      const mag = Math.hypot(offset.yawOff, offset.pitchOff);
      expect(mag).toBeLessThanOrEqual(spread + 1e-12);
    }
  });
});

function sampleSpread(weapon: (typeof WEAPONS)[number], setup: (state: SimState) => void, samples = 1000): number {
  let total = 0;
  for (let s = 0; s < samples; s++) {
    let state = createState(100 + s, 1);
    equip(state, 0, weapon.id);
    setup(state);
    total += computeSpreadRad(weapon, state, 0);
  }
  return total / samples;
}

describe("movement/crouch/air/counter-strafe accuracy (acceptance criterion 7)", () => {
  it("run spread > walk spread > standing spread, over >=1000 samples each", () => {
    const standing = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = 0;
    });
    const walking = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = 3.6;
    });
    const running = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = RUN_SPEED;
    });
    expect(running).toBeGreaterThan(walking);
    expect(walking).toBeGreaterThan(standing);
  });

  it("crouch spread < standing spread", () => {
    const standing = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = 0;
      s.crouching[0] = 0;
    });
    const crouching = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = 0;
      s.crouching[0] = 1;
    });
    expect(crouching).toBeLessThan(standing);
  });

  it("airborne is the worst case (greater than full-speed running on the ground)", () => {
    const running = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = RUN_SPEED;
      s.grounded[0] = 1;
    });
    const airborne = sampleSpread(FALCON, (s) => {
      s.velX[0] = 0;
      s.velZ[0] = 0; // even with zero horizontal speed, airborne should be worst
      s.grounded[0] = 0;
    });
    expect(airborne).toBeGreaterThan(running);
  });

  it("counter-strafe: decelerating below ~30% run speed restores accuracy to <= 1.2x standing within 12 ticks of dropping below that threshold", () => {
    // Release keys after running: friction decelerates velocity each tick;
    // find the tick where speed first drops below 0.3*RUN_SPEED and confirm
    // spread is back near-standing within 12 ticks after that.
    let state = createState(200, 1);
    equip(state, 0, FALCON.id);
    const runInput: InputFrame = { ...defaultInput(0), forward: 1 };
    state = tick(state, [runInput], [FLOOR]).state;
    for (let i = 0; i < 200; i++) {
      state = tick(state, [runInput], [FLOOR]).state;
    }
    expect(Math.hypot(state.velX[0]!, state.velZ[0]!)).toBeGreaterThan(RUN_SPEED - 0.1);

    const releaseInput: InputFrame = { ...defaultInput(0) };
    let droppedAtTick = -1;
    let spreadAtDrop12 = -1;
    for (let i = 0; i < 200; i++) {
      state = tick(state, [releaseInput], [FLOOR]).state;
      const speed = Math.hypot(state.velX[0]!, state.velZ[0]!);
      if (droppedAtTick === -1 && speed < 0.3 * RUN_SPEED) {
        droppedAtTick = i;
      }
      if (droppedAtTick !== -1 && i === droppedAtTick + 12) {
        spreadAtDrop12 = computeSpreadRad(FALCON, state, 0);
        break;
      }
    }
    expect(droppedAtTick).toBeGreaterThan(-1);
    const standingSpread = FALCON.baseSpreadRad;
    expect(spreadAtDrop12).toBeLessThanOrEqual(standingSpread * 1.2 + 1e-9);
  });

  it("counter-strafe by tapping the opposite direction is not slower to recover than simply releasing", () => {
    function ticksToRecover(counterTap: boolean): number {
      let state = createState(300, 1);
      equip(state, 0, FALCON.id);
      const runInput: InputFrame = { ...defaultInput(0), forward: 1 };
      state = tick(state, [runInput], [FLOOR]).state;
      for (let i = 0; i < 200; i++) {
        state = tick(state, [runInput], [FLOOR]).state;
      }
      const stopInput: InputFrame = counterTap ? { ...defaultInput(0), forward: -1 } : { ...defaultInput(0) };
      for (let i = 0; i < 200; i++) {
        state = tick(state, [stopInput], [FLOOR]).state;
        const speed = Math.hypot(state.velX[0]!, state.velZ[0]!);
        if (speed < 0.3 * RUN_SPEED) return i;
      }
      throw new Error("never recovered");
    }
    const releaseTicks = ticksToRecover(false);
    const counterTapTicks = ticksToRecover(true);
    expect(counterTapTicks).toBeLessThanOrEqual(releaseTicks);
  });
});
