// Weapon state machine: fire gating, reload, ADS stage cycling, slot
// switching, spray/spread. Runs INSIDE tick() (see tick.ts) so the owning
// client predicts its own gunplay exactly — hit resolution/damage stay
// server-side (see damage.ts). Pure functions only: everything here reads
// `prev` (last tick's state) and writes into `next` (this tick's state,
// already cloned by tick()), never touching wall-clock/random ambient state.

import { COUNTER_STRAFE_DEADZONE, FIXED_DT, MODE_MATCH, RESPAWN_TICKS, RUN_SPEED, SPAWN_HEALTH, SPRAY_RESET_TICKS, WEAPON_NONE } from "../constants.js";
import { DM_SPAWNS } from "../levels.js";
import { PI, clamp, cosApprox, length2D, sinApprox } from "../math.js";
import { hashRandom2, hashSeed3, nextRandom } from "../prng.js";
import { viewDirection, type Vec3Like } from "../raycast.js";
import {
  ADS_BIT,
  SLOT1_BIT,
  SLOT2_BIT,
  cloneState,
  encodeEdgeButtons,
  wasButtonHeld,
  type InputFrame,
  type ShotEvent,
  type SimState,
} from "../state.js";
import { getWeaponDef, type WeaponDef } from "./data.js";

/** The weapon id currently equipped in `state`'s active slot for `playerIndex`, or WEAPON_NONE. */
export function getActiveWeaponId(state: SimState, playerIndex: number): number {
  return state.activeSlot[playerIndex] === 0 ? state.weaponPrimary[playerIndex]! : state.weaponSecondary[playerIndex]!;
}

function getActiveMag(state: SimState, playerIndex: number): number {
  return state.activeSlot[playerIndex] === 0 ? state.magPrimary[playerIndex]! : state.magSecondary[playerIndex]!;
}

function getActiveReserve(state: SimState, playerIndex: number): number {
  return state.activeSlot[playerIndex] === 0 ? state.reservePrimary[playerIndex]! : state.reserveSecondary[playerIndex]!;
}

function setActiveMag(state: SimState, playerIndex: number, value: number): void {
  if (state.activeSlot[playerIndex] === 0) state.magPrimary[playerIndex] = value;
  else state.magSecondary[playerIndex] = value;
}

function setActiveReserve(state: SimState, playerIndex: number, value: number): void {
  if (state.activeSlot[playerIndex] === 0) state.reservePrimary[playerIndex] = value;
  else state.reserveSecondary[playerIndex] = value;
}

/**
 * Weapon spread (radians) for the shot about to be fired, folding in
 * movement speed, crouch, airborne (including the post-land penalty
 * window), and ADS. Pure; reads only `state`'s arrays for `playerIndex`.
 *
 * Movement's contribution ramps linearly from 0 at COUNTER_STRAFE_DEADZONE
 * (~30% run speed) up to full at 100% run speed — below the deadzone,
 * accuracy is indistinguishable from standing still. This deadzone is what
 * makes counter-strafing (tap the opposite direction to kill momentum
 * instantly, vs. just releasing keys and coasting to a stop via friction)
 * meaningfully restore accuracy *faster* than a naive linear-from-zero
 * mapping would: without a deadzone, any nonzero residual speed keeps
 * contributing a proportional sliver of spread indefinitely as it decays.
 */
export function computeSpreadRad(weapon: WeaponDef, state: SimState, playerIndex: number): number {
  const speed = length2D(state.velX[playerIndex]!, state.velZ[playerIndex]!);
  let speedFactor = clamp(speed / RUN_SPEED, 0, 1);
  const crouching = state.crouching[playerIndex] === 1;
  const airborne = state.grounded[playerIndex] === 0;
  const landPenalty = state.landPenaltyTicksLeft[playerIndex]! > 0;
  const airborneClass = airborne || landPenalty;

  if (airborneClass) speedFactor = 1; // worst case regardless of horizontal speed (e.g. jumping straight up)

  const effectiveFactor = airborneClass
    ? 1
    : clamp((speedFactor - COUNTER_STRAFE_DEADZONE) / (1 - COUNTER_STRAFE_DEADZONE), 0, 1);

  let moveContribution = weapon.movementSpreadRad * effectiveFactor;
  if (airborneClass) moveContribution *= weapon.airSpreadMult;

  let spread = weapon.baseSpreadRad + moveContribution;
  if (crouching && !airborneClass) spread *= weapon.crouchSpreadMult;
  if (state.adsStage[playerIndex]! > 0) spread *= weapon.adsSpreadMult;
  return spread;
}

/** Deterministic random cone offset for one shot, derived from a stateless hash — never touches state.prngState. */
export function shotSpreadOffset(seed: number, playerIndex: number, shotIndex: number, spreadRad: number): { yawOff: number; pitchOff: number } {
  const { r1, r2 } = hashRandom2(seed, playerIndex, shotIndex);
  const angle = r1 * 2 * PI;
  const radius = Math.sqrt(r2) * spreadRad; // uniform over the disk, not just its boundary
  return { yawOff: cosApprox(angle) * radius, pitchOff: sinApprox(angle) * radius };
}

/**
 * Full shot direction for shot `shotIndex` fired with spray index
 * `sprayIndex`, by weapon `weapon`: view direction, rotated by the weapon's
 * fixed spray-pattern offset for this spray index, plus a random cone offset
 * bounded by the shooter's current computed spread. Pure and shared
 * byte-for-byte between server resolution and client prediction.
 */
export function shotDirection(state: SimState, playerIndex: number, weapon: WeaponDef, shotIndex: number, sprayIndex: number): Vec3Like {
  const patternIndex = Math.min(sprayIndex, weapon.sprayPattern.length - 1);
  const spray = weapon.sprayPattern[patternIndex] ?? { yaw: 0, pitch: 0 };
  const spreadRad = computeSpreadRad(weapon, state, playerIndex);
  const offset = shotSpreadOffset(state.seed, playerIndex, shotIndex, spreadRad);
  const yaw = state.yaw[playerIndex]! + spray.yaw + offset.yawOff;
  const pitch = state.pitch[playerIndex]! + spray.pitch + offset.pitchOff;
  return viewDirection(yaw, pitch);
}

function ticksForFireRate(fireRateRps: number): number {
  return Math.max(1, Math.round(1 / (fireRateRps * FIXED_DT)));
}

/**
 * Advances one player's weapon state by one tick: slot switching, reload,
 * ADS cycling, fire gating/spray bookkeeping. Reads `prev` (pre-tick state),
 * writes into `next` (already a clone with movement/tag/land-penalty for
 * this tick applied — see tick.ts). Returns a ShotEvent if this tick fired.
 * Alive-gating is the caller's responsibility (tick.ts skips dead players
 * entirely before calling this).
 */
export function stepWeaponLogic(prev: SimState, next: SimState, playerIndex: number, input: InputFrame, currentTick: number): ShotEvent | null {
  const prevButtons = prev.prevButtons[playerIndex]!;

  // ---- Slot switching (edge-triggered) ----
  const slot1Edge = input.slot1 && !wasButtonHeld(prevButtons, SLOT1_BIT);
  const slot2Edge = input.slot2 && !wasButtonHeld(prevButtons, SLOT2_BIT);
  if (slot1Edge && next.activeSlot[playerIndex] !== 0 && next.weaponPrimary[playerIndex] !== WEAPON_NONE) {
    next.activeSlot[playerIndex] = 0;
    next.reloadEndTick[playerIndex] = -1;
    const def = getWeaponDef(next.weaponPrimary[playerIndex]!);
    next.equipEndTick[playerIndex] = currentTick + (def?.equipDelayTicks ?? 0);
  } else if (slot2Edge && next.activeSlot[playerIndex] !== 1) {
    next.activeSlot[playerIndex] = 1;
    next.reloadEndTick[playerIndex] = -1;
    const def = getWeaponDef(next.weaponSecondary[playerIndex]!);
    next.equipEndTick[playerIndex] = currentTick + (def?.equipDelayTicks ?? 0);
  }

  const weaponId = getActiveWeaponId(next, playerIndex);
  const weapon = getWeaponDef(weaponId);

  // ---- ADS stage cycling (edge-triggered) ----
  const adsEdge = input.ads && !wasButtonHeld(prevButtons, ADS_BIT);
  if (adsEdge && weapon) {
    const stageCount = weapon.adsZoomStages.length + 1; // + hip-fire stage 0
    next.adsStage[playerIndex] = (next.adsStage[playerIndex]! + 1) % stageCount;
  }

  // ---- Reload ----
  const reloadEnd = next.reloadEndTick[playerIndex]!;
  if (reloadEnd !== -1 && currentTick >= reloadEnd) {
    if (weapon) {
      const mag = getActiveMag(next, playerIndex);
      const reserve = getActiveReserve(next, playerIndex);
      const need = weapon.magSize - mag;
      const moved = Math.min(need, reserve);
      setActiveMag(next, playerIndex, mag + moved);
      setActiveReserve(next, playerIndex, reserve - moved);
    }
    next.reloadEndTick[playerIndex] = -1;
  }

  if (next.reloadEndTick[playerIndex]! === -1 && input.reload && weapon) {
    const mag = getActiveMag(next, playerIndex);
    const reserve = getActiveReserve(next, playerIndex);
    if (mag < weapon.magSize && reserve > 0) {
      next.reloadEndTick[playerIndex] = currentTick + weapon.reloadTicks;
    }
  }

  // ---- Fire gating ----
  let shot: ShotEvent | null = null;
  const reloading = next.reloadEndTick[playerIndex]! !== -1;
  const equipEndBefore = next.equipEndTick[playerIndex]!;
  const equipping = equipEndBefore !== -1 && currentTick < equipEndBefore;
  if (equipEndBefore !== -1 && currentTick >= equipEndBefore) next.equipEndTick[playerIndex] = -1;

  const mag = weapon ? getActiveMag(next, playerIndex) : 0;
  const canFire = weapon !== null && input.fire && !reloading && !equipping && mag > 0 && currentTick >= next.nextFireTick[playerIndex]!;

  if (canFire && weapon) {
    setActiveMag(next, playerIndex, mag - 1);
    next.nextFireTick[playerIndex] = currentTick + ticksForFireRate(weapon.fireRateRps);
    const shotIndex = next.shotCounter[playerIndex]!;
    next.shotCounter[playerIndex] = shotIndex + 1;
    // This shot uses the spray pattern index it *entered* the tick with (the
    // first shot of a burst must land on sprayPattern[0], which is authored
    // near-zero, to satisfy first-shot accuracy) — increment only AFTER
    // capturing it, for the *next* shot to use.
    const thisShotSprayIndex = next.sprayIndex[playerIndex]!;
    next.sprayIndex[playerIndex] = Math.min(thisShotSprayIndex + 1, weapon.sprayPattern.length - 1);
    next.ticksSinceFire[playerIndex] = 0;
    shot = { playerIndex, shotIndex, sprayIndex: thisShotSprayIndex, weaponId };
  } else {
    const ticksSince = next.ticksSinceFire[playerIndex]!;
    if (ticksSince < 65535) next.ticksSinceFire[playerIndex] = ticksSince + 1;
    if (next.ticksSinceFire[playerIndex]! > SPRAY_RESET_TICKS) {
      next.sprayIndex[playerIndex] = 0;
    }
  }

  next.prevButtons[playerIndex] = encodeEdgeButtons(input);
  return shot;
}

/** DM spawn point selection: deterministic hash of (seed, playerIndex, tick), so client-predicted respawn agrees with the server. */
function pickSpawn(seed: number, playerIndex: number, tick: number): { x: number; y: number; z: number; yaw: number } {
  const h = hashSeed3(seed, playerIndex, tick);
  const r = nextRandom(h);
  const idx = Math.floor(r.value * DM_SPAWNS.length) % DM_SPAWNS.length;
  return DM_SPAWNS[idx]!;
}

/**
 * Revives a dead player in-place on `next` (already a clone): full health,
 * position at a deterministically-chosen DM spawn, refilled mags (DM
 * convenience), weapons/credits/armor kept as-is. Deterministic in-sim so
 * the owning client's own prediction/replay of its respawn agrees with the
 * server bit-for-bit.
 */
export function respawnPlayer(next: SimState, playerIndex: number, currentTick: number): void {
  const spawn = pickSpawn(next.seed, playerIndex, currentTick);
  next.alive[playerIndex] = 1;
  next.health[playerIndex] = SPAWN_HEALTH;
  next.respawnTick[playerIndex] = -1;
  next.posX[playerIndex] = spawn.x;
  next.posY[playerIndex] = spawn.y;
  next.posZ[playerIndex] = spawn.z;
  next.velX[playerIndex] = 0;
  next.velY[playerIndex] = 0;
  next.velZ[playerIndex] = 0;
  next.yaw[playerIndex] = spawn.yaw;
  next.grounded[playerIndex] = 1;
  next.tagTicksLeft[playerIndex] = 0;
  next.landPenaltyTicksLeft[playerIndex] = 0;
  next.reloadEndTick[playerIndex] = -1;
  next.equipEndTick[playerIndex] = -1;
  next.adsStage[playerIndex] = 0;

  const primaryId = next.weaponPrimary[playerIndex]!;
  if (primaryId !== WEAPON_NONE) {
    const def = getWeaponDef(primaryId);
    if (def) next.magPrimary[playerIndex] = def.magSize;
  }
  const secondaryId = next.weaponSecondary[playerIndex]!;
  if (secondaryId !== WEAPON_NONE) {
    const def = getWeaponDef(secondaryId);
    if (def) next.magSecondary[playerIndex] = def.magSize;
  }
}

/**
 * Schedules a death: called by damage.ts's applyDamage when health hits 0.
 * In match mode there is no auto-respawn — a dead player stays dead until
 * the next buy-phase transition revives everyone (see match.ts
 * enterBuyPhase), so respawnTick is left at -1 (never eligible).
 */
export function scheduleDeath(next: SimState, playerIndex: number, currentTick: number): void {
  next.alive[playerIndex] = 0;
  next.respawnTick[playerIndex] = next.mode === MODE_MATCH ? -1 : currentTick + RESPAWN_TICKS;
  next.tagTicksLeft[playerIndex] = 0;
  next.landPenaltyTicksLeft[playerIndex] = 0;
}

/**
 * Clears `playerIndex`'s primary weapon slot (server calls this when
 * dropping the primary at a death spot — the drop world-entity itself is
 * server-only bookkeeping, tracked outside SimState; this just removes it
 * from the player so it isn't duplicated). Pure, clone-in/clone-out.
 */
export function clearPrimaryWeapon(state: SimState, playerIndex: number): SimState {
  const next = cloneState(state);
  next.weaponPrimary[playerIndex] = WEAPON_NONE;
  next.magPrimary[playerIndex] = 0;
  next.reservePrimary[playerIndex] = 0;
  return next;
}

/**
 * Grants `weaponId` into `playerIndex`'s primary slot with `mag` ammo loaded
 * (whatever a picked-up drop was left with) and a full reserve — the server
 * calls this on walk-over pickup. Only primary-class weapons are ever
 * dropped/picked up (sidearms are never dropped, per spec). Pure.
 */
export function pickupWeapon(state: SimState, playerIndex: number, weaponId: number, mag: number): SimState {
  const next = cloneState(state);
  const def = getWeaponDef(weaponId);
  next.weaponPrimary[playerIndex] = weaponId;
  next.magPrimary[playerIndex] = mag;
  next.reservePrimary[playerIndex] = def?.reserveAmmo ?? 0;
  return next;
}
