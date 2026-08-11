// Pure helpers for the fixed-size ability world-entity table living in
// SimState (entType/entOwner/entAbilityId/entX../entVelX../entSpawnTick/
// entEndTick/entParam, all length MAX_ABILITY_ENTITIES) — projectiles,
// smokes, wall boxes, slow zones, recon darts, ult orbs. Called from
// abilities/logic.ts (cast-time spawn, per-tick projectile integration) and
// from @vg/server (wall-damage boundary, visibility/flash LoS occluders).
//
// Note on entVelX/Y/Z reuse: for a stationary ENT_WALL_BOX, these hold a
// fixed unit-ish direction vector for the box's long axis (chosen once at
// cast time, snapped to the nearest cardinal axis — see logic.ts's
// castLumenWall) rather than a velocity. Wall boxes never move, so the two
// meanings never collide for the same entity.

import { ENT_NONE, ENT_SMOKE, ENT_WALL_BOX, MAX_ABILITY_ENTITIES, NO_PLAYER } from "../constants.js";
import type { SphereLike } from "../raycast.js";
import type { Box, SimState } from "../state.js";
import { getAbilityDef } from "./data.js";

/** First free (entType === ENT_NONE) entity slot, or -1 if the table is full. */
export function findFreeEntitySlot(state: SimState): number {
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (state.entType[i] === ENT_NONE) return i;
  }
  return -1;
}

export interface SpawnEntityParams {
  entType: number;
  owner: number;
  abilityId: number;
  x: number;
  y: number;
  z: number;
  velX?: number;
  velY?: number;
  velZ?: number;
  spawnTick: number;
  endTick?: number;
  param?: number;
}

/** Writes a new entity into the first free slot of `next` (a tick-owned clone). No-op (silently drops) if the table is full — a documented soft cap, not a crash. Returns the slot index used, or -1. */
export function spawnEntity(next: SimState, p: SpawnEntityParams): number {
  const slot = findFreeEntitySlot(next);
  if (slot === -1) return -1;
  next.entType[slot] = p.entType;
  next.entOwner[slot] = p.owner;
  next.entAbilityId[slot] = p.abilityId;
  next.entX[slot] = p.x;
  next.entY[slot] = p.y;
  next.entZ[slot] = p.z;
  next.entVelX[slot] = p.velX ?? 0;
  next.entVelY[slot] = p.velY ?? 0;
  next.entVelZ[slot] = p.velZ ?? 0;
  next.entSpawnTick[slot] = p.spawnTick;
  next.entEndTick[slot] = p.endTick ?? -1;
  next.entParam[slot] = p.param ?? 0;
  return slot;
}

export function removeEntity(next: SimState, slot: number): void {
  next.entType[slot] = ENT_NONE;
  next.entOwner[slot] = NO_PLAYER;
  next.entAbilityId[slot] = 0;
  next.entX[slot] = 0;
  next.entY[slot] = 0;
  next.entZ[slot] = 0;
  next.entVelX[slot] = 0;
  next.entVelY[slot] = 0;
  next.entVelZ[slot] = 0;
  next.entSpawnTick[slot] = 0;
  next.entEndTick[slot] = -1;
  next.entParam[slot] = 0;
}

/** Clears every live ability entity (round reset). */
export function clearAllEntities(next: SimState): void {
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (next.entType[i] !== ENT_NONE) removeEntity(next, i);
  }
}

const WALL_HALF_WIDTH = 1; // 2m wide segments
const WALL_HALF_HEIGHT = 1; // 2m tall
const WALL_HALF_THICKNESS = 0.2; // 0.4m thick

/**
 * AABB for a live ENT_WALL_BOX entity. Walls are axis-aligned only (the sim's
 * collision system has no rotated-box support) — at cast time the wall's
 * long axis is snapped to whichever cardinal axis (X or Z) is more
 * perpendicular to the caster's view (see abilities/logic.ts castLumenWall),
 * a documented simplification of the spec's "perpendicular to view" wall.
 * The snapped axis direction is persisted in entVelX/entVelZ (1/0 = X-aligned
 * long axis, 0/1 = Z-aligned) since a stationary wall never uses velocity.
 */
export function wallBoxFromEntity(state: SimState, slot: number): Box {
  const cx = state.entX[slot]!;
  const cy = state.entY[slot]!;
  const cz = state.entZ[slot]!;
  const alignX = state.entVelX[slot]! !== 0; // long axis along X
  const halfX = alignX ? WALL_HALF_WIDTH : WALL_HALF_THICKNESS;
  const halfZ = alignX ? WALL_HALF_THICKNESS : WALL_HALF_WIDTH;
  return {
    minX: cx - halfX,
    maxX: cx + halfX,
    minY: cy - WALL_HALF_HEIGHT,
    maxY: cy + WALL_HALF_HEIGHT,
    minZ: cz - halfZ,
    maxZ: cz + halfZ,
  };
}

/** Every live wall-box entity's collision AABB (movement + bullets block on these for everyone). */
export function liveWallBoxes(state: SimState): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (state.entType[i] === ENT_WALL_BOX) out.push(wallBoxFromEntity(state, i));
  }
  return out;
}

/** Every live smoke as a spherical sight/flash/reveal occluder. */
export function liveSmokeSpheres(state: SimState): SphereLike[] {
  const out: SphereLike[] = [];
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (state.entType[i] !== ENT_SMOKE) continue;
    const radius = getAbilityDef(state.entAbilityId[i]!)?.radius ?? 0;
    if (radius > 0) {
      out.push({ x: state.entX[i]!, y: state.entY[i]!, z: state.entZ[i]!, radius });
    }
  }
  return out;
}

/** Live wall-box entity slot whose AABB is nearest along a hit, paired with its distance — used by both movement collision assembly and the server's shot-vs-wall resolution. Returns entity SLOT indices, not Box objects, so callers can apply damage / remove on break. */
export function liveWallEntitySlots(state: SimState): number[] {
  const out: number[] = [];
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (state.entType[i] === ENT_WALL_BOX) out.push(i);
  }
  return out;
}
