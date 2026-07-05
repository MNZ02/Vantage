import { describe, expect, it } from "vitest";
import { WEAPONS, damageForHit, type WeaponDef } from "../src/index.js";

const AUTOMATIC_NAMES = new Set(["Wasp", "Falcon", "Kestrel"]);

describe("weapons data (acceptance criterion 2)", () => {
  it("every weapon has complete, self-consistent data", () => {
    expect(WEAPONS.length).toBe(6);
    for (const w of WEAPONS) {
      expect(w.price).toBeGreaterThanOrEqual(0);
      expect(w.magSize).toBeGreaterThan(0);
      expect(w.reserveAmmo).toBeGreaterThanOrEqual(0);
      expect(w.fireRateRps).toBeGreaterThan(0);
      expect(w.equipDelayTicks).toBeGreaterThan(0);
      expect(w.reloadTicks).toBeGreaterThan(0);

      // damage bands ordered ascending by maxDist, last is Infinity
      expect(w.damageBands.length).toBeGreaterThan(0);
      for (let i = 1; i < w.damageBands.length; i++) {
        expect(w.damageBands[i]!.maxDist).toBeGreaterThan(w.damageBands[i - 1]!.maxDist);
      }
      expect(w.damageBands[w.damageBands.length - 1]!.maxDist).toBe(Infinity);
      for (const band of w.damageBands) {
        expect(band.head).toBeGreaterThan(band.body);
        expect(band.body).toBeGreaterThan(band.legs);
      }

      if (AUTOMATIC_NAMES.has(w.name)) {
        expect(w.sprayPattern.length).toBeGreaterThanOrEqual(w.magSize);
      }
      expect(w.baseSpreadRad).toBeGreaterThanOrEqual(0);
      expect(w.movementSpreadRad).toBeGreaterThan(0);
      expect(w.crouchSpreadMult).toBeLessThan(1);
      expect(w.airSpreadMult).toBeGreaterThan(1);
      expect(w.adsZoomStages.length).toBeGreaterThan(0);
    }

    // At least one free sidearm.
    expect(WEAPONS.some((w) => w.price === 0)).toBe(true);
    // Longbow is the 2-stage scope.
    const longbow = WEAPONS.find((w) => w.name === "Longbow")!;
    expect(longbow.adsZoomStages.length).toBe(2);
  });

  it("damageForHit reads purely from the passed-in weapon def — no hardcoded damage constants in logic code", () => {
    const base: WeaponDef = WEAPONS.find((w) => w.name === "Falcon")!;
    expect(damageForHit(base, 10, "head")).toBe(160);
    expect(damageForHit(base, 40, "head")).toBe(160); // flat regardless of range

    // Test-local injection: change the table value and confirm the pure
    // resolver's output changes accordingly (proves no hardcoded damage
    // constant is shadowing the table in the resolution logic itself).
    const patched: WeaponDef = { ...base, damageBands: [{ maxDist: Infinity, head: 999, body: 40, legs: 34 }] };
    expect(damageForHit(patched, 10, "head")).toBe(999);
  });

  it("Kestrel body damage matches the spec'd falloff breakpoint", () => {
    const kestrel = WEAPONS.find((w) => w.name === "Kestrel")!;
    expect(damageForHit(kestrel, 20, "body")).toBe(35);
    expect(damageForHit(kestrel, 10, "body")).toBe(39);
  });

  it("Longbow body damage is lethal against 100 HP unarmored", () => {
    const longbow = WEAPONS.find((w) => w.name === "Longbow")!;
    const bodyDamage = damageForHit(longbow, 10, "body");
    expect(bodyDamage).toBe(150);
    expect(bodyDamage).toBeGreaterThanOrEqual(100);
  });
});
