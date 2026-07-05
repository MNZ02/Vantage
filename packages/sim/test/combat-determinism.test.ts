import { describe, expect, it } from "vitest";
import {
  LEVEL_BOXES,
  WEAPONS,
  applyDamage,
  applyTag,
  createState,
  damageForHit,
  serializeState,
  tick,
  type InputFrame,
  type SimState,
} from "../src/index.js";

const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

function scriptedInput(playerIndex: number, t: number): InputFrame {
  const phase = playerIndex * 91;
  const yaw = Math.sin((t + phase) * 0.01) * 2;
  return {
    forward: Math.sin((t + phase) * 0.05) > 0 ? 1 : -1,
    right: Math.cos((t + phase) * 0.07) > 0 ? 1 : -1,
    yaw,
    pitch: Math.sin((t + phase) * 0.013) * 0.2,
    jump: (t + phase) % 131 === 0,
    crouch: (t + phase) % 240 < 50,
    walk: (t + phase) % 300 < 40,
    fire: (t + phase) % 5 < 3,
    ads: (t + phase) % 190 === 0,
    reload: (t + phase) % 340 < 4,
    slot1: (t + phase) % 401 === 0,
    slot2: (t + phase) % 457 === 0,
  };
}

function equip(state: SimState, playerIndex: number): void {
  state.weaponPrimary[playerIndex] = FALCON.id;
  state.activeSlot[playerIndex] = 0;
  state.magPrimary[playerIndex] = FALCON.magSize;
  state.reservePrimary[playerIndex] = FALCON.reserveAmmo;
}

/**
 * Runs two players fighting for `count` ticks: each tick's ShotEvents are
 * resolved immediately (same-tick, no lag comp — determinism doesn't care
 * about lag comp specifics, only that applyDamage is applied identically
 * given the same shot sequence) against a fixed hit chance derived
 * deterministically from tick index, so both runs see the exact same
 * "hits" regardless of wall-clock/randomness.
 */
function runCombat(seed: number, count: number): string[] {
  let state = createState(seed, 2);
  state.posX[0] = 0;
  state.posZ[0] = 0;
  state.posX[1] = 5;
  state.posZ[1] = 0;
  equip(state, 0);
  equip(state, 1);

  const snapshots: string[] = [];
  for (let t = 0; t < count; t++) {
    const inputs = [scriptedInput(0, t), scriptedInput(1, t)];
    const result = tick(state, inputs, LEVEL_BOXES);
    state = result.state;

    for (const shot of result.shots) {
      const targetIndex = shot.playerIndex === 0 ? 1 : 0;
      // Deterministic "hit" decision from tick/shot index only (no PRNG state consumption).
      if ((shot.shotIndex + t) % 3 === 0 && state.alive[targetIndex] === 1) {
        const dist = 5;
        const region = shot.shotIndex % 3 === 0 ? "head" : shot.shotIndex % 3 === 1 ? "body" : "legs";
        const dmg = damageForHit(FALCON, dist, region);
        state = applyDamage(state, targetIndex, dmg);
        state = applyTag(state, targetIndex);
      }
    }

    if ((t + 1) % 500 === 0) snapshots.push(serializeState(state));
  }
  return snapshots;
}

describe("determinism with combat (acceptance criterion 3)", () => {
  it("two identical 2-player combat runs of 2000 ticks produce byte-identical serialized states every 500 ticks", () => {
    const a = runCombat(555, 2000);
    const b = runCombat(555, 2000);
    expect(a.length).toBe(4);
    expect(a).toEqual(b);
    // Sanity: combat actually happened (deaths/damage occurred), not a no-op scenario.
    expect(a.some((s) => s.includes("alive:0,1") || s.includes("alive:1,0"))).toBe(true);
  });
});
