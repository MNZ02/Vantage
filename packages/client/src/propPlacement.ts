// M5 visual identity: non-colliding decorative props (barrel/cable-spool),
// placed OUT of walkable lanes per spec — each anchored to (resting on top
// of, or flush against) an existing LEVEL_BOXES collision box, verified by
// propOverhang() below to intrude no more than MAX_PROP_OVERHANG_M beyond
// that box's own horizontal footprint. Props are visual only (never added to
// any collision list), so this check exists purely to keep them from
// visually poking into open floor a player can actually stand on.
//
// LEVEL_BOXES index reference (see @vg/sim levels.ts, fixed authoring order):
//   0        floor
//   1-4      perimeter walls (south z=-20, north z=+20, west x=-20, east x=+20)
//   5        interior wall (x=6, z in [-4,4])
//   6-8      crates
//   9-18     ramp steps
//   19       ramp top
import { LEVEL_BOXES, type Box } from "@vg/sim";

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

const CRATE_A = 6; // box([-6, 0.4, 4], [1.2, 0.8, 1.2]) — low ledge, top y=0.8
const CRATE_B = 7; // box([-4, 0.6, 4], [1.2, 1.2, 1.2]) — top y=1.2
const CRATE_C = 8; // box([-8, 0.6, -4], [1.2, 1.2, 1.2]) — top y=1.2
const RAMP_TOP = 19;
const INTERIOR_WALL = 5;
const SOUTH_PERIMETER_WALL = 1;

/**
 * The level's props: two crates each hold one prop on top (fully contained,
 * zero overhang), the ramp top holds one, and two more sit flush against
 * flat wall faces (interior wall, south perimeter wall) centered on the
 * wall's own centerline so they protrude symmetrically only
 * radius-halfThickness into the room — comfortably under the 0.15 m budget.
 */
export const PROPS: readonly PropSpec[] = [
  { id: "barrel-crateA", kind: "barrel", supportBoxIndex: CRATE_A, x: -6, y: 0.8, z: 4, radius: 0.35, height: 0.6 },
  { id: "spool-crateB", kind: "cableSpool", supportBoxIndex: CRATE_B, x: -4, y: 1.2, z: 4, radius: 0.4, height: 0.3 },
  { id: "barrel-crateC", kind: "barrel", supportBoxIndex: CRATE_C, x: -8, y: 1.2, z: -4, radius: 0.35, height: 0.6 },
  { id: "spool-rampTop", kind: "cableSpool", supportBoxIndex: RAMP_TOP, x: 0.5, y: 2, z: 20.5, radius: 0.4, height: 0.3 },
  { id: "barrel-interiorWall", kind: "barrel", supportBoxIndex: INTERIOR_WALL, x: 6, y: 0.3, z: 2, radius: 0.35, height: 0.6 },
  { id: "spool-southWall", kind: "cableSpool", supportBoxIndex: SOUTH_PERIMETER_WALL, x: -15, y: 0.15, z: -20, radius: 0.35, height: 0.3 },
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
