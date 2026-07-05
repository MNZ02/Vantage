// M3 round/match state machine: buy -> round -> roundEnd -> buy ... -> matchEnd,
// plus the spike lifecycle (carry/drop/plant/defuse) and cross-round economy.
// Pure functions only, called from tick.ts (mode === MODE_MATCH) and from
// the server (startMatch(), once enough players have connected). No wall
// clock, no randomness beyond the existing seeded prng plumbing already used
// elsewhere in sim/src — same purity constraints as the rest of the package.

import {
  ATTACKER_SPAWNS,
  BARRIERS,
  DEFENDER_SPAWNS,
  SITE_ZONES,
} from "./levels.js";
import { length2D } from "./math.js";
import {
  CHANNEL_STATIONARY_SPEED_MPS,
  DEFUSE_RADIUS_M,
  MODE_MATCH,
  NO_PLAYER,
  PHASE_BUY,
  PHASE_MATCH_END,
  PHASE_ROUND,
  PHASE_ROUND_END,
  PHASE_WAITING,
  ROUND_END_DEFUSE,
  ROUND_END_DETONATION,
  ROUND_END_ELIMINATION,
  ROUND_END_TIMEOUT,
  SPAWN_HEALTH,
  SPIKE_CARRIED,
  SPIKE_DEFUSED,
  SPIKE_DETONATED,
  SPIKE_DROPPED,
  SPIKE_PLANTED,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  TEAM_NONE,
  WEAPON_NONE,
} from "./constants.js";
import { WEAPON_VIPER, getWeaponDef } from "./weapons/data.js";
import { cloneState, type Box, type InputFrame, type SimState } from "./state.js";

/** True if (x, z) falls inside any plant/defuse site zone (2D, ignores the box's Y extent). */
export function pointInAnySiteZone(x: number, z: number): boolean {
  for (const zone of SITE_ZONES) {
    if (x >= zone.box.minX && x <= zone.box.maxX && z >= zone.box.minZ && z <= zone.box.maxZ) return true;
  }
  return false;
}

/**
 * Effective collision boxes for `playerIndex` this tick: the shared level
 * boxes plus any buy-phase barrier that blocks THEIR team. Barriers vanish
 * (are simply omitted) outside PHASE_BUY, or for a player with no team yet.
 */
export function effectiveBoxesForPlayer(state: SimState, boxes: readonly Box[], playerIndex: number): readonly Box[] {
  if (state.mode !== MODE_MATCH || state.matchPhase !== PHASE_BUY) return boxes;
  const team = state.team[playerIndex]!;
  if (team !== TEAM_ATTACKERS && team !== TEAM_DEFENDERS) return boxes;
  const blocking = BARRIERS.filter((b) => b.team === team).map((b) => b.box);
  if (blocking.length === 0) return boxes;
  return [...boxes, ...blocking];
}

/** Per-tick channel eligibility, computed from *last* tick's resting state (pre-movement) so it can gate this tick's wish-direction. */
export interface ChannelDecisions {
  readonly wantsPlant: readonly boolean[];
  readonly wantsDefuse: readonly boolean[];
}

export function computeChannelDecisions(state: SimState, inputs: readonly (InputFrame | undefined)[]): ChannelDecisions {
  const n = state.numPlayers;
  const wantsPlant = new Array<boolean>(n).fill(false);
  const wantsDefuse = new Array<boolean>(n).fill(false);

  if (state.mode !== MODE_MATCH || state.matchPhase !== PHASE_ROUND) {
    return { wantsPlant, wantsDefuse };
  }

  for (let i = 0; i < n; i++) {
    if (state.alive[i] === 0) continue;
    const input = inputs[i];
    if (!input || !input.interact) continue;

    if (state.spikeState === SPIKE_CARRIED && state.spikeCarrier === i) {
      const inZone = pointInAnySiteZone(state.posX[i]!, state.posZ[i]!);
      const speed = length2D(state.velX[i]!, state.velZ[i]!);
      wantsPlant[i] = inZone && speed < CHANNEL_STATIONARY_SPEED_MPS;
    } else if (state.spikeState === SPIKE_PLANTED && state.team[i] === TEAM_DEFENDERS) {
      const dist = Math.hypot(state.posX[i]! - state.spikeX, state.posZ[i]! - state.spikeZ);
      wantsDefuse[i] = dist <= DEFUSE_RADIUS_M;
    }
  }
  return { wantsPlant, wantsDefuse };
}

/** True if this player is mid-channel this tick (movement.ts callers should zero their wish-direction). */
export function isChanneling(decisions: ChannelDecisions, playerIndex: number): boolean {
  return decisions.wantsPlant[playerIndex] === true || decisions.wantsDefuse[playerIndex] === true;
}

/**
 * Spectate target list for a dead player: every OTHER living player on the
 * same team, in ascending index order (never the dead player themself, never
 * enemies). Empty in DM (team is always TEAM_NONE there — spectate is a
 * match-mode-only concept) or if no teammate is currently alive, in which
 * case the client falls back to an overhead map view. Pure, no rendering.
 */
export function livingTeammates(state: SimState, playerIndex: number): number[] {
  const team = state.team[playerIndex]!;
  if (team !== TEAM_ATTACKERS && team !== TEAM_DEFENDERS) return [];
  const out: number[] = [];
  for (let i = 0; i < state.numPlayers; i++) {
    if (i === playerIndex) continue;
    if (state.team[i] === team && state.alive[i] === 1) out.push(i);
  }
  return out;
}

function countAlive(state: SimState, team: number): number {
  let n = 0;
  for (let i = 0; i < state.numPlayers; i++) {
    if (state.team[i] === team && state.alive[i] === 1) n++;
  }
  return n;
}

function resetLoadoutToDefault(next: SimState, i: number): void {
  next.weaponPrimary[i] = WEAPON_NONE;
  next.magPrimary[i] = 0;
  next.reservePrimary[i] = 0;
  next.weaponSecondary[i] = WEAPON_VIPER;
  const viper = getWeaponDef(WEAPON_VIPER)!;
  next.magSecondary[i] = viper.magSize;
  next.reserveSecondary[i] = viper.reserveAmmo;
  next.armor[i] = 0;
  next.activeSlot[i] = 1;
}

function refillMagsForCurrentLoadout(next: SimState, i: number): void {
  const primaryId = next.weaponPrimary[i]!;
  if (primaryId !== WEAPON_NONE) {
    const def = getWeaponDef(primaryId);
    if (def) next.magPrimary[i] = def.magSize;
  }
  const secondaryId = next.weaponSecondary[i]!;
  if (secondaryId !== WEAPON_NONE) {
    const def = getWeaponDef(secondaryId);
    if (def) next.magSecondary[i] = def.magSize;
  }
}

function isOvertime(state: SimState): boolean {
  return state.scoreTeam0 >= state.config.winTarget - 1 && state.scoreTeam1 >= state.config.winTarget - 1;
}

/**
 * Transitions into a fresh buy phase: revives everyone, teleports to team
 * spawns, resets/keeps loadouts per the survivor-vs-dead and half-swap/OT
 * rules, reassigns the spike, and snapshots buy-start loadouts for sell
 * refunds. Called both by startMatch() (waiting -> round 1) and internally
 * by tick() at PHASE_ROUND_END -> PHASE_BUY.
 */
function enterBuyPhase(next: SimState, currentTick: number): void {
  const priorRoundNumber = next.roundNumber;
  next.roundNumber = priorRoundNumber + 1;

  let didHalfSwap = false;
  if (priorRoundNumber === next.config.halfAtRound && next.halvesSwapped === 0) {
    next.halvesSwapped = 1;
    didHalfSwap = true;
    for (let i = 0; i < next.numPlayers; i++) {
      const t = next.team[i]!;
      if (t === TEAM_ATTACKERS) next.team[i] = TEAM_DEFENDERS;
      else if (t === TEAM_DEFENDERS) next.team[i] = TEAM_ATTACKERS;
    }
  }

  const isFirstBuyEver = next.roundNumber === 1;
  const ot = isOvertime(next);

  if (isFirstBuyEver || didHalfSwap) {
    for (let i = 0; i < next.numPlayers; i++) {
      next.credits[i] = next.config.startCredits;
      resetLoadoutToDefault(next, i);
    }
    next.lossStreakTeam0 = 0;
    next.lossStreakTeam1 = 0;
  } else if (ot) {
    for (let i = 0; i < next.numPlayers; i++) {
      next.credits[i] = next.config.otStartCredits;
      resetLoadoutToDefault(next, i);
    }
  } else {
    for (let i = 0; i < next.numPlayers; i++) {
      if (next.alive[i] === 0) {
        resetLoadoutToDefault(next, i);
      }
    }
  }

  // Revive everyone; refill mags for whatever loadout they now hold.
  for (let i = 0; i < next.numPlayers; i++) {
    next.alive[i] = 1;
    next.health[i] = SPAWN_HEALTH;
    next.respawnTick[i] = -1;
    next.tagTicksLeft[i] = 0;
    next.landPenaltyTicksLeft[i] = 0;
    next.reloadEndTick[i] = -1;
    next.equipEndTick[i] = -1;
    next.adsStage[i] = 0;
    next.velX[i] = 0;
    next.velY[i] = 0;
    next.velZ[i] = 0;
    next.grounded[i] = 1;
    refillMagsForCurrentLoadout(next, i);
  }

  // Teleport to team spawns, ranked by player index within team.
  const rankByTeam: Record<number, number> = { [TEAM_ATTACKERS]: 0, [TEAM_DEFENDERS]: 0 };
  for (let i = 0; i < next.numPlayers; i++) {
    const t = next.team[i]!;
    if (t !== TEAM_ATTACKERS && t !== TEAM_DEFENDERS) continue;
    const spawns = t === TEAM_ATTACKERS ? ATTACKER_SPAWNS : DEFENDER_SPAWNS;
    const rank = rankByTeam[t]!;
    rankByTeam[t] = rank + 1;
    const spawn = spawns[rank % spawns.length]!;
    next.posX[i] = spawn.x;
    next.posY[i] = spawn.y;
    next.posZ[i] = spawn.z;
    next.yaw[i] = spawn.yaw;
  }

  // Spike reassignment: lowest-index living attacker.
  let carrier = NO_PLAYER;
  for (let i = 0; i < next.numPlayers; i++) {
    if (next.team[i] === TEAM_ATTACKERS) {
      carrier = i;
      break;
    }
  }
  next.spikeState = SPIKE_CARRIED;
  next.spikeCarrier = carrier;
  next.spikeX = carrier !== NO_PLAYER ? next.posX[carrier]! : 0;
  next.spikeY = carrier !== NO_PLAYER ? next.posY[carrier]! : 0;
  next.spikeZ = carrier !== NO_PLAYER ? next.posZ[carrier]! : 0;
  next.spikePlantedTick = -1;
  next.plantProgress = 0;
  next.planterIndex = NO_PLAYER;
  next.defuseProgress = 0;
  next.defuserIndex = NO_PLAYER;
  next.defuseCheckpointHit = 0;

  // Buy-start snapshots (sell/refund reference point).
  for (let i = 0; i < next.numPlayers; i++) {
    next.weaponPrimaryAtBuyStart[i] = next.weaponPrimary[i]!;
    next.weaponSecondaryAtBuyStart[i] = next.weaponSecondary[i]!;
    next.armorAtBuyStart[i] = next.armor[i]!;
    next.primaryPurchasedItemId[i] = WEAPON_NONE;
    next.secondaryPurchasedItemId[i] = WEAPON_NONE;
    next.armorPurchasedItemId[i] = NO_PLAYER;
  }

  next.matchPhase = PHASE_BUY;
  const useFirstRoundTimer = isFirstBuyEver || didHalfSwap;
  next.phaseEndTick = currentTick + 1 + (useFirstRoundTimer ? next.config.firstRoundBuyTicks : next.config.buyTicks);
}

/**
 * Pure: assigns teams alternating by (join) index and enters the first buy
 * phase. Call once the server has enough connected players. No-op (returns
 * an unchanged clone) if not currently in the waiting phase or not match mode.
 */
export function startMatch(state: SimState): SimState {
  if (state.mode !== MODE_MATCH || state.matchPhase !== PHASE_WAITING) return state;
  const next = cloneState(state);
  for (let i = 0; i < next.numPlayers; i++) {
    next.team[i] = i % 2 === 0 ? TEAM_ATTACKERS : TEAM_DEFENDERS;
  }
  enterBuyPhase(next, next.tick - 1);
  return next;
}

function applyRoundEnd(next: SimState, winnerRole: number, reason: number, currentTick: number): void {
  next.lastRoundWinnerTeam = winnerRole;
  next.lastRoundEndReason = reason;

  const winningSquad = next.halvesSwapped === 1 ? 1 - winnerRole : winnerRole;
  if (winningSquad === 0) next.scoreTeam0 += 1;
  else next.scoreTeam1 += 1;

  const loserRole = 1 - winnerRole;
  const loserStreak = loserRole === TEAM_ATTACKERS ? next.lossStreakTeam0 : next.lossStreakTeam1;
  const streakIdx = Math.min(2, loserStreak);
  const lossAward = next.config.lossCredits[streakIdx]!;

  for (let i = 0; i < next.numPlayers; i++) {
    if (next.team[i] === winnerRole) {
      next.credits[i] = Math.min(next.config.maxCredits, next.credits[i]! + next.config.winCredits);
    } else if (next.team[i] === loserRole) {
      next.credits[i] = Math.min(next.config.maxCredits, next.credits[i]! + lossAward);
    }
  }

  if (winnerRole === TEAM_ATTACKERS) {
    next.lossStreakTeam0 = 0;
    next.lossStreakTeam1 = Math.min(2, next.lossStreakTeam1 + 1);
  } else {
    next.lossStreakTeam1 = 0;
    next.lossStreakTeam0 = Math.min(2, next.lossStreakTeam0 + 1);
  }

  // Plant bonus: +300 to every attacker, once, if the spike was planted at
  // any point this round — regardless of who won the round.
  if (next.spikePlantedTick !== -1) {
    for (let i = 0; i < next.numPlayers; i++) {
      if (next.team[i] === TEAM_ATTACKERS) {
        next.credits[i] = Math.min(next.config.maxCredits, next.credits[i]! + next.config.plantBonus);
      }
    }
  }

  next.matchPhase = PHASE_ROUND_END;
  next.phaseEndTick = currentTick + 1 + next.config.roundEndTicks;

  const leader = Math.max(next.scoreTeam0, next.scoreTeam1);
  const diff = Math.abs(next.scoreTeam0 - next.scoreTeam1);
  if (leader >= next.config.winTarget && diff >= 2) {
    next.matchPhase = PHASE_MATCH_END;
    next.phaseEndTick = -1;
  }
}

/**
 * Advances match-mode round/spike state for one tick. Called by tick.ts
 * AFTER the per-player movement/weapon loop (so it sees this tick's
 * positions/alive-from-damage), with the SAME `decisions` computed before
 * the loop (channel eligibility is evaluated against the tick's *starting*
 * state, kept consistent between the movement-gating pass and this
 * progress/win-condition pass). No-op outside match mode.
 */
export function advanceMatchState(prev: SimState, next: SimState, decisions: ChannelDecisions, currentTick: number): void {
  if (next.mode !== MODE_MATCH) return;

  // Spike carrier died this tick (damage applied between ticks already set
  // alive=0 on `prev`/`next` before tick() ran) — drop it at the last known
  // position. Checked unconditionally (any phase) so a death right at a
  // phase boundary can't leave the spike "carried" by a dead player.
  if (next.spikeState === SPIKE_CARRIED && next.spikeCarrier !== NO_PLAYER && next.alive[next.spikeCarrier]! === 0) {
    const deadCarrier = next.spikeCarrier;
    next.spikeState = SPIKE_DROPPED;
    next.spikeX = prev.posX[deadCarrier]!;
    next.spikeY = prev.posY[deadCarrier]!;
    next.spikeZ = prev.posZ[deadCarrier]!;
    next.spikeCarrier = NO_PLAYER;
  }

  // Walk-over pickup: a living attacker within reach of a dropped spike
  // picks it up. (Defenders never pick up the spike.)
  if (next.spikeState === SPIKE_DROPPED) {
    for (let i = 0; i < next.numPlayers; i++) {
      if (next.team[i] !== TEAM_ATTACKERS || next.alive[i] === 0) continue;
      const dist = Math.hypot(next.posX[i]! - next.spikeX, next.posZ[i]! - next.spikeZ);
      if (dist <= 0.8) {
        next.spikeState = SPIKE_CARRIED;
        next.spikeCarrier = i;
        break;
      }
    }
  }

  if (next.matchPhase === PHASE_ROUND) {
    // ---- Plant channeling ----
    if (next.spikeState === SPIKE_CARRIED && next.spikeCarrier !== NO_PLAYER && decisions.wantsPlant[next.spikeCarrier]) {
      const carrier = next.spikeCarrier;
      next.plantProgress = Math.min(next.config.plantTicks, next.plantProgress + 1);
      next.planterIndex = carrier;
      if (next.plantProgress >= next.config.plantTicks) {
        next.spikeState = SPIKE_PLANTED;
        next.spikeX = next.posX[carrier]!;
        next.spikeY = next.posY[carrier]!;
        next.spikeZ = next.posZ[carrier]!;
        next.spikeCarrier = NO_PLAYER;
        next.spikePlantedTick = currentTick + 1;
        next.plantProgress = 0;
        next.planterIndex = NO_PLAYER;
      }
    } else if (next.plantProgress > 0) {
      next.plantProgress = 0;
      next.planterIndex = NO_PLAYER;
    }

    // ---- Defuse channeling ----
    if (next.spikeState === SPIKE_PLANTED) {
      let defuser = NO_PLAYER;
      if (next.defuserIndex !== NO_PLAYER && decisions.wantsDefuse[next.defuserIndex]) {
        defuser = next.defuserIndex;
      } else {
        for (let i = 0; i < next.numPlayers; i++) {
          if (decisions.wantsDefuse[i]) {
            defuser = i;
            break;
          }
        }
      }

      if (defuser !== NO_PLAYER) {
        next.defuseProgress = Math.min(next.config.defuseTicks, next.defuseProgress + 1);
        next.defuserIndex = defuser;
        if (next.defuseProgress >= next.config.defuseCheckpointTicks) next.defuseCheckpointHit = 1;
        if (next.defuseProgress >= next.config.defuseTicks) {
          next.spikeState = SPIKE_DEFUSED;
        }
      } else {
        next.defuseProgress = next.defuseCheckpointHit === 1 ? next.config.defuseCheckpointTicks : 0;
        next.defuserIndex = NO_PLAYER;
      }
    }

    // ---- Win-condition checks ----
    if (next.spikeState === SPIKE_DEFUSED) {
      applyRoundEnd(next, TEAM_DEFENDERS, ROUND_END_DEFUSE, currentTick);
    } else if (next.spikeState === SPIKE_PLANTED && currentTick + 1 >= next.spikePlantedTick + next.config.spikeTicks) {
      next.spikeState = SPIKE_DETONATED;
      applyRoundEnd(next, TEAM_ATTACKERS, ROUND_END_DETONATION, currentTick);
    } else if (next.spikeState !== SPIKE_PLANTED) {
      const attackersAlive = countAlive(next, TEAM_ATTACKERS);
      const defendersAlive = countAlive(next, TEAM_DEFENDERS);
      if (attackersAlive === 0) {
        applyRoundEnd(next, TEAM_DEFENDERS, ROUND_END_ELIMINATION, currentTick);
      } else if (defendersAlive === 0) {
        applyRoundEnd(next, TEAM_ATTACKERS, ROUND_END_ELIMINATION, currentTick);
      } else if (currentTick + 1 >= next.phaseEndTick) {
        applyRoundEnd(next, TEAM_DEFENDERS, ROUND_END_TIMEOUT, currentTick);
      }
    }
    return;
  }

  if (next.matchPhase === PHASE_BUY && currentTick + 1 >= next.phaseEndTick) {
    next.matchPhase = PHASE_ROUND;
    next.phaseEndTick = currentTick + 1 + next.config.roundTicks;
    // Safety invariant (reviewer fix, M3 follow-up): every connected player
    // should already be alive here — enterBuyPhase() revives everyone at
    // buy-phase start, and fire is now phase-gated so no damage can occur
    // during the buy phase to begin with (see weapons/logic.ts
    // stepWeaponLogic's canFireThisPhase). This is a cheap defensive repair,
    // not the primary mechanism: entering PHASE_ROUND must never seat a
    // team with a dead player, even if some future code path slips a kill
    // in during the buy phase.
    for (let i = 0; i < next.numPlayers; i++) {
      if ((next.team[i] === TEAM_ATTACKERS || next.team[i] === TEAM_DEFENDERS) && next.alive[i] === 0) {
        next.alive[i] = 1;
        next.health[i] = SPAWN_HEALTH;
        next.respawnTick[i] = -1;
      }
    }
    return;
  }

  if (next.matchPhase === PHASE_ROUND_END && currentTick + 1 >= next.phaseEndTick) {
    enterBuyPhase(next, currentTick);
    return;
  }
}
