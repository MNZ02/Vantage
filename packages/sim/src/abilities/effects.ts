// Pure, server-called "effect on players" mutators — the ability-side
// counterpart to damage.ts's applyDamage/applyTag: same clone-in/clone-out
// shape, same rule (never called from inside tick(), only by the server
// between ticks in reaction to an AbilityEvent). Also holds agent selection
// and the flash/reveal geometry queries, which are pure computations over
// SimState + boxes but don't mutate anything themselves.
//
// Flash angle-band note: `computeFlash` avoids Math.acos (banned-adjacent —
// see math.ts's determinism rationale for why inverse-trig is avoided
// wherever a dot-product threshold comparison does the same job) by
// comparing the view/detonation dot product directly against cos(45deg) and
// cos(90deg)=0, rather than computing the angle itself.

import {
  ABILITY_SLOT_ULT,
  AGENT_NONE,
  ENT_WALL_BOX,
  FLASH_FULL,
  FLASH_HALF,
  FLASH_NONE,
  MAX_ABILITY_ENTITIES,
  MODE_MATCH,
  NUM_AGENTS,
  PHASE_WAITING,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  TEAM_NONE,
} from "../constants.js";
import { clamp } from "../math.js";
import { eyePosition, raycastBoxes, raycastSpheres, viewDirection, type SphereLike } from "../raycast.js";
import { cloneState, type Box, type SimState } from "../state.js";
import { removeEntity, wallBoxFromEntity } from "./entities.js";
import { abilityIdForSlot, getAbilityDef } from "./data.js";

const COS_45 = 0.7071067811865476;

/** Linear AoE falloff: `centerDamage` at dist 0, down to 1 at `falloffRadius`, 0 beyond. Used for Sonar's Shock Dart. Pure. */
export function computeAoeDamage(centerDamage: number, falloffRadius: number, dist: number): number {
  if (dist > falloffRadius) return 0;
  if (falloffRadius <= 0) return dist <= 0 ? centerDamage : 0;
  const t = dist / falloffRadius;
  return centerDamage - (centerDamage - 1) * t;
}

export interface FlashResult {
  readonly playerIndex: number;
  readonly intensity: number; // FLASH_HALF | FLASH_FULL
}

/**
 * Players flashed by a detonation at (detX, detY, detZ): within 30m, with an
 * unobstructed LoS to the point (smokes/walls occlude via `boxes`, which the
 * caller should include live wall-box entities in), bucketed by view angle
 * to the point: <45deg full, 45-90deg half, >90deg (behind) none. Applies to
 * EVERY living player regardless of team (flash is FF-independent per spec —
 * it affects teammates too). Pure query, no mutation.
 */
export function computeFlash(
  state: SimState,
  boxes: readonly Box[],
  detX: number,
  detY: number,
  detZ: number,
  smokeSpheres: readonly SphereLike[] = [],
): FlashResult[] {
  const out: FlashResult[] = [];
  for (let i = 0; i < state.numPlayers; i++) {
    if (state.alive[i] === 0) continue;
    const eye = eyePosition(state, i);
    const dx = detX - eye.x;
    const dy = detY - eye.y;
    const dz = detZ - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > 30) continue;

    let toDetX = 0;
    let toDetY = 0;
    let toDetZ = 1;
    if (dist > 1e-6) {
      toDetX = dx / dist;
      toDetY = dy / dist;
      toDetZ = dz / dist;
      const blocked = raycastBoxes(boxes, eye, { x: toDetX, y: toDetY, z: toDetZ }, dist);
      const smokeBlocked = raycastSpheres(smokeSpheres, eye, { x: toDetX, y: toDetY, z: toDetZ }, dist);
      if (blocked !== null || smokeBlocked !== null) continue;
    }

    const view = viewDirection(state.yaw[i]!, state.pitch[i]!);
    const dot = clamp(view.x * toDetX + view.y * toDetY + view.z * toDetZ, -1, 1);
    if (dot >= COS_45) out.push({ playerIndex: i, intensity: FLASH_FULL });
    else if (dot >= 0) out.push({ playerIndex: i, intensity: FLASH_HALF });
    // else: behind — no flash
  }
  return out;
}

/** Sets a player's flash debuff. Pure. `nowTick` is the current sim tick (server's authoritative state.tick at resolution time). */
export function applyFlash(state: SimState, playerIndex: number, intensity: number, nowTick: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 0) return next;
  const durationTicks = intensity === FLASH_FULL ? 128 : intensity === FLASH_HALF ? 51 : 0;
  if (durationTicks <= 0) {
    next.flashIntensity[playerIndex] = FLASH_NONE;
    return next;
  }
  next.flashedUntilTick[playerIndex] = nowTick + durationTicks;
  next.flashIntensity[playerIndex] = intensity;
  return next;
}

/** Enemies of `viewerTeam` within `radius` of (originX/Y/Z), optionally LoS-gated, as a bitmask (bit i = player i revealed). Pure query. */
export function computeReveal(
  state: SimState,
  boxes: readonly Box[],
  viewerTeam: number,
  originX: number,
  originY: number,
  originZ: number,
  radius: number,
  requireLoS: boolean,
  smokeSpheres: readonly SphereLike[] = [],
): number {
  if (viewerTeam !== TEAM_ATTACKERS && viewerTeam !== TEAM_DEFENDERS) return 0;
  const enemyTeam = viewerTeam === TEAM_ATTACKERS ? TEAM_DEFENDERS : TEAM_ATTACKERS;
  let mask = 0;
  for (let i = 0; i < state.numPlayers; i++) {
    if (state.alive[i] === 0 || state.team[i] !== enemyTeam) continue;
    const dx = state.posX[i]! - originX;
    const dy = state.posY[i]! - originY;
    const dz = state.posZ[i]! - originZ;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > radius) continue;
    if (requireLoS && dist > 1e-6) {
      const blocked = raycastBoxes(boxes, { x: originX, y: originY, z: originZ }, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
      const smokeBlocked = raycastSpheres(smokeSpheres, { x: originX, y: originY, z: originZ }, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
      if (blocked !== null || smokeBlocked !== null) continue;
    }
    mask |= 1 << i;
  }
  return mask;
}

/** Heals `playerIndex` by `amount` HP, capped at 100. No-op if dead. Pure. */
export function applyHeal(state: SimState, playerIndex: number, amount: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 0) return next;
  next.health[playerIndex] = Math.min(100, next.health[playerIndex]! + amount);
  return next;
}

/**
 * Revives a dead player in place (their frozen death position + kept
 * weapons — dead players never move, see tick.ts) with `hp` health. No-op if
 * already alive. Pure.
 *
 * Ordering (documented, see spec's "hairiest ability under lag comp"):
 * the server must resolve a round's ShotEvents (damage/kills) BEFORE its
 * AbilityEvents (including a same-tick revive) within one step() call — see
 * @vg/server serverHost.ts. Because elimination is itself only ever detected
 * ONE TICK LATER (advanceMatchState reads `alive` as of the START of the
 * NEXT tick() call, not anything resolved after the current tick() already
 * returned — the same one-tick lag that ordinary kills already have), a
 * revive resolved in reaction to a kill from the SAME server step() always
 * lands before the next tick's win-check runs, keeping the round alive. A
 * revive that resolves in a LATER step() than the round-ending kill is
 * simply too late — the round has already ended by then, matching Valorant
 * (you can't res through an already-called round).
 */
export function applyRevive(state: SimState, playerIndex: number, hp: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 1) return next;
  next.alive[playerIndex] = 1;
  next.health[playerIndex] = hp;
  next.respawnTick[playerIndex] = -1;
  return next;
}

/** Applies `damage` to a live wall-box entity, removing it at/below 0 HP. Pure. No-op if the slot isn't a live wall box. */
export function applyWallDamage(state: SimState, entitySlot: number, damage: number): SimState {
  const next = cloneState(state);
  if (next.entType[entitySlot] !== ENT_WALL_BOX) return next;
  const hp = next.entParam[entitySlot]! - damage;
  if (hp <= 0) {
    removeEntity(next, entitySlot);
  } else {
    next.entParam[entitySlot] = hp;
  }
  return next;
}

/** Nearest live wall box a ray hits (if any) within maxDist, alongside its entity slot — for the server's shot-vs-wall-before-player resolution order. */
export function raycastWalls(state: SimState, origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, maxDist: number): { slot: number; dist: number } | null {
  let best: { slot: number; dist: number } | null = null;
  for (let i = 0; i < MAX_ABILITY_ENTITIES; i++) {
    if (state.entType[i] !== ENT_WALL_BOX) continue;
    const box = wallBoxFromEntity(state, i);
    const hit = raycastBoxes([box], origin, dir, maxDist);
    if (hit !== null && (best === null || hit < best.dist)) best = { slot: i, dist: hit };
  }
  return best;
}

/**
 * Assigns `agentId` to `playerIndex`. Pure. Match mode: only during
 * PHASE_WAITING, and rejects a pick that duplicates another player's CURRENT
 * pick on the SAME team (cross-team duplicates are fine — spec). DM mode has
 * no waiting phase concept, so picks are allowed anytime (documented
 * simplification — DM is a sandbox, not a competitive match). No-op
 * (unchanged clone) if `agentId` is out of range or the gating fails.
 */
export function selectAgent(state: SimState, playerIndex: number, agentId: number): SimState {
  const next = cloneState(state);
  if (agentId < 0 || agentId >= NUM_AGENTS) return next;
  if (next.mode === MODE_MATCH && next.matchPhase !== PHASE_WAITING) return next;

  const team = next.team[playerIndex];
  if (team === TEAM_ATTACKERS || team === TEAM_DEFENDERS) {
    for (let i = 0; i < next.numPlayers; i++) {
      if (i === playerIndex) continue;
      if (next.team[i] === team && next.agentId[i] === agentId) return next; // duplicate within team
    }
  }
  next.agentId[playerIndex] = agentId;
  return next;
}

/**
 * Fills every player with AGENT_NONE with the lowest agentId not already
 * taken by a teammate (DM: lowest not taken by ANYONE, since DM has no
 * teams). Pure. Called once at match start (mirrors startMatch()'s team
 * assignment) and by DM server init.
 */
export function autoAssignAgents(state: SimState): SimState {
  const next = cloneState(state);
  const takenByTeam = new Map<number, Set<number>>();
  for (let i = 0; i < next.numPlayers; i++) {
    if (next.agentId[i] === AGENT_NONE) continue;
    const key = next.team[i] === TEAM_ATTACKERS || next.team[i] === TEAM_DEFENDERS ? next.team[i]! : TEAM_NONE;
    if (!takenByTeam.has(key)) takenByTeam.set(key, new Set());
    takenByTeam.get(key)!.add(next.agentId[i]!);
  }
  for (let i = 0; i < next.numPlayers; i++) {
    if (next.agentId[i] !== AGENT_NONE) continue;
    const key = next.team[i] === TEAM_ATTACKERS || next.team[i] === TEAM_DEFENDERS ? next.team[i]! : TEAM_NONE;
    if (!takenByTeam.has(key)) takenByTeam.set(key, new Set());
    const taken = takenByTeam.get(key)!;
    let pick = 0;
    while (taken.has(pick) && pick < NUM_AGENTS) pick++;
    if (pick >= NUM_AGENTS) pick = 0; // more players than agents on one side: allow duplicates rather than leave unpicked
    next.agentId[i] = pick;
    taken.add(pick);
  }
  return next;
}

/**
 * Kill-driven ability bookkeeping the server applies alongside the existing
 * kill-reward/killfeed handling (see @vg/server serverHost.ts handleKill):
 * Zephyr's Dash re-earns a charge every 2 kills; Blades' charges refill to
 * max on any kill while active. Rail does NOT refill on kill (spec: only
 * Blades does — Rail's 3-shot/15s activation window is a hard cap) — gated
 * by the ult-weapon's own `refreshOnKill` data flag rather than hardcoding
 * an ability id here, so this stays correct if a future ult weapon is added.
 * Ult points themselves are awarded by the caller via abilities/logic.ts's
 * awardUltPoint (kill + death + plant + defuse + orb, all capped at
 * ultCost) — kept separate since those apply uniformly to every agent, not
 * just Zephyr.
 */
export function applyKillAbilitySideEffects(state: SimState, killerIndex: number): SimState {
  const next = cloneState(state);
  if (next.activeSlot[killerIndex] === 2) {
    const agentId = next.agentId[killerIndex]!;
    const ultAbilityId = agentId !== AGENT_NONE ? abilityIdForSlot(agentId, ABILITY_SLOT_ULT) : null;
    const def = ultAbilityId !== null ? getAbilityDef(ultAbilityId) : null;
    if (def?.count && def.refreshOnKill) next.magUlt[killerIndex] = def.count;
  }

  const agentId = next.agentId[killerIndex]!;
  if (agentId !== AGENT_NONE) {
    const dashAbilityId = abilityIdForSlot(agentId, 2 /* ABILITY_SLOT_SIGNATURE */);
    const dashDef = dashAbilityId !== null ? getAbilityDef(dashAbilityId) : null;
    if (dashDef?.killsToRefresh) {
      const count = next.dashKillCounter[killerIndex]! + 1;
      if (count >= dashDef.killsToRefresh) {
        const idx = killerIndex * 4 + 2;
        next.abilityCharges[idx] = Math.min(dashDef.maxCharges, next.abilityCharges[idx]! + 1);
        next.dashKillCounter[killerIndex] = 0;
      } else {
        next.dashKillCounter[killerIndex] = count;
      }
    }
  }
  return next;
}
