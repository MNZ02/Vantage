// Pure raycasting helpers used by the server for lag-compensated hitscan (and
// optionally by the client for cosmetic tracers). Built only from this
// package's own trig/PRNG approximations and no wall-clock access — same
// purity constraints as the rest of sim/src (see test/purity.test.ts).

import { CAPSULE_RADIUS, CROUCH_HEIGHT, EYE_HEIGHT_CROUCH, EYE_HEIGHT_STAND, STAND_HEIGHT } from "./constants.js";
import { cosApprox, sinApprox } from "./math.js";
import type { Box, SimState } from "./state.js";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** World-space eye position for a player, accounting for stand/crouch eye height. */
export function eyePosition(state: SimState, playerIndex: number): Vec3Like {
  const crouching = state.crouching[playerIndex] === 1;
  const eyeHeight = crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
  return {
    x: state.posX[playerIndex]!,
    y: state.posY[playerIndex]! + eyeHeight,
    z: state.posZ[playerIndex]!,
  };
}

/**
 * Unit view direction from yaw/pitch, matching the client's camera convention
 * (yaw=0 forward is +Z, positive pitch looks up) — derived so it agrees
 * exactly with wishDirection()'s horizontal projection (see movement.ts).
 */
export function viewDirection(yaw: number, pitch: number): Vec3Like {
  const cp = cosApprox(pitch);
  return {
    x: sinApprox(yaw) * cp,
    y: sinApprox(pitch),
    z: cosApprox(yaw) * cp,
  };
}

/** Ray vs. axis-aligned box, slab method. Returns entry distance or null. */
function raycastBox(box: Box, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number | null {
  let tmin = 0;
  let tmax = maxDist;

  // X slab
  if (Math.abs(dx) < 1e-12) {
    if (ox < box.minX || ox > box.maxX) return null;
  } else {
    let t1 = (box.minX - ox) / dx;
    let t2 = (box.maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  // Y slab
  if (Math.abs(dy) < 1e-12) {
    if (oy < box.minY || oy > box.maxY) return null;
  } else {
    let t1 = (box.minY - oy) / dy;
    let t2 = (box.maxY - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  // Z slab
  if (Math.abs(dz) < 1e-12) {
    if (oz < box.minZ || oz > box.maxZ) return null;
  } else {
    let t1 = (box.minZ - oz) / dz;
    let t2 = (box.maxZ - oz) / dz;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }

  if (tmax < 0 || tmin > maxDist) return null;
  return tmin;
}

/** Nearest distance to any box the ray hits within maxDist, or null if none. */
export function raycastBoxes(
  boxes: readonly Box[],
  origin: Vec3Like,
  dir: Vec3Like,
  maxDist: number,
): number | null {
  let best: number | null = null;
  for (const box of boxes) {
    const hit = raycastBox(box, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
    if (hit !== null && (best === null || hit < best)) best = hit;
  }
  return best;
}

/** Ray vs. sphere. Returns nearest non-negative entry distance <= maxDist, or null. */
function raycastSphere(
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number | null {
  const lx = ox - cx;
  const ly = oy - cy;
  const lz = oz - cz;
  const b = lx * dx + ly * dy + lz * dz;
  const c = lx * lx + ly * ly + lz * lz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  if (t < 0 || t > maxDist) return null;
  return t;
}

/**
 * Ray vs. one player's collision volume: a vertical capsule approximated as a
 * cylinder (radius CAPSULE_RADIUS) capped by two hemispheres, decomposed into
 * an infinite-cylinder test clipped to the cylindrical span plus two sphere
 * caps — together they reconstruct the exact capsule surface.
 */
function raycastCapsule(
  cx: number,
  feetY: number,
  cz: number,
  height: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDist: number,
): number | null {
  const radius = CAPSULE_RADIUS;
  const yBot = feetY + radius;
  const yTop = feetY + height - radius;

  let best: number | null = null;

  // Infinite vertical cylinder, entry accepted only within [yBot, yTop].
  const a = dx * dx + dz * dz;
  if (a > 1e-12) {
    const b = 2 * (dx * (ox - cx) + dz * (oz - cz));
    const c = (ox - cx) * (ox - cx) + (oz - cz) * (oz - cz) - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const candidates = [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
      for (const t of candidates) {
        if (t < 0 || t > maxDist) continue;
        const y = oy + t * dy;
        if (y >= yBot && y <= yTop) {
          if (best === null || t < best) best = t;
        }
      }
    }
  }

  // Bottom and top hemisphere caps.
  const bottom = raycastSphere(cx, yBot, cz, radius, ox, oy, oz, dx, dy, dz, maxDist);
  if (bottom !== null) {
    const y = oy + bottom * dy;
    if (y <= yBot + 1e-9 && (best === null || bottom < best)) best = bottom;
  }
  const top = raycastSphere(cx, yTop, cz, radius, ox, oy, oz, dx, dy, dz, maxDist);
  if (top !== null) {
    const y = oy + top * dy;
    if (y >= yTop - 1e-9 && (best === null || top < best)) best = top;
  }

  return best;
}

export interface PlayerHit {
  playerIndex: number;
  dist: number;
}

/** Nearest player (excluding the shooter) the ray hits within maxDist, or null. */
export function raycastPlayers(
  state: SimState,
  shooterIndex: number,
  origin: Vec3Like,
  dir: Vec3Like,
  maxDist: number,
): PlayerHit | null {
  let best: PlayerHit | null = null;
  for (let i = 0; i < state.numPlayers; i++) {
    if (i === shooterIndex) continue;
    const height = state.crouching[i] === 1 ? CROUCH_HEIGHT : STAND_HEIGHT;
    const hit = raycastCapsule(
      state.posX[i]!,
      state.posY[i]!,
      state.posZ[i]!,
      height,
      origin.x,
      origin.y,
      origin.z,
      dir.x,
      dir.y,
      dir.z,
      maxDist,
    );
    if (hit !== null && (best === null || hit < best.dist)) {
      best = { playerIndex: i, dist: hit };
    }
  }
  return best;
}
