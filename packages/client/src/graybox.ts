import type { Box } from "@vg/sim";

/**
 * A collision box that also carries a render color. It is structurally a
 * `Box` (same minX..maxZ fields) so this exact same array is passed straight
 * into the sim's `tick()` for collision AND into the Three.js scene builder
 * for rendering — one source of truth, no duplicated geometry (M0 spec
 * acceptance criterion 8).
 */
export interface GrayboxSurface extends Box {
  color: number;
}

function box(
  center: readonly [number, number, number],
  size: readonly [number, number, number],
  color: number,
): GrayboxSurface {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = size;
  return {
    minX: cx - sx / 2,
    maxX: cx + sx / 2,
    minY: cy - sy / 2,
    maxY: cy + sy / 2,
    minZ: cz - sz / 2,
    maxZ: cz + sz / 2,
    color,
  };
}

const FLOOR_SIZE = 40;
const WALL_HEIGHT = 3;
const WALL_THICKNESS = 0.5;

const floor = box([0, -0.5, 0], [FLOOR_SIZE, 1, FLOOR_SIZE], 0x555a60);

const perimeterWalls: GrayboxSurface[] = [
  box([0, WALL_HEIGHT / 2, -FLOOR_SIZE / 2], [FLOOR_SIZE, WALL_HEIGHT, WALL_THICKNESS], 0x7a7f87),
  box([0, WALL_HEIGHT / 2, FLOOR_SIZE / 2], [FLOOR_SIZE, WALL_HEIGHT, WALL_THICKNESS], 0x7a7f87),
  box([-FLOOR_SIZE / 2, WALL_HEIGHT / 2, 0], [WALL_THICKNESS, WALL_HEIGHT, FLOOR_SIZE], 0x7a7f87),
  box([FLOOR_SIZE / 2, WALL_HEIGHT / 2, 0], [WALL_THICKNESS, WALL_HEIGHT, FLOOR_SIZE], 0x7a7f87),
];

// A short interior wall to run into / slide along.
const interiorWall = box([6, 1.5, 0], [0.5, 3, 8], 0x8a5a5a);

// Crates (Valorant-scale ~1.2 m) — a few stacked to make step-ups/ledges.
const crateColor = 0xb08a4a;
const crates: GrayboxSurface[] = [
  box([-6, 0.6, 4], [1.2, 1.2, 1.2], crateColor),
  box([-6, 1.8, 4], [1.2, 1.2, 1.2], crateColor),
  box([-4, 0.6, 4], [1.2, 1.2, 1.2], crateColor),
  box([-8, 0.6, -4], [1.2, 1.2, 1.2], crateColor),
];

// "Ramp" as a staircase of shallow boxes — the sim only collides against
// axis-aligned boxes (no sloped-surface collision), so a walkable incline is
// built from steps rather than a tilted plane. Each step is 0.2 m tall.
const RAMP_STEP_COUNT = 10;
const RAMP_STEP_HEIGHT = 0.2;
const RAMP_STEP_DEPTH = 0.9;
const RAMP_WIDTH = 3;
const rampColor = 0x6a7a8a;
const ramp: GrayboxSurface[] = [];
for (let i = 0; i < RAMP_STEP_COUNT; i++) {
  const stepTop = (i + 1) * RAMP_STEP_HEIGHT;
  const z = 10 + i * RAMP_STEP_DEPTH;
  ramp.push(box([0, stepTop / 2, z], [RAMP_WIDTH, stepTop, RAMP_STEP_DEPTH], rampColor));
}

export const GRAYBOX_BOXES: GrayboxSurface[] = [floor, ...perimeterWalls, interiorWall, ...crates, ...ramp];

export const SPAWN_POSITION = { x: 0, y: 0, z: -10 } as const;
