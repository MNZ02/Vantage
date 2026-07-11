import { describe, expect, it } from "vitest";
import { viewmodelCompositionForAspect } from "../src/viewmodel.js";

describe("responsive viewmodel composition", () => {
  it("keeps landscape framing unchanged", () => {
    expect(viewmodelCompositionForAspect(16 / 9)).toEqual({ scale: 1, x: 0.16, y: -0.13, z: -0.35 });
  });

  it("pulls portrait framing inward, down, and away from the aim point", () => {
    const portrait = viewmodelCompositionForAspect(390 / 844);
    expect(portrait.scale).toBeLessThan(0.7);
    expect(portrait.x).toBeLessThan(0.09);
    expect(portrait.y).toBeLessThan(-0.16);
    expect(portrait.z).toBeLessThan(-0.4);
  });
});
