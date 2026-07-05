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

/**
 * Deathmatch respawn points, spread over the graybox's open floor area, well
 * clear of the interior wall (x in [5.75, 6.25]), crates, and the ramp
 * (z >= 10). Selection at respawn time is `hash(seed, playerIndex, tick) %
 * DM_SPAWNS.length` (see weapons/logic.ts respawnPlayer()) — deterministic
 * in-sim so client prediction/replay of the local player's own respawn
 * agrees with the server bit-for-bit.
 */
export const DM_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: 0, y: 0, z: -10, yaw: 0 },
  { x: 12, y: 0, z: -12, yaw: PI },
  { x: -12, y: 0, z: -12, yaw: PI / 2 },
  { x: 12, y: 0, z: 12, yaw: -PI / 2 },
  { x: -12, y: 0, z: 6, yaw: PI / 4 },
  { x: -14, y: 0, z: -6, yaw: -PI / 4 },
  { x: 14, y: 0, z: 2, yaw: (3 * PI) / 4 },
  { x: -2, y: 0, z: 16, yaw: -(3 * PI) / 4 },
  { x: 8, y: 0, z: -16, yaw: PI / 3 },
  { x: -8, y: 0, z: -16, yaw: -PI / 3 },
];

// ---- M3 match-mode level data ----
//
// Graybox layout (top-down, +Z is "north"): attackers spawn deep south
// (z ~ -18), defenders deep north (z ~ +18); two site zones sit off to the
// east/west of the open mid lane around z in [-1, 9], well clear of the
// existing interior wall/crates (x in [-8, 8], z in [-4, 4]) and the ramp
// (z >= 10). Two BARRIER boxes bisect the mid lane at z = -8 and z = +8 —
// each blocks only ONE team, so during the buy phase attackers are held
// south of z=-8 and defenders north of z=+8, leaving a no-man's-land between
// them; both barriers disappear (are simply not added to the collision list)
// once the round phase starts. Kept intentionally simple per the M3 spec
// ("a few added boxes are fine — keep it shared collision+render data").

/** Attacker (team 0) spawn points, south end of the map, facing north (+Z, yaw 0). */
export const ATTACKER_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: -8, y: 0, z: -18, yaw: 0 },
  { x: -4, y: 0, z: -18, yaw: 0 },
  { x: 0, y: 0, z: -18, yaw: 0 },
  { x: 4, y: 0, z: -18, yaw: 0 },
  { x: 8, y: 0, z: -18, yaw: 0 },
];

/** Defender (team 1) spawn points, north end of the map, facing south (-Z, yaw PI). */
export const DEFENDER_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: -8, y: 0, z: 18, yaw: PI },
  { x: -4, y: 0, z: 18, yaw: PI },
  { x: 0, y: 0, z: 18, yaw: PI },
  { x: 4, y: 0, z: 18, yaw: PI },
  { x: 8, y: 0, z: 18, yaw: PI },
];

/** Plant/defuse site zones — purely logical regions (not collision), tested by point-in-box. */
export const SITE_ZONES: ReadonlyArray<{ name: "A" | "B"; box: Box }> = [
  { name: "A", box: box([-14, 0.5, 4], [8, 3, 10]) },
  { name: "B", box: box([14, 0.5, 4], [8, 3, 10]) },
];

/**
 * Buy-phase-only collision barriers. `team` names which team the box blocks —
 * the OTHER team walks through it freely. Both entries are simply omitted
 * from a player's effective collision list once matchPhase leaves PHASE_BUY
 * — see tick.ts's per-player effective-boxes assembly.
 */
export const BARRIERS: ReadonlyArray<{ box: Box; team: 0 | 1 }> = [
  { box: box([0, 1.5, -8], [FLOOR_SIZE, 3, 1]), team: 0 }, // blocks attackers from pushing north past z=-8
  { box: box([0, 1.5, 8], [FLOOR_SIZE, 3, 1]), team: 1 }, // blocks defenders from pushing south past z=8
];
