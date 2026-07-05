import { LEVEL_BOXES } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { MAX_PROP_OVERHANG_M, PROPS, propOverhang, validatePropPlacement } from "../src/propPlacement.js";

describe("prop placement non-overlap (M5 acceptance criterion 3/spec item 2)", () => {
  it("has between 4 and 6 props", () => {
    expect(PROPS.length).toBeGreaterThanOrEqual(4);
    expect(PROPS.length).toBeLessThanOrEqual(6);
  });

  it("every prop overhangs its support box by no more than 0.15 m", () => {
    for (const prop of PROPS) {
      expect(propOverhang(prop, LEVEL_BOXES)).toBeLessThanOrEqual(MAX_PROP_OVERHANG_M);
    }
    expect(validatePropPlacement(PROPS, LEVEL_BOXES)).toBe(true);
  });

  it("flags a prop placed floating in open floor (not resting on/against anything) as invalid", () => {
    const badProp = { id: "bad", kind: "barrel" as const, supportBoxIndex: 6, x: 0, y: 0, z: 0, radius: 0.35, height: 0.6 };
    // (0,0) is out in the open mid lane, nowhere near crate index 6 (centered at x=-6, z=4).
    expect(propOverhang(badProp, LEVEL_BOXES)).toBeGreaterThan(MAX_PROP_OVERHANG_M);
    expect(validatePropPlacement([badProp], LEVEL_BOXES)).toBe(false);
  });

  it("an out-of-range supportBoxIndex is treated as unsupported (infinite overhang)", () => {
    const prop = { id: "orphan", kind: "barrel" as const, supportBoxIndex: 9999, x: 0, y: 0, z: 0, radius: 0.1, height: 0.1 };
    expect(propOverhang(prop, LEVEL_BOXES)).toBe(Infinity);
  });
});
