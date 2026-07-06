// Shared level geometry: the single source of truth for collision boxes and
// spawn points, consumed by both @vg/client (rendering + local prediction)
// and @vg/server (authoritative sim) so they can never drift apart. Kept in
// @vg/sim rather than a separate @vg/levels package: sim already owns the
// `Box` type, this data is plain and tiny, and it lets the server depend on
// just @vg/sim instead of another workspace package.
//
// Client-only concerns (render color, mesh materials) stay in
// packages/client/src/graybox.ts, which imports LEVEL_BOXES plus the index
// ranges exported below and zips each entry with a material by index.
//
// ---- "Crossing" v2 layout (72 × 72 m, +Z north) ----
//
// 3-lane tactical layout, Valorant-scale: attackers spawn deep south,
// defenders deep north, two plant sites in the NW (A) and NE (B) corners, a
// mid courtyard between them, and 3 south-to-north lanes (A main / mid /
// B main) with a cross-lane link cutting through both lane dividers.
//
//   z=+36 ┌────────────────────────────────────────┐
//         │            DEFENDER SPAWN              │
//   z=+28 ├─══─────────────══─────────────══───────┤  north wall (3 gaps, def. barriers)
//         │  A SITE   │   mid       │   B SITE     │
//         │  (heaven  ══  courtyard ══  (default   │  site inner walls x=±10 (A/B links)
//         │  + plant) │             │   + plant)   │
//   z=+8  ├──══───────────══────────────══─────────┤  site line (A main / mid doors / B main)
//         │  A MAIN   │    MID      │   B MAIN     │
//         │           ══ (half-wall ══             │  lane dividers x=±12 (cross link)
//         │           │   + boxes)  │              │
//   z=-24 ├─══─────────────══─────────────══───────┤  south wall (3 gaps, atk. barriers)
//         │            ATTACKER SPAWN              │
//   z=-36 └────────────────────────────────────────┘
//
// (══ marks a walkable gap/choke; │ marks a lane-divider wall.)

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

const FLOOR_SIZE = 72;
const HALF = FLOOR_SIZE / 2;
const WALL_HEIGHT = 3;
const THICK = 0.5;

/** Half-extent of the walkable world, meters — the minimap and any other world→2D mapping scale from this. */
export const LEVEL_HALF_EXTENT = HALF;

// Key z-lines (referenced by walls, barriers, zones, and client dressing alike).
export const SOUTH_WALL_Z = -24; // attacker spawn boundary
export const SITE_LINE_Z = 8; // south edge of both sites / the mid courtyard
export const NORTH_WALL_Z = 28; // defender spawn boundary

/** A wall segment running east-west (constant z) spanning [x0, x1]. */
function wallEW(x0: number, x1: number, z: number): Box {
  return box([(x0 + x1) / 2, WALL_HEIGHT / 2, z], [x1 - x0, WALL_HEIGHT, THICK]);
}

/** A wall segment running north-south (constant x) spanning [z0, z1]. */
function wallNS(x: number, z0: number, z1: number): Box {
  return box([x, WALL_HEIGHT / 2, (z0 + z1) / 2], [THICK, WALL_HEIGHT, z1 - z0]);
}

// ---- Assembly: boxes are pushed in named groups; the index ranges below are
// derived from the actual array (never hand-counted), so client code that
// maps index→material/prop-anchor cannot silently drift when the layout
// changes. Order within the array is stable and part of the level's identity
// (prediction replays and prop anchors reference it). ----

const boxes: Box[] = [];
/** Named indices into LEVEL_BOXES for boxes that props/dressing anchor to. */
export const LEVEL_INDEX: Record<string, number> = {};

function push(name: string, b: Box): void {
  LEVEL_INDEX[name] = boxes.length;
  boxes.push(b);
}

// -- floor + perimeter --
push("floor", box([0, -0.5, 0], [FLOOR_SIZE, 1, FLOOR_SIZE]));
export const PERIMETER_START = boxes.length;
push("perimeterSouth", wallEW(-HALF, HALF, -HALF));
push("perimeterNorth", wallEW(-HALF, HALF, HALF));
push("perimeterWest", wallNS(-HALF, -HALF, HALF));
push("perimeterEast", wallNS(HALF, -HALF, HALF));
export const PERIMETER_END = boxes.length; // exclusive

export const WALLS_START = boxes.length;
// -- south wall (attacker spawn boundary): gaps = A main x[-28,-20], mid x[-3,3], B main x[20,28] --
push("southWallWest", wallEW(-HALF, -28, SOUTH_WALL_Z));
push("southWallCenterWest", wallEW(-20, -3, SOUTH_WALL_Z));
push("southWallCenterEast", wallEW(3, 20, SOUTH_WALL_Z));
push("southWallEast", wallEW(28, HALF, SOUTH_WALL_Z));

// -- site line (z=8): gaps = A main x[-30,-20], mid doors x[-3,3], B main x[20,30] --
push("siteLineWest", wallEW(-HALF, -30, SITE_LINE_Z));
push("siteLineCenterWest", wallEW(-20, -3, SITE_LINE_Z));
push("siteLineCenterEast", wallEW(3, 20, SITE_LINE_Z));
push("siteLineEast", wallEW(30, HALF, SITE_LINE_Z));

// -- north wall (defender spawn boundary): gaps = A exit x[-26,-18], mid exit x[-3,3], B exit x[18,26] --
push("northWallWest", wallEW(-HALF, -26, NORTH_WALL_Z));
push("northWallCenterWest", wallEW(-18, -3, NORTH_WALL_Z));
push("northWallCenterEast", wallEW(3, 18, NORTH_WALL_Z));
push("northWallEast", wallEW(26, HALF, NORTH_WALL_Z));

// -- lane dividers (x=±12, between south wall and site line): cross-link gap z[-6,-1] --
push("dividerWestSouth", wallNS(-12, SOUTH_WALL_Z, -6));
push("dividerWestNorth", wallNS(-12, -1, SITE_LINE_Z));
push("dividerEastSouth", wallNS(12, SOUTH_WALL_Z, -6));
push("dividerEastNorth", wallNS(12, -1, SITE_LINE_Z));

// -- site inner walls (x=±10, between site line and north wall): link gap z[14,20] --
push("siteAInnerSouth", wallNS(-10, SITE_LINE_Z, 14));
push("siteAInnerNorth", wallNS(-10, 20, NORTH_WALL_Z));
push("siteBInnerSouth", wallNS(10, SITE_LINE_Z, 14));
push("siteBInnerNorth", wallNS(10, 20, NORTH_WALL_Z));
export const WALLS_END = boxes.length; // exclusive

// -- cover (crates/blocks/half-walls; rendered with the crate material) --
export const COVER_START = boxes.length;
// A site: double crate + stacked top near the plant zone's south edge, and a generator block.
push("siteACrateWest", box([-26, 0.6, 13], [1.2, 1.2, 1.2]));
push("siteACrateEast", box([-24.6, 0.6, 13], [1.2, 1.2, 1.2]));
push("siteACrateTop", box([-25.3, 1.8, 13], [1.2, 1.2, 1.2]));
push("siteAGenerator", box([-19, 0.75, 20], [1.6, 1.5, 1.6]));
// B site: a tall "default" block, a stacked crate pair, and a low box.
push("siteBDefault", box([22, 1, 13], [2.4, 2, 2.4]));
push("siteBCrateLow", box([28, 0.6, 21], [1.2, 1.2, 1.2]));
push("siteBCrateHigh", box([28, 1.8, 21], [1.2, 1.2, 1.2]));
push("siteBLowBox", box([17, 0.55, 17], [1.2, 1.1, 1.2]));
// Mid courtyard: central cover block (contests mid control from both spawn exits).
push("midCourtBlock", box([0, 1, 17], [5, 2, 2.5]));
// Mid lane: crouch-height half-wall (west of center — keeps the x=0 firing lane clear) + a crate.
push("midHalfWall", box([-7, 0.55, -2], [6, 1.1, 0.5]));
push("midCrate", box([6, 0.6, -8], [1.2, 1.2, 1.2]));
// Main-lane cover so the long A/B approaches aren't a single sightline.
push("aMainCrate", box([-30, 0.6, -6], [1.2, 1.2, 1.2]));
push("bMainCrate", box([30, 0.6, -6], [1.2, 1.2, 1.2]));
export const COVER_END = boxes.length; // exclusive

// -- A "heaven": stairs up the west edge of A site to a 2 m platform overlooking the plant zone --
export const STAIRS_START = boxes.length;
const STAIR_COUNT = 10;
const STAIR_HEIGHT = 0.2;
const STAIR_DEPTH = 0.8;
const STAIR_WIDTH = 4;
const STAIR_X = -34; // centered in x[-36,-32]
for (let i = 0; i < STAIR_COUNT; i++) {
  const stepTop = (i + 1) * STAIR_HEIGHT;
  const z = 10 + STAIR_DEPTH / 2 + i * STAIR_DEPTH;
  push(`heavenStep${i}`, box([STAIR_X, stepTop / 2, z], [STAIR_WIDTH, stepTop, STAIR_DEPTH]));
}
push("heavenPlatform", box([STAIR_X, 1, 23], [STAIR_WIDTH, 2, 10]));
export const STAIRS_END = boxes.length; // exclusive

/** The level's static collision geometry, in a fixed, stable order. */
export const LEVEL_BOXES: Box[] = boxes;

/** Single-player / player-0 spawn used by the M0 offline mode (attacker spawn center). */
export const SPAWN_POSITION = { x: 0, y: 0, z: -30 } as const;

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
 * Deathmatch respawn points, spread over every district of the map (spawn
 * strips, every lane, both sites, mid courtyard), each at least 1 m
 * clear of any wall/cover box. Selection at respawn time is
 * `hash(seed, playerIndex, tick) % DM_SPAWNS.length` (see weapons/logic.ts
 * respawnPlayer()) — deterministic in-sim so client prediction/replay of the
 * local player's own respawn agrees with the server bit-for-bit.
 */
export const DM_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: 0, y: 0, z: -30, yaw: 0 }, // attacker spawn center
  { x: -24, y: 0, z: -30, yaw: 0 }, // attacker spawn west
  { x: 24, y: 0, z: -30, yaw: 0 }, // attacker spawn east
  { x: -30, y: 0, z: 0, yaw: 0 }, // A main
  { x: 30, y: 0, z: 0, yaw: 0 }, // B main
  { x: 0, y: 0, z: 0, yaw: 0 }, // mid lane
  { x: -6, y: 0, z: -16, yaw: PI / 4 }, // mid lane south
  { x: -24, y: 0, z: 18, yaw: PI }, // A site plant zone
  { x: 24, y: 0, z: 18, yaw: PI }, // B site plant zone
  { x: 0, y: 0, z: 11, yaw: 0 }, // mid courtyard south
  { x: -8, y: 0, z: 32, yaw: PI }, // defender spawn west
  { x: 8, y: 0, z: 32, yaw: PI }, // defender spawn east
];

// ---- Match-mode level data ----

/** Attacker (team 0) spawn points, south strip, facing north (+Z, yaw 0). */
export const ATTACKER_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: -8, y: 0, z: -30, yaw: 0 },
  { x: -4, y: 0, z: -30, yaw: 0 },
  { x: 0, y: 0, z: -30, yaw: 0 },
  { x: 4, y: 0, z: -30, yaw: 0 },
  { x: 8, y: 0, z: -30, yaw: 0 },
];

/** Defender (team 1) spawn points, north strip, facing south (-Z, yaw PI). */
export const DEFENDER_SPAWNS: ReadonlyArray<{ x: number; y: number; z: number; yaw: number }> = [
  { x: -8, y: 0, z: 32, yaw: PI },
  { x: -4, y: 0, z: 32, yaw: PI },
  { x: 0, y: 0, z: 32, yaw: PI },
  { x: 4, y: 0, z: 32, yaw: PI },
  { x: 8, y: 0, z: 32, yaw: PI },
];

/** Plant/defuse site zones — purely logical regions (not collision), tested by point-in-box. */
export const SITE_ZONES: ReadonlyArray<{ name: "A" | "B"; box: Box }> = [
  { name: "A", box: box([-24, 1.5, 18], [10, 3, 8]) },
  { name: "B", box: box([24, 1.5, 18], [10, 3, 8]) },
];

/**
 * Buy-phase-only collision barriers, one per choke gap. `team` names which
 * team the box blocks — the OTHER team walks through it freely. All entries
 * are simply omitted from a player's effective collision list once
 * matchPhase leaves PHASE_BUY — see tick.ts's per-player effective-boxes
 * assembly. Attackers are held south of the south wall's 3 gaps;
 * defenders north of the north wall's 3.
 */
export const BARRIERS: ReadonlyArray<{ box: Box; team: 0 | 1 }> = [
  { box: box([-24, 1.5, SOUTH_WALL_Z], [8, 3, 1]), team: 0 }, // A main gap
  { box: box([0, 1.5, SOUTH_WALL_Z], [6, 3, 1]), team: 0 }, // mid gap
  { box: box([24, 1.5, SOUTH_WALL_Z], [8, 3, 1]), team: 0 }, // B main gap
  { box: box([-22, 1.5, NORTH_WALL_Z], [8, 3, 1]), team: 1 }, // A exit gap
  { box: box([0, 1.5, NORTH_WALL_Z], [6, 3, 1]), team: 1 }, // mid exit gap
  { box: box([22, 1.5, NORTH_WALL_Z], [8, 3, 1]), team: 1 }, // B exit gap
];

/**
 * M4a: fixed ult-orb pickup spots — one deep in each main lane (contestable
 * early-round grabs) and one in the mid courtyard's north half (a risky
 * defender-side grab once the round opens up). Orbs respawn at every round
 * start (see match.ts's enterBuyPhase ability-reset hook) and are removed on
 * pickup.
 */
export const ORB_SPOTS: ReadonlyArray<{ x: number; y: number; z: number }> = [
  { x: -30, y: 0, z: 2 },
  { x: 30, y: 0, z: 2 },
  { x: 0, y: 0, z: 24 },
];
