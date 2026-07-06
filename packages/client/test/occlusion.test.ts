import { LEVEL_BOXES } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { computeOcclusion } from "../src/audio/occlusion.js";

// East lane-divider wall (see @vg/sim levels.ts): wallNS(12, -1, 8) -> x in
// [11.75, 12.25], y in [0, 3], z in [-1, 8]. Used below as a real "there's a
// wall in the way" fixture, and a nearby clear line as the "no wall" fixture.
describe("occlusion decision against real LEVEL_BOXES fixtures (M5 acceptance criterion 3)", () => {
  it("a wall directly between listener and source occludes", () => {
    const listener = { x: 11, y: 1, z: 4 };
    const source = { x: 13, y: 1, z: 4 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(true);
  });

  it("a clear line of sight (parallel to, but clear of, the interior wall) does not occlude", () => {
    const listener = { x: 5, y: 1, z: 10 };
    const source = { x: 5, y: 1, z: 15 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(false);
  });

  it("a crate between listener and source occludes", () => {
    // Crate index 7: box([-4, 0.6, 4], [1.2, 1.2, 1.2]) -> x in [-4.6,-3.4], z in [3.4,4.6].
    const listener = { x: 4.5, y: 0.9, z: -8 };
    const source = { x: 7.5, y: 0.9, z: -8 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(true);
  });

  it("listener and source at the same point never occlude (degenerate zero-distance case)", () => {
    const p = { x: 1, y: 1, z: 1 };
    expect(computeOcclusion(LEVEL_BOXES, p, p).occluded).toBe(false);
  });
});
