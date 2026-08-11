// Per-tick ability cast handling + world-entity stepping. Runs INSIDE tick()
// (see tick.ts) so casts, projectile flight, self-mobility (updraft/dash/
// step), and smoke/wall/zone/recon-dart lifetimes are all predicted exactly
// by the owning client (PLAN §3.2's ability prediction policy). Detonation
// EFFECTS ON PLAYERS (damage/flash/slow/reveal/heal/res) are NOT applied
// here — stepAbilities only emits AbilityEvents describing what happened
// in-world; the server resolves those events against authoritative state via
// abilities/effects.ts's pure helpers, between ticks, exactly like ShotEvents
// feed damage.ts today.
//
// Deliberate, documented exception: Lumen's slow zones are resolved to a
// speed MULTIPLIER directly here (see computeSlowMultiplier, called from
// tick.ts alongside tag/ADS), not through a server round trip. Reasoning: a
// zone's existence/position/lifetime is itself an in-sim, fully-predicted
// entity (identical on every client), and "am I standing inside it" is
// self-referential — a player always knows their own true position, unlike
// flash/heal/reveal/damage/res which depend on OTHER players' authoritative
// state (lag-compensated hit tests, true LoS from another entity's position,
// etc.). Treating slow specially avoids reintroducing exactly the netcode
// latency the ability prediction policy exists to mask, for the one effect
// that doesn't actually need server mediation to stay honest.

import {
  ABILITY_SLOT_BASIC1,
  ABILITY_SLOT_BASIC2,
  ABILITY_SLOT_SIGNATURE,
  ABILITY_SLOT_ULT,
  AGENT_NONE,
  CROUCH_HEIGHT,
  ENT_NONE,
  ENT_PROJECTILE,
  ENT_RECON_DART,
  ENT_SLOW_ZONE,
  ENT_SMOKE,
  ENT_ULT_ORB,
  ENT_WALL_BOX,
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_STAND,
  FIXED_DT,
  GRAVITY,
  MAX_ABILITY_ENTITIES,
  MODE_MATCH,
  NO_PLAYER,
  PHASE_ROUND,
  STAND_HEIGHT,
  ULT_ORB_PICKUP_RADIUS_M,
  WALL_BOX_MAX_HP,
} from "../constants.js";
import { cosApprox, sinApprox } from "../math.js";
import { findFloorBelow, sweepCapsule } from "../movement.js";
import { raycastBoxes, raycastPlayers, viewDirection } from "../raycast.js";
import { cloneState, type AbilityEvent, type Box, type InputFrame, type SimState } from "../state.js";
import { removeEntity, spawnEntity } from "./entities.js";
import {
  ABL_LUMEN_MEND,
  ABL_LUMEN_RES,
  ABL_LUMEN_SLOW,
  ABL_LUMEN_WALL,
  ABL_SONAR_PULSE,
  ABL_SONAR_RAIL,
  ABL_SONAR_RECON,
  ABL_SONAR_SHOCK,
  ABL_UMBRA_BLIND,
  ABL_UMBRA_SHROUD,
  ABL_UMBRA_STEP,
  ABL_UMBRA_VEIL,
  ABL_ZEPHYR_BLADES,
  ABL_ZEPHYR_DASH,
  ABL_ZEPHYR_GUST,
  ABL_ZEPHYR_UPDRAFT,
  abilityIdForSlot,
  getAbilityDef,
} from "./data.js";

const NO_PENDING = 255;

/** Distance a landed projectile backs off from the exact surface it hit (see stepEntities' collision resolution doc comment). */
const LANDING_EPSILON_M = 0.15;

const ABILITY1_BIT = 1 << 0;
const ABILITY2_BIT = 1 << 1;
const SIGNATURE_BIT = 1 << 2;
const ULT_BIT = 1 << 3;

function encodeAbilityButtons(input: Pick<InputFrame, "ability1" | "ability2" | "signature" | "ult">): number {
  return (
    (input.ability1 ? ABILITY1_BIT : 0) |
    (input.ability2 ? ABILITY2_BIT : 0) |
    (input.signature ? SIGNATURE_BIT : 0) |
    (input.ult ? ULT_BIT : 0)
  );
}

function heldLast(prevButtons: number, bit: number): boolean {
  return (prevButtons & bit) !== 0;
}

/** Combined speed multiplier from every live slow zone `playerIndex` is currently standing inside (radius test), floored at 0.3 (multiplicative stacking, per spec). 1 if not in any zone. */
export function computeSlowMultiplier(state: SimState, playerIndex: number): number {
  let mult = 1;
  const x = state.posX[playerIndex]!;
  const z = state.posZ[playerIndex]!;
  for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) {
    if (state.entType[e] !== ENT_SLOW_ZONE) continue;
    const dx = x - state.entX[e]!;
    const dz = z - state.entZ[e]!;
    const def = getAbilityDef(state.entAbilityId[e]!);
    const r = def?.radius ?? 4;
    if (dx * dx + dz * dz <= r * r) mult *= 0.5;
  }
  return Math.max(0.3, mult);
}

function findNearestDeadTeammate(state: SimState, casterIndex: number, rangeM: number): number {
  const team = state.team[casterIndex];
  const cx = state.posX[casterIndex]!;
  const cz = state.posZ[casterIndex]!;
  let best = NO_PLAYER;
  let bestDist = Infinity;
  for (let i = 0; i < state.numPlayers; i++) {
    if (i === casterIndex) continue;
    if (state.team[i] !== team) continue;
    if (state.alive[i] !== 0) continue; // must be dead
    const dx = state.posX[i]! - cx;
    const dz = state.posZ[i]! - cz;
    const dy = state.posY[i]! - state.posY[casterIndex]!;
    const dist = Math.hypot(dx, dy, dz);
    if (dist <= rangeM && dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}

function chargeIndex(playerIndex: number, slot: number): number {
  return playerIndex * 4 + slot;
}

/** Applies an ability-charge purchase (BuyCmd itemId 100/101 -> ABILITY_SLOT_BASIC1/BASIC2), granting +1 charge up to the caster's agent's maxCharges for that slot. No-op (unchanged) if no agent picked, dead, insufficient credits, already at max, or the slot has no purchasable ability. Pure. */
export function applyAbilityBuy(state: SimState, playerIndex: number, slot: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 0) return next;
  const agentId = next.agentId[playerIndex]!;
  if (agentId === AGENT_NONE) return next;
  const abilityId = abilityIdForSlot(agentId, slot);
  if (abilityId === null) return next;
  const def = getAbilityDef(abilityId);
  if (!def || def.price <= 0) return next;
  const idx = chargeIndex(playerIndex, slot);
  if (next.abilityCharges[idx]! >= def.maxCharges) return next;
  if (next.credits[playerIndex]! < def.price) return next;
  next.credits[playerIndex] = next.credits[playerIndex]! - def.price;
  next.abilityCharges[idx] = next.abilityCharges[idx]! + 1;
  return next;
}

function wishDirFromInput(input: InputFrame): { x: number; z: number } {
  const fx = sinApprox(input.yaw);
  const fz = cosApprox(input.yaw);
  // right = forward x up in this right-handed Y-up world; must match
  // movement.ts's wishDirection() exactly (see 055434f: input.right=+1 moves
  // screen-right, matching the camera's rotation.y = yaw + PI convention) —
  // Zephyr's Dash decomposes forward/right the same way ordinary movement
  // does, so a strafing dash must travel the same direction strafing alone
  // would.
  const rx = -cosApprox(input.yaw);
  const rz = sinApprox(input.yaw);
  let x = fx * input.forward + rx * input.right;
  let z = fz * input.forward + rz * input.right;
  const len = Math.hypot(x, z);
  if (len > 1e-6) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

function resolveAbilityEffect(
  prev: SimState,
  next: SimState,
  i: number,
  abilityId: number,
  originX: number,
  originY: number,
  originZ: number,
  yaw: number,
  input: InputFrame,
  targetIndex: number,
  currentTick: number,
  boxes: readonly Box[],
  events: AbilityEvent[],
): void {
  const def = getAbilityDef(abilityId);
  if (!def) return;
  const emit = (kind: AbilityEvent["kind"], x: number, y: number, z: number, entitySlot = -1): void => {
    events.push({ kind, owner: i, abilityId, x, y, z, entitySlot });
  };

  switch (abilityId) {
    case ABL_ZEPHYR_UPDRAFT: {
      next.velY[i] = def.distance!;
      next.grounded[i] = 0;
      emit("cast", originX, originY, originZ);
      break;
    }
    case ABL_ZEPHYR_GUST:
    case ABL_UMBRA_BLIND:
    case ABL_SONAR_SHOCK:
    case ABL_UMBRA_SHROUD:
    case ABL_SONAR_RECON:
    case ABL_LUMEN_SLOW: {
      const proj = def.projectile!;
      const dir = viewDirection(yaw, input.pitch);
      const launchX = originX;
      const launchY = originY + 1.4;
      const launchZ = originZ;
      spawnEntity(next, {
        entType: ENT_PROJECTILE,
        owner: i,
        abilityId,
        x: launchX,
        y: launchY,
        z: launchZ,
        velX: dir.x * proj.speed,
        velY: dir.y * proj.speed,
        velZ: dir.z * proj.speed,
        spawnTick: currentTick,
        endTick: currentTick + proj.maxFlightTicks,
        param: 0,
      });
      emit("cast", launchX, launchY, launchZ);
      break;
    }
    case ABL_ZEPHYR_DASH: {
      const wish = wishDirFromInput(input);
      let dirX = wish.x;
      let dirZ = wish.z;
      if (Math.hypot(dirX, dirZ) < 1e-6) {
        dirX = sinApprox(yaw);
        dirZ = cosApprox(yaw);
      }
      const height = input.crouch ? CROUCH_HEIGHT : STAND_HEIGHT;
      const swept = sweepCapsule(originX, originZ, next.posY[i]!, height, dirX, dirZ, def.distance!, boxes);
      next.posX[i] = swept.x;
      next.posZ[i] = swept.z;
      next.velX[i] = 0;
      next.velZ[i] = 0;
      emit("cast", swept.x, next.posY[i]!, swept.z);
      break;
    }
    case ABL_ZEPHYR_BLADES: {
      next.activeSlot[i] = 2;
      next.magUlt[i] = def.count!;
      next.reloadEndTick[i] = -1;
      next.equipEndTick[i] = -1;
      emit("cast", originX, originY, originZ);
      break;
    }
    case ABL_UMBRA_STEP: {
      const dirX = sinApprox(yaw);
      const dirZ = cosApprox(yaw);
      const probeY = originY + 1;
      const hit = raycastBoxes(boxes, { x: originX, y: probeY, z: originZ }, { x: dirX, y: 0, z: dirZ }, def.distance!);
      const dist = hit !== null ? Math.max(0, hit - 0.5) : def.distance!;
      const tx = originX + dirX * dist;
      const tz = originZ + dirZ * dist;
      const floorY = findFloorBelow(tx, tz, originY + 3, boxes) ?? originY;
      next.posX[i] = tx;
      next.posY[i] = floorY;
      next.posZ[i] = tz;
      next.velX[i] = 0;
      next.velY[i] = 0;
      next.velZ[i] = 0;
      next.grounded[i] = 1;
      emit("detonate", tx, floorY, tz);
      break;
    }
    case ABL_UMBRA_VEIL: {
      const fx = sinApprox(yaw);
      const fz = cosApprox(yaw);
      const rx = cosApprox(yaw);
      const rz = -sinApprox(yaw);
      const midX = originX + fx * def.distance!;
      const midZ = originZ + fz * def.distance!;
      const spacing = def.radius! * 1.8;
      for (let k = -2; k <= 2; k++) {
        const sx = midX + rx * spacing * k;
        const sz = midZ + rz * spacing * k;
        spawnEntity(next, {
          entType: ENT_SMOKE,
          owner: i,
          abilityId,
          x: sx,
          y: originY,
          z: sz,
          spawnTick: currentTick,
          endTick: currentTick + def.durationTicks!,
          param: 0,
        });
      }
      emit("detonate", midX, originY, midZ);
      break;
    }
    case ABL_SONAR_PULSE: {
      emit("cast", originX, originY, originZ);
      break;
    }
    case ABL_SONAR_RAIL: {
      next.activeSlot[i] = 2;
      next.magUlt[i] = def.count!;
      next.ultWindowEndTick[i] = currentTick + def.durationTicks!;
      next.reloadEndTick[i] = -1;
      next.equipEndTick[i] = -1;
      emit("cast", originX, originY, originZ);
      break;
    }
    case ABL_LUMEN_WALL: {
      const fx = sinApprox(yaw);
      const fz = cosApprox(yaw);
      const alignX = Math.abs(cosApprox(yaw)) >= Math.abs(sinApprox(yaw));
      const cx = originX + fx * def.distance!;
      const cz = originZ + fz * def.distance!;
      const cy = originY + 1;
      const seg = 2;
      for (let k = -1; k <= 1; k++) {
        const ox = alignX ? k * seg : 0;
        const oz = alignX ? 0 : k * seg;
        spawnEntity(next, {
          entType: ENT_WALL_BOX,
          owner: i,
          abilityId,
          x: cx + ox,
          y: cy,
          z: cz + oz,
          velX: alignX ? 1 : 0,
          velZ: alignX ? 0 : 1,
          spawnTick: currentTick,
          endTick: currentTick + def.durationTicks!,
          param: WALL_BOX_MAX_HP,
        });
      }
      emit("detonate", cx, cy, cz);
      break;
    }
    case ABL_LUMEN_MEND: {
      const team = prev.team[i];
      const eyeHeight = input.crouch ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
      const eye = { x: originX, y: originY + eyeHeight, z: originZ };
      const dir = viewDirection(yaw, input.pitch);
      const hit = raycastPlayers(prev, i, eye, dir, def.mendRangeM!, false, (p) => prev.team[p] === team && p !== i && prev.alive[p] === 1);
      const target = hit ? hit.playerIndex : i;
      emit("cast", prev.posX[target]!, prev.posY[target]!, prev.posZ[target]!, target);
      break;
    }
    case ABL_LUMEN_RES: {
      emit("detonate", originX, originY, originZ, targetIndex);
      break;
    }
    default:
      break;
  }
}

function tryCast(
  prev: SimState,
  next: SimState,
  i: number,
  slot: number,
  input: InputFrame,
  currentTick: number,
  boxes: readonly Box[],
  events: AbilityEvent[],
): void {
  const agentId = prev.agentId[i]!;
  if (agentId === AGENT_NONE) return;
  const abilityId = abilityIdForSlot(agentId, slot);
  if (abilityId === null) return;
  const def = getAbilityDef(abilityId);
  if (!def) return;

  // Casts only during PHASE_ROUND in match mode; anytime alive in DM (spec: "buy phase allows none").
  const phaseOk = prev.mode !== MODE_MATCH || prev.matchPhase === PHASE_ROUND;
  if (!phaseOk) return;

  if (slot === ABILITY_SLOT_ULT) {
    if (prev.ultPoints[i]! < def.ultCost) return;
  } else {
    if (prev.abilityCharges[chargeIndex(i, slot)]! <= 0) return;
  }

  let targetIndex = NO_PLAYER;
  if (abilityId === ABL_LUMEN_RES) {
    targetIndex = findNearestDeadTeammate(prev, i, def.reviveRangeM!);
    if (targetIndex === NO_PLAYER) return; // no valid target: cast fizzles before spending anything
  }

  if (slot === ABILITY_SLOT_ULT) {
    next.ultPoints[i] = 0;
  } else {
    const idx = chargeIndex(i, slot);
    next.abilityCharges[idx] = prev.abilityCharges[idx]! - 1;
    if (slot === ABILITY_SLOT_SIGNATURE && def.rechargeTicks > 0 && prev.signatureRechargeEndTick[i] === -1) {
      next.signatureRechargeEndTick[i] = currentTick + def.rechargeTicks;
    }
  }

  if (def.castDelayTicks > 0) {
    next.pendingAbilityId[i] = abilityId;
    next.pendingReadyTick[i] = currentTick + def.castDelayTicks;
    next.pendingOriginX[i] = prev.posX[i]!;
    next.pendingOriginY[i] = prev.posY[i]!;
    next.pendingOriginZ[i] = prev.posZ[i]!;
    next.pendingYaw[i] = input.yaw;
    next.pendingTargetIndex[i] = targetIndex;
    return;
  }

  resolveAbilityEffect(prev, next, i, abilityId, prev.posX[i]!, prev.posY[i]!, prev.posZ[i]!, input.yaw, input, targetIndex, currentTick, boxes, events);
}

function resolvePendingIfReady(prev: SimState, next: SimState, i: number, currentTick: number, boxes: readonly Box[], events: AbilityEvent[]): void {
  const abilityId = prev.pendingAbilityId[i]!;
  if (abilityId === NO_PENDING) return;
  if (currentTick < prev.pendingReadyTick[i]!) return;

  const targetIndex = prev.pendingTargetIndex[i]!;
  // Re-validate Resurrect's target hasn't changed since cast (revived/respawned already).
  const stillValid = abilityId !== ABL_LUMEN_RES || (targetIndex !== NO_PLAYER && prev.alive[targetIndex] === 0);

  next.pendingAbilityId[i] = NO_PENDING;
  next.pendingReadyTick[i] = -1;
  next.pendingTargetIndex[i] = NO_PLAYER;

  if (!stillValid) return;

  const fakeInput: InputFrame = {
    forward: 0,
    right: 0,
    yaw: prev.pendingYaw[i]!,
    pitch: 0,
    jump: false,
    crouch: false,
    walk: false,
    fire: false,
    ads: false,
    reload: false,
    slot1: false,
    slot2: false,
    interact: false,
    ping: false,
    ability1: false,
    ability2: false,
    signature: false,
    ult: false,
  };
  resolveAbilityEffect(
    prev,
    next,
    i,
    abilityId,
    prev.pendingOriginX[i]!,
    prev.pendingOriginY[i]!,
    prev.pendingOriginZ[i]!,
    prev.pendingYaw[i]!,
    fakeInput,
    targetIndex,
    currentTick,
    boxes,
    events,
  );
}

function onProjectileLand(next: SimState, slot: number, abilityId: number, currentTick: number, events: AbilityEvent[]): void {
  const owner = next.entOwner[slot]!;
  const x = next.entX[slot]!;
  const y = next.entY[slot]!;
  const z = next.entZ[slot]!;
  const def = getAbilityDef(abilityId)!;

  switch (abilityId) {
    case ABL_ZEPHYR_GUST: {
      spawnEntity(next, { entType: ENT_SMOKE, owner, abilityId, x, y, z, spawnTick: currentTick, endTick: currentTick + def.durationTicks!, param: 0 });
      removeEntity(next, slot);
      events.push({ kind: "detonate", owner, abilityId, x, y, z, entitySlot: -1 });
      break;
    }
    case ABL_UMBRA_BLIND: {
      // Stays an (inert, zero-velocity) ENT_PROJECTILE until its fuse expires — see the per-tick step loop.
      next.entEndTick[slot] = currentTick + def.durationTicks!;
      break;
    }
    case ABL_SONAR_SHOCK: {
      events.push({ kind: "detonate", owner, abilityId, x, y, z, entitySlot: -1 });
      removeEntity(next, slot);
      break;
    }
    case ABL_UMBRA_SHROUD: {
      spawnEntity(next, { entType: ENT_SMOKE, owner, abilityId, x, y, z, spawnTick: currentTick, endTick: currentTick + def.durationTicks!, param: 0 });
      removeEntity(next, slot);
      events.push({ kind: "detonate", owner, abilityId, x, y, z, entitySlot: -1 });
      break;
    }
    case ABL_SONAR_RECON: {
      next.entType[slot] = ENT_RECON_DART;
      next.entVelX[slot] = 0;
      next.entVelY[slot] = 0;
      next.entVelZ[slot] = 0;
      next.entParam[slot] = def.count!; // pulses remaining
      next.entEndTick[slot] = currentTick + def.intervalTicks!; // first pulse due
      break;
    }
    case ABL_LUMEN_SLOW: {
      next.entType[slot] = ENT_SLOW_ZONE;
      next.entVelX[slot] = 0;
      next.entVelY[slot] = 0;
      next.entVelZ[slot] = 0;
      next.entEndTick[slot] = currentTick + def.durationTicks!;
      break;
    }
    default:
      removeEntity(next, slot);
      break;
  }
}

function stepEntities(next: SimState, boxes: readonly Box[], currentTick: number, events: AbilityEvent[]): void {
  for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) {
    const type = next.entType[e]!;
    if (type === ENT_NONE) continue;

    if (type === ENT_PROJECTILE) {
      const landed = next.entVelX[e] === 0 && next.entVelY[e] === 0 && next.entVelZ[e] === 0;
      if (landed) {
        if (next.entEndTick[e] !== -1 && currentTick >= next.entEndTick[e]!) {
          const owner = next.entOwner[e]!;
          const abilityId = next.entAbilityId[e]!;
          events.push({ kind: "detonate", owner, abilityId, x: next.entX[e]!, y: next.entY[e]!, z: next.entZ[e]!, entitySlot: -1 });
          removeEntity(next, e);
        }
        continue;
      }

      const abilityId = next.entAbilityId[e]!;
      const def = getAbilityDef(abilityId);
      const newVelY = next.entVelY[e]! - GRAVITY * FIXED_DT;
      const dx = next.entVelX[e]! * FIXED_DT;
      const dy = newVelY * FIXED_DT;
      const dz = next.entVelZ[e]! * FIXED_DT;
      const dist = Math.hypot(dx, dy, dz);

      const flightTicks = currentTick - next.entSpawnTick[e]!;
      const fuseExpired = def ? flightTicks >= def.projectile!.maxFlightTicks : true;

      if (dist > 1e-9) {
        const dirX = dx / dist;
        const dirY = dy / dist;
        const dirZ = dz / dist;
        const hit = raycastBoxes(boxes, { x: next.entX[e]!, y: next.entY[e]!, z: next.entZ[e]! }, { x: dirX, y: dirY, z: dirZ }, dist);
        if (hit !== null) {
          // Back off a hair from the exact surface (LANDING_EPSILON_M): a
          // detonation/spawn point sitting exactly ON a wall/floor boundary
          // makes computeFlash's/computeReveal's own LoS raycast treat that
          // SAME surface as occluding itself (the destination point is on
          // the box's boundary, so a ray toward it from above/beside
          // re-intersects the box at essentially the same distance) — this
          // was a real bug (flash silently never landing for floor-hit
          // orbs). Backing off also keeps smoke/wall/zone visuals from
          // clipping into the geometry they landed against.
          const landDist = Math.max(0, hit - LANDING_EPSILON_M);
          next.entX[e] = next.entX[e]! + dirX * landDist;
          next.entY[e] = next.entY[e]! + dirY * landDist;
          next.entZ[e] = next.entZ[e]! + dirZ * landDist;
          next.entVelX[e] = 0;
          next.entVelY[e] = 0;
          next.entVelZ[e] = 0;
          onProjectileLand(next, e, abilityId, currentTick, events);
          continue;
        }
      }

      if (fuseExpired) {
        next.entX[e] = next.entX[e]! + dx;
        next.entY[e] = next.entY[e]! + dy;
        next.entZ[e] = next.entZ[e]! + dz;
        next.entVelX[e] = 0;
        next.entVelY[e] = 0;
        next.entVelZ[e] = 0;
        onProjectileLand(next, e, abilityId, currentTick, events);
        continue;
      }

      next.entX[e] = next.entX[e]! + dx;
      next.entY[e] = next.entY[e]! + dy;
      next.entZ[e] = next.entZ[e]! + dz;
      next.entVelY[e] = newVelY;
      continue;
    }

    if (type === ENT_RECON_DART) {
      if (currentTick >= next.entEndTick[e]!) {
        events.push({
          kind: "pulse",
          owner: next.entOwner[e]!,
          abilityId: next.entAbilityId[e]!,
          x: next.entX[e]!,
          y: next.entY[e]!,
          z: next.entZ[e]!,
          entitySlot: e,
        });
        next.entParam[e] = next.entParam[e]! - 1;
        if (next.entParam[e]! <= 0) {
          removeEntity(next, e);
        } else {
          const def = getAbilityDef(next.entAbilityId[e]!);
          next.entEndTick[e] = currentTick + (def?.intervalTicks ?? 64);
        }
      }
      continue;
    }

    if (type === ENT_SMOKE || type === ENT_SLOW_ZONE) {
      if (next.entEndTick[e] !== -1 && currentTick >= next.entEndTick[e]!) {
        events.push({ kind: "expire", owner: next.entOwner[e]!, abilityId: next.entAbilityId[e]!, x: next.entX[e]!, y: next.entY[e]!, z: next.entZ[e]!, entitySlot: -1 });
        removeEntity(next, e);
      }
      continue;
    }

    if (type === ENT_WALL_BOX) {
      // HP-based removal (shot damage) is applied server-side directly on the
      // entity table (see @vg/server's wall-damage boundary); here we only
      // expire on lifetime or an already-broken (HP<=0) box slipping through.
      if (next.entParam[e]! <= 0 || (next.entEndTick[e] !== -1 && currentTick >= next.entEndTick[e]!)) {
        events.push({ kind: "expire", owner: next.entOwner[e]!, abilityId: next.entAbilityId[e]!, x: next.entX[e]!, y: next.entY[e]!, z: next.entZ[e]!, entitySlot: -1 });
        removeEntity(next, e);
      }
      continue;
    }
    // ENT_ULT_ORB handled by updateOrbPickups below; no per-tick lifetime.
  }
}

/** Ult-point cap: an agent's own ult ability's cost (spec: "cap at ultCost, no overflow banking"). Unpicked agents never accrue. */
function ultCostFor(state: SimState, playerIndex: number): number {
  const agentId = state.agentId[playerIndex]!;
  if (agentId === AGENT_NONE) return 0;
  const ultAbilityId = abilityIdForSlot(agentId, ABILITY_SLOT_ULT);
  if (ultAbilityId === null) return 0;
  return getAbilityDef(ultAbilityId)?.ultCost ?? 0;
}

/** Awards an ult point to `playerIndex`, capped at their own ult's cost. No-op if no agent picked. */
export function awardUltPoint(state: SimState, playerIndex: number): void {
  const cap = ultCostFor(state, playerIndex);
  if (cap <= 0) return;
  state.ultPoints[playerIndex] = Math.min(cap, state.ultPoints[playerIndex]! + 1);
}

function updateOrbPickups(prev: SimState, next: SimState): void {
  const roundOk = prev.mode !== MODE_MATCH || prev.matchPhase === PHASE_ROUND;
  if (!roundOk) return;
  for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) {
    if (next.entType[e] !== ENT_ULT_ORB) continue;
    for (let i = 0; i < next.numPlayers; i++) {
      if (next.alive[i] === 0) continue;
      const dx = next.posX[i]! - next.entX[e]!;
      const dz = next.posZ[i]! - next.entZ[e]!;
      if (dx * dx + dz * dz <= ULT_ORB_PICKUP_RADIUS_M * ULT_ORB_PICKUP_RADIUS_M) {
        awardUltPoint(next, i);
        removeEntity(next, e);
        break;
      }
    }
  }
}

/**
 * Advances all ability casting/entities by one tick. Called from tick.ts
 * AFTER the main per-player movement/weapon loop (so self-mobility casts
 * apply on top of this tick's already-computed movement). Reads `prev`
 * (pre-tick state) for gating decisions, writes into `next`. `boxes` must
 * already include live wall-box entities (see tick.ts) so projectile
 * collision and dash/step sweeps see them too.
 */
export function stepAbilities(prev: SimState, next: SimState, inputs: readonly (InputFrame | undefined)[], boxes: readonly Box[], currentTick: number): AbilityEvent[] {
  const events: AbilityEvent[] = [];

  for (let i = 0; i < next.numPlayers; i++) {
    resolvePendingIfReady(prev, next, i, currentTick, boxes, events);

    if (prev.alive[i] === 0) continue;
    const input = inputs[i];
    if (!input) continue;

    const prevButtons = prev.prevAbilityButtons[i]!;
    const ability1Edge = input.ability1 && !heldLast(prevButtons, ABILITY1_BIT);
    const ability2Edge = input.ability2 && !heldLast(prevButtons, ABILITY2_BIT);
    const signatureEdge = input.signature && !heldLast(prevButtons, SIGNATURE_BIT);
    const ultEdge = input.ult && !heldLast(prevButtons, ULT_BIT);

    if (ability1Edge) tryCast(prev, next, i, ABILITY_SLOT_BASIC1, input, currentTick, boxes, events);
    if (ability2Edge) tryCast(prev, next, i, ABILITY_SLOT_BASIC2, input, currentTick, boxes, events);
    if (signatureEdge) tryCast(prev, next, i, ABILITY_SLOT_SIGNATURE, input, currentTick, boxes, events);
    if (ultEdge) tryCast(prev, next, i, ABILITY_SLOT_ULT, input, currentTick, boxes, events);

    next.prevAbilityButtons[i] = encodeAbilityButtons(input);

    // Signature recharge: grant a charge when its timer completes, and keep
    // recharging until back at max (Umbra Shroud has 2 charges).
    const slot = ABILITY_SLOT_SIGNATURE;
    const idx = chargeIndex(i, slot);
    if (prev.signatureRechargeEndTick[i]! !== -1 && currentTick >= prev.signatureRechargeEndTick[i]!) {
      const agentId = prev.agentId[i]!;
      if (agentId !== AGENT_NONE) {
        const abilityId = abilityIdForSlot(agentId, slot);
        const def = abilityId !== null ? getAbilityDef(abilityId) : null;
        if (def) {
          next.abilityCharges[idx] = Math.min(def.maxCharges, prev.abilityCharges[idx]! + 1);
          next.signatureRechargeEndTick[i] = next.abilityCharges[idx]! < def.maxCharges ? currentTick + def.rechargeTicks : -1;
        }
      }
    }
  }

  stepEntities(next, boxes, currentTick, events);
  updateOrbPickups(prev, next);

  return events;
}
