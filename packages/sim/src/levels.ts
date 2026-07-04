// Shared graybox level geometry: the single source of truth for collision
// boxes and spawn points, consumed by both @vg/client (rendering + local
// prediction) and @vg/server (authoritative sim) so they can never drift
// apart. Kept in @vg/sim rather than a separate @vg/levels package: sim
// already owns the `Box` type, this data is plain and tiny, and it lets the
// server depend on just @vg/sim instead of another workspace package.
//
// Client-only concerns (render color, mesh materials) stay in
// packages/client/src/graybox.ts, which imports LEVEL_BOXES and zips each
// entry with a color by array index.

import { PI, cosApprox, sinApprox } from "./math.js";
import type { Box } from "./state.js";

function box(center: readonly [number, number, number], size: readonly [number, number, number]): Box {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  return {
    minX: cx - sx / 2,
    maxX: cx + sx / 2,
    minY: cy - sy / 2,
    maxY: cy + sy / 2,
    minZ: cz - sz / 2,
    maxZ: cz + sz / 2,
  };
}

const FLOOR_SIZE = 40;
const WALL_HEIGHT = 3;
const WALL_THICKNESS = 0.5;

const floor = box([0, -0.5, 0], [FLOOR_SIZE, 1, FLOOR_SIZE]);

const perimeterWalls: Box[] = [
  box([0, WALL_HEIGHT / 2, -FLOOR_SIZE / 2], [FLOOR_SIZE, WALL_HEIGHT, WALL_THICKNESS]),
  box([0, WALL_HEIGHT / 2, FLOOR_SIZE / 2], [FLOOR_SIZE, WALL_HEIGHT, WALL_THICKNESS]),
  box([-FLOOR_SIZE / 2, WALL_HEIGHT / 2, 0], [WALL_THICKNESS, WALL_HEIGHT, FLOOR_SIZE]),
  box([FLOOR_SIZE / 2, WALL_HEIGHT / 2, 0], [WALL_THICKNESS, WALL_HEIGHT, FLOOR_SIZE]),
];

const interiorWall = box([6, 1.5, 0], [0.5, 3, 8]);

const crates: Box[] = [
  box([-6, 0.4, 4], [1.2, 0.8, 1.2]),
  box([-4, 0.6, 4], [1.2, 1.2, 1.2]),
  box([-8, 0.6, -4], [1.2, 1.2, 1.2]),
];

const RAMP_STEP_COUNT = 10;
const RAMP_STEP_HEIGHT = 0.2;
const RAMP_STEP_DEPTH = 0.9;
const RAMP_WIDTH = 3;
const ramp: Box[] = [];
for (let i = 0; i < RAMP_STEP_COUNT; i++) {
  const stepTop = (i + 1) * RAMP_STEP_HEIGHT;
  const z = 10 + i * RAMP_STEP_DEPTH;
  ramp.push(box([0, stepTop / 2, z], [RAMP_WIDTH, stepTop, RAMP_STEP_DEPTH]));
}
const RAMP_TOP_HEIGHT = RAMP_STEP_COUNT * RAMP_STEP_HEIGHT;
const RAMP_TOP_DEPTH = 4;
const lastStepFarZ = 10 + (RAMP_STEP_COUNT - 1) * RAMP_STEP_DEPTH + RAMP_STEP_DEPTH / 2;
const rampTop = box([0, RAMP_TOP_HEIGHT / 2, lastStepFarZ + RAMP_TOP_DEPTH / 2], [RAMP_WIDTH, RAMP_TOP_HEIGHT, RAMP_TOP_DEPTH]);

/** The graybox level's static collision geometry, in a fixed, stable order. */
export const LEVEL_BOXES: Box[] = [floor, ...perimeterWalls, interiorWall, ...crates, ...ramp, rampTop];

/** Single-player / player-0 spawn used by the M0 offline mode. */
export const SPAWN_POSITION = { x: 0, y: 0, z: -10 } as const;

/**
 * Per-index multiplayer spawn offsets around the single-player spawn, spread
 * out on a ring so joining players don't stack on top of each other.
 */
export function spawnForIndex(index: number): { x: number; y: number; z: number } {
  if (index === 0) return { x: SPAWN_POSITION.x, y: SPAWN_POSITION.y, z: SPAWN_POSITION.z };
  const angle = (index / 16) * (2 * PI);
  const radius = 3;
  return {
    x: SPAWN_POSITION.x + cosApprox(angle) * radius,
    y: SPAWN_POSITION.y,
    z: SPAWN_POSITION.z + sinApprox(angle) * radius,
  };
}
