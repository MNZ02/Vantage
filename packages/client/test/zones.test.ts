import { LEVEL_BOXES, SITE_ZONES, ATTACKER_SPAWNS, DEFENDER_SPAWNS, type Box } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { classifyZone, classifyZones } from "../src/zones.js";

function pointBox(x: number, y: number, z: number): Box {
  return { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
}

describe("zone classification (M5 acceptance criterion 3)", () => {
  it("maps every LEVEL_BOX to exactly one zone", () => {
    const zones = classifyZones(LEVEL_BOXES);
    expect(zones).toHaveLength(LEVEL_BOXES.length);
    for (const z of zones) {
      expect(["attackerSide", "defenderSide", "mid", "siteA", "siteB"]).toContain(z);
    }
  });

  it("classifies a point inside site A's zone as siteA, and site B's as siteB", () => {
    const a = SITE_ZONES.find((s) => s.name === "A")!;
    const b = SITE_ZONES.find((s) => s.name === "B")!;
    const centerA = pointBox((a.box.minX + a.box.maxX) / 2, (a.box.minY + a.box.maxY) / 2, (a.box.minZ + a.box.maxZ) / 2);
    const centerB = pointBox((b.box.minX + b.box.maxX) / 2, (b.box.minY + b.box.maxY) / 2, (b.box.minZ + b.box.maxZ) / 2);
    expect(classifyZone(centerA)).toBe("siteA");
    expect(classifyZone(centerB)).toBe("siteB");
  });

  it("classifies attacker spawns as attackerSide and defender spawns as defenderSide", () => {
    for (const spawn of ATTACKER_SPAWNS) {
      expect(classifyZone(pointBox(spawn.x, spawn.y, spawn.z))).toBe("attackerSide");
    }
    for (const spawn of DEFENDER_SPAWNS) {
      expect(classifyZone(pointBox(spawn.x, spawn.y, spawn.z))).toBe("defenderSide");
    }
  });

  it("classifies the open mid lane (origin) as mid", () => {
    expect(classifyZone(pointBox(0, 0.5, 0))).toBe("mid");
  });

  it("the large floor/perimeter-wall boxes are classified by their own centroid, not misclassified as a site just because they geometrically overlap it", () => {
    const floor = LEVEL_BOXES[0]!; // spans the whole map, including under both site zones
    expect(classifyZone(floor)).toBe("mid");
  });
});
