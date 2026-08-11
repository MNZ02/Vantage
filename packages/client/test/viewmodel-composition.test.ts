import { describe, expect, it } from "vitest";
import {
  VIEWMODEL_SCALE,
  WORLD_BASE_FOV_DEG,
  viewmodelCompositionForAspect,
  viewmodelFovCompensation,
} from "../src/viewmodel.js";

describe("responsive viewmodel composition", () => {
  it("keeps landscape framing at the authored scale", () => {
    expect(viewmodelCompositionForAspect(16 / 9)).toEqual({
      scale: VIEWMODEL_SCALE,
      x: 0.16,
      y: -0.13,
      z: -0.35,
    });
  });

  it("pulls portrait framing inward, down, and away from the aim point", () => {
    const landscape = viewmodelCompositionForAspect(16 / 9);
    const portrait = viewmodelCompositionForAspect(390 / 844);
    // relative, so raising VIEWMODEL_SCALE cannot quietly undo the pull-in
    expect(portrait.scale).toBeLessThan(landscape.scale * 0.55);
    expect(portrait.x).toBeLessThan(0.09);
    expect(portrait.y).toBeLessThan(-0.16);
    expect(portrait.z).toBeLessThan(-0.4);
  });
});

describe("viewmodel FOV compensation", () => {
  it("is a no-op at the world's base FOV", () => {
    expect(viewmodelFovCompensation(WORLD_BASE_FOV_DEG)).toBeCloseTo(1, 6);
  });

  it("cancels the magnification that zooming the world camera applies", () => {
    // A child of the camera grows by tan(base/2)/tan(fov/2) as the FOV narrows;
    // compensation has to be exactly that reciprocal, or ADS rescales the rig.
    for (const zoom of [1.15, 1.25, 2.5, 5]) {
      const fov = WORLD_BASE_FOV_DEG / zoom;
      const magnification =
        Math.tan((WORLD_BASE_FOV_DEG * Math.PI) / 360) / Math.tan((fov * Math.PI) / 360);
      expect(viewmodelFovCompensation(fov) * magnification).toBeCloseTo(1, 6);
    }
  });

  it("shrinks the rig as the world camera zooms in", () => {
    expect(viewmodelFovCompensation(72)).toBeLessThan(1);
    expect(viewmodelFovCompensation(18)).toBeLessThan(viewmodelFovCompensation(72));
  });

  it("falls back to 1 for degenerate FOVs", () => {
    for (const bad of [0, -10, 180, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(viewmodelFovCompensation(bad)).toBe(1);
    }
  });
});
