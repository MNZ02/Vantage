import {
  ABL_SONAR_RAIL,
  ABL_ZEPHYR_BLADES,
  WEAPON_FALCON,
  abilityWeaponId,
} from "@vg/sim";
import { describe, expect, it } from "vitest";
import { getShotPresentationWeapon } from "../src/shotPresentation.js";

describe("shot presentation weapon resolution", () => {
  it("resolves ordinary and ultimate weapon shots", () => {
    expect(getShotPresentationWeapon(WEAPON_FALCON)?.name).toBe("Falcon");
    expect(getShotPresentationWeapon(abilityWeaponId(ABL_ZEPHYR_BLADES))?.name).toBe("Zephyr Blades");
    expect(getShotPresentationWeapon(abilityWeaponId(ABL_SONAR_RAIL))?.name).toBe("Sonar Rail");
  });
});
