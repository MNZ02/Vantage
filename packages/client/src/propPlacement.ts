// M5 visual identity: non-colliding decorative props (barrel/cable-spool),
// placed OUT of walkable lanes per spec — each anchored to (resting on top
// of, or flush against) an existing LEVEL_BOXES collision box, verified by
// propOverhang() below to intrude no more than MAX_PROP_OVERHANG_M beyond
// that box's own horizontal footprint. Props are visual only (never added to
// any collision list), so this check exists purely to keep them from
// visually poking into open floor a player can actually stand on.
//
// Anchors are looked up by NAME via @vg/sim levels.ts's LEVEL_INDEX export
// (not hand-counted indices), so a layout change that reorders LEVEL_BOXES
// cannot silently strand a prop on the wrong support box.
import { LEVEL_BOXES, LEVEL_INDEX, type Box } from "@vg/sim";

export type PropKind = "barrel" | "cableSpool";

export interface PropSpec {
  readonly id: string;
  readonly kind: PropKind;
  /** Index into LEVEL_BOXES this prop rests on top of or flush against. */
  readonly supportBoxIndex: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Horizontal footprint radius, meters. */
  readonly radius: number;
  /** Visual height, meters (cylinder/torus extent along Y). */
  readonly height: number;
}

/** Spec: "props don't overlap walkable floor beyond 0.15 m". */
export const MAX_PROP_OVERHANG_M = 0.15;

function idx(name: string): number {
  const i = LEVEL_INDEX[name];
  if (i === undefined) throw new Error(`propPlacement: no LEVEL_BOXES entry named "${name}"`);
  return i;
}

/**
 * The level's props (prop.y is the prop's CENTER height): crate/block tops
 * hold barrels and spools (fully contained, zero overhang), and two more sit
 * flush against wall faces, centered on the wall's own centerline so they
 * protrude symmetrically only radius-halfThickness (0.1 m) into the room —
 * comfortably under the 0.15 m budget.
 */
export const PROPS: readonly PropSpec[] = [
  // On top of site cover (crate top y=1.2, generator top y=1.5, B-default top y=2, mid-court block top y=2, B low box top y=1.1).
  { id: "barrel-siteA-crate", kind: "barrel", supportBoxIndex: idx("siteACrateWest"), x: -26, y: 1.5, z: 13, radius: 0.35, height: 0.6 },
  { id: "spool-siteA-generator", kind: "cableSpool", supportBoxIndex: idx("siteAGenerator"), x: -19, y: 1.65, z: 20, radius: 0.4, height: 0.3 },
  { id: "spool-siteB-default", kind: "cableSpool", supportBoxIndex: idx("siteBDefault"), x: 22, y: 2.15, z: 13, radius: 0.4, height: 0.3 },
  { id: "barrel-midcourt-block", kind: "barrel", supportBoxIndex: idx("midCourtBlock"), x: 0, y: 2.3, z: 17, radius: 0.35, height: 0.6 },
  { id: "spool-siteB-lowbox", kind: "cableSpool", supportBoxIndex: idx("siteBLowBox"), x: 17, y: 1.25, z: 17, radius: 0.35, height: 0.3 },
  // Flush against a wall face (wall half-thickness 0.25; radius 0.35 → 0.1 m overhang). Spec caps total props at 6.
  { id: "barrel-divider-west", kind: "barrel", supportBoxIndex: idx("dividerWestNorth"), x: -12, y: 0.3, z: 4, radius: 0.35, height: 0.6 },
];

/** How far (m) a prop's horizontal footprint circle extends beyond its support box's own footprint. 0 = fully contained. */
export function propOverhang(prop: PropSpec, boxes: readonly Box[] = LEVEL_BOXES): number {
  const box = boxes[prop.supportBoxIndex];
  if (!box) return Infinity;
  const leftOverhangX = Math.max(0, box.minX - (prop.x - prop.radius));
  const rightOverhangX = Math.max(0, prop.x + prop.radius - box.maxX);
  const leftOverhangZ = Math.max(0, box.minZ - (prop.z - prop.radius));
  const rightOverhangZ = Math.max(0, prop.z + prop.radius - box.maxZ);
  return Math.max(leftOverhangX, rightOverhangX, leftOverhangZ, rightOverhangZ);
}

/** True iff every prop's overhang is within budget. */
export function validatePropPlacement(props: readonly PropSpec[] = PROPS, boxes: readonly Box[] = LEVEL_BOXES): boolean {
  return props.every((p) => propOverhang(p, boxes) <= MAX_PROP_OVERHANG_M);
}
