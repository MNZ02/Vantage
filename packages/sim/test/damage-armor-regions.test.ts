import { describe, expect, it } from "vitest";
import {
  ARMOR_ABSORB_RATE,
  CROUCH_HEIGHT,
  STAND_HEIGHT,
  WEAPONS,
  applyDamage,
  createState,
  damageForHit,
  regionForHitHeight,
} from "../src/index.js";

const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;
const KESTREL = WEAPONS.find((w) => w.name === "Kestrel")!;
const LONGBOW = WEAPONS.find((w) => w.name === "Longbow")!;
const WASP = WEAPONS.find((w) => w.name === "Wasp")!;

describe("damage/armor/regions (acceptance criterion 8)", () => {
  it("Falcon headshot kills unarmored instantly at 10m and 40m (flat damage)", () => {
    let state = createState(1, 2);
    const dmgNear = damageForHit(FALCON, 10, "head");
    const dmgFar = damageForHit(FALCON, 40, "head");
    expect(dmgNear).toBe(160);
    expect(dmgFar).toBe(160);
    state = applyDamage(state, 1, dmgNear);
    expect(state.alive[1]).toBe(0);
    expect(state.health[1]).toBe(0);
  });

  it("Kestrel body at 20m deals exactly 35", () => {
    expect(damageForHit(KESTREL, 20, "body")).toBe(35);
  });

  it("Longbow body (150) is lethal alone against 100 HP", () => {
    const dmg = damageForHit(LONGBOW, 10, "body");
    let state = createState(2, 2);
    state = applyDamage(state, 1, dmg);
    expect(state.alive[1]).toBe(0);
  });

  it("legs < body < head for every weapon's every band", () => {
    for (const w of WEAPONS) {
      for (const band of w.damageBands) {
        expect(band.legs).toBeLessThan(band.body);
        expect(band.body).toBeLessThan(band.head);
      }
    }
  });

  it("with 50 armor, Wasp body shots-to-kill is strictly greater than unarmored", () => {
    const dmg = damageForHit(WASP, 5, "body");

    let unarmored = createState(3, 2);
    let shotsUnarmored = 0;
    while (unarmored.alive[1] === 1) {
      unarmored = applyDamage(unarmored, 1, dmg);
      shotsUnarmored++;
      if (shotsUnarmored > 100) throw new Error("test setup error: never died");
    }

    let armored = createState(4, 2);
    armored.armor[1] = 50;
    let shotsArmored = 0;
    while (armored.alive[1] === 1) {
      armored = applyDamage(armored, 1, dmg);
      shotsArmored++;
      if (shotsArmored > 100) throw new Error("test setup error: never died");
    }

    expect(shotsArmored).toBeGreaterThan(shotsUnarmored);
  });

  it("armor absorbs 66% of damage until depleted, remainder always hits health", () => {
    let state = createState(5, 2);
    state.armor[1] = 10; // small armor pool, will deplete mid-hit
    const damage = 50;
    const before = { health: state.health[1]!, armor: state.armor[1]! };
    state = applyDamage(state, 1, damage);

    const armorAbsorbed = Math.min(before.armor, damage * ARMOR_ABSORB_RATE);
    const expectedHealthLoss = damage - armorAbsorbed;
    expect(state.armor[1]).toBe(Math.max(0, before.armor - armorAbsorbed));
    expect(state.health[1]).toBeCloseTo(before.health - expectedHealthLoss, 0);
    // Armor should be fully depleted (10 < 50*0.66) before health absorbs everything.
    expect(state.armor[1]).toBe(0);
  });

  it("region boundaries: crafted hit heights return the right region (standing capsule)", () => {
    const feetY = 0;
    const height = STAND_HEIGHT;
    expect(regionForHitHeight(feetY + 0.1, feetY, height)).toBe("legs");
    expect(regionForHitHeight(feetY + height * 0.44, feetY, height)).toBe("legs");
    expect(regionForHitHeight(feetY + height * 0.5, feetY, height)).toBe("body");
    expect(regionForHitHeight(feetY + height - 0.1, feetY, height)).toBe("head");
    expect(regionForHitHeight(feetY + height - 0.31, feetY, height)).toBe("body");
  });

  it("region boundaries also work for a crouching capsule", () => {
    const feetY = 5;
    const height = CROUCH_HEIGHT;
    expect(regionForHitHeight(feetY + 0.05, feetY, height)).toBe("legs");
    expect(regionForHitHeight(feetY + height / 2, feetY, height)).toBe("body");
    expect(regionForHitHeight(feetY + height - 0.05, feetY, height)).toBe("head");
  });
});
