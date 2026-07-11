import { describe, expect, it } from "vitest";
import { minimapBackingStoreSize, worldToMinimapPoint } from "../src/hudLayout.js";
import { loadDebugHudVisible, saveDebugHudVisible } from "../src/hudPreferences.js";

describe("minimap projection", () => {
  it("maps +Z north/up and preserves east/right", () => {
    expect(worldToMinimapPoint(0, 0, 40, 200)).toEqual({ x: 100, y: 100 });
    expect(worldToMinimapPoint(0, 40, 40, 200)).toEqual({ x: 100, y: 0 });
    expect(worldToMinimapPoint(40, 0, 40, 200)).toEqual({ x: 200, y: 100 });
    expect(worldToMinimapPoint(0, -40, 40, 200)).toEqual({ x: 100, y: 200 });
  });

  it("caps and rounds the HiDPI backing store", () => {
    expect(minimapBackingStoreSize(173, 1)).toBe(173);
    expect(minimapBackingStoreSize(173, 1.5)).toBe(260);
    expect(minimapBackingStoreSize(173, 3)).toBe(346);
    expect(minimapBackingStoreSize(173, Number.NaN)).toBe(173);
  });
});

describe("debug HUD preference", () => {
  it("defaults safely and round-trips through storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(loadDebugHudVisible(storage)).toBe(false);
    saveDebugHudVisible(storage, true);
    expect(loadDebugHudVisible(storage)).toBe(true);
  });
});
