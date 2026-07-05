import { LEVEL_BOXES } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { computeOcclusion } from "../src/audio/occlusion.js";

// Interior wall (see @vg/sim levels.ts): box([6, 1.5, 0], [0.5, 3, 8]) -> x in
// [5.75, 6.25], y in [0, 3], z in [-4, 4]. Used below as a real "there's a
// wall in the way" fixture, and a nearby clear line as the "no wall" fixture.
describe("occlusion decision against real LEVEL_BOXES fixtures (M5 acceptance criterion 3)", () => {
  it("a wall directly between listener and source occludes", () => {
    const listener = { x: 5, y: 1, z: 0 };
    const source = { x: 7, y: 1, z: 0 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(true);
  });

  it("a clear line of sight (parallel to, but clear of, the interior wall) does not occlude", () => {
    const listener = { x: 5, y: 1, z: 10 };
    const source = { x: 5, y: 1, z: 15 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(false);
  });

  it("a crate between listener and source occludes", () => {
    // Crate index 7: box([-4, 0.6, 4], [1.2, 1.2, 1.2]) -> x in [-4.6,-3.4], z in [3.4,4.6].
    const listener = { x: -5, y: 0.9, z: 4 };
    const source = { x: -3, y: 0.9, z: 4 };
    expect(computeOcclusion(LEVEL_BOXES, listener, source).occluded).toBe(true);
  });

  it("listener and source at the same point never occlude (degenerate zero-distance case)", () => {
    const p = { x: 1, y: 1, z: 1 };
    expect(computeOcclusion(LEVEL_BOXES, p, p).occluded).toBe(false);
  });
});
