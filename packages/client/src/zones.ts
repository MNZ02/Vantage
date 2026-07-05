// M5 visual identity: deterministic per-zone classification of the graybox's
// static collision geometry, driving both material/color selection
// (materials.ts + graybox.ts) and where new detail meshes/props get placed.
//
// Deliberately built from @vg/sim's own SITE_ZONES/BARRIERS (the single
// source of truth for where sites and the buy-phase barriers are), not a
// hand-authored per-box list — the only "exceptions" are the two barrier
// z-lines themselves, which are read from BARRIERS rather than duplicated as
// magic numbers. This keeps the mapping honest if the level data ever shifts
// (spec: "no hardcoded per-box hand-list longer than ~a dozen exceptions").
import { BARRIERS, SITE_ZONES, type Box } from "@vg/sim";

export type Zone = "attackerSide" | "defenderSide" | "mid" | "siteA" | "siteB";

function centerX(box: Box): number {
  return (box.minX + box.maxX) / 2;
}
function centerY(box: Box): number {
  return (box.minY + box.maxY) / 2;
}
function centerZ(box: Box): number {
  return (box.minZ + box.maxZ) / 2;
}

function pointInBox(x: number, y: number, z: number, box: Box): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
}

const attackerBarrier = BARRIERS.find((b) => b.team === 0)!.box;
const defenderBarrier = BARRIERS.find((b) => b.team === 1)!.box;

/** z-line beyond which (south) a box is on the attacker side of mid. */
const ATTACKER_LINE_Z = centerZ(attackerBarrier);
/** z-line beyond which (north) a box is on the defender side of mid. */
const DEFENDER_LINE_Z = centerZ(defenderBarrier);

/**
 * Classifies a box into exactly one zone: a site zone wins if the box's
 * CENTER lies inside a SITE_ZONES bounding volume (center-containment, not
 * bounding-box overlap — the level's single floor/perimeter-wall boxes
 * geometrically overlap every zone's bounding volume, so an overlap test
 * would wrongly tag them "site"; center-containment correctly leaves those
 * large shared boxes classified by their actual centroid instead); otherwise
 * the box falls to whichever side of the two mid-lane barriers its center
 * sits on, or "mid" between them.
 */
export function classifyZone(box: Box): Zone {
  const cx = centerX(box);
  const cy = centerY(box);
  const cz = centerZ(box);

  for (const site of SITE_ZONES) {
    if (pointInBox(cx, cy, cz, site.box)) return site.name === "A" ? "siteA" : "siteB";
  }
  if (cz <= ATTACKER_LINE_Z) return "attackerSide";
  if (cz >= DEFENDER_LINE_Z) return "defenderSide";
  return "mid";
}

/** Classifies every box in `boxes`, in order — used by graybox.ts to pick a material/color per LEVEL_BOX index. */
export function classifyZones(boxes: readonly Box[]): Zone[] {
  return boxes.map(classifyZone);
}
