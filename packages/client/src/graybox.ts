import { LEVEL_BOXES, SPAWN_POSITION as SIM_SPAWN_POSITION, type Box } from "@vg/sim";

/**
 * A collision box that also carries a render color. It is structurally a
 * `Box` (same minX..maxZ fields) built by zipping @vg/sim's `LEVEL_BOXES`
 * (the single source of truth for collision geometry, shared with
 * @vg/server) with a parallel color list by index — one source of truth for
 * geometry, client-only concern (color) layered on top (M0 spec acceptance
 * criterion 8; M1 spec's shared-level-data requirement).
 */
export interface GrayboxSurface extends Box {
  color: number;
}

// Colors in the same order LEVEL_BOXES were originally authored in:
// floor, 4 perimeter walls, interior wall, 3 crates, 10 ramp steps, ramp top.
const WALL_COLOR = 0x7a7f87;
const CRATE_COLOR = 0xb08a4a;
const LOW_CRATE_COLOR = 0x9a9a5a;
const RAMP_COLOR = 0x6a7a8a;

const colors: number[] = [
  0x555a60, // floor
  WALL_COLOR,
  WALL_COLOR,
  WALL_COLOR,
  WALL_COLOR, // perimeter walls
  0x8a5a5a, // interior wall
  LOW_CRATE_COLOR, // jump-mountable ledge
  CRATE_COLOR, // cover, too tall to mount
  CRATE_COLOR, // cover, too tall to mount
];
while (colors.length < LEVEL_BOXES.length) colors.push(RAMP_COLOR); // ramp steps + top

export const GRAYBOX_BOXES: GrayboxSurface[] = LEVEL_BOXES.map((b, i) => ({ ...b, color: colors[i]! }));

export const SPAWN_POSITION = SIM_SPAWN_POSITION;
