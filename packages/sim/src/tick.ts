import { FIXED_DT, LAND_PENALTY_TICKS, MODE_MATCH, PHASE_MATCH_END, PHASE_ROUND_END, TAG_MULT } from "./constants.js";
import { advanceMatchState, computeChannelDecisions, effectiveBoxesForPlayer, isChanneling } from "./match.js";
import { movePlayer } from "./movement.js";
import { nextRandom } from "./prng.js";
import { cloneState, type Box, type InputFrame, type ShotEvent, type SimState } from "./state.js";
import { getActiveWeaponId, respawnPlayer, stepWeaponLogic } from "./weapons/logic.js";
import { getWeaponDef } from "./weapons/data.js";

export interface TickResult {
  state: SimState;
  shots: ShotEvent[];
}

/**
 * Advances the whole simulation by one fixed timestep. Pure: never mutates
 * `state` or `inputs`, and reads no ambient state (wall clock, module-level
 * mutables) — same (state, inputs, boxes) always produces the same output.
 *
 * Returns the new state plus any ShotEvents fired this tick. Shots are
 * derived deterministically from the `fire` input bit and weapon timers —
 * whether a shot happens is pure sim; hit resolution/damage is NOT (see
 * damage.ts's documented mutation boundary, applied by the server between
 * ticks).
 *
 * M3: in match mode (state.mode === MODE_MATCH), plant/defuse channel
 * eligibility is decided up front from *this tick's starting* state (see
 * match.ts's computeChannelDecisions) so it can gate movement (channeling
 * zeroes the wish-direction) BEFORE per-player movement runs; round/spike
 * state machine progress and phase transitions are then advanced by
 * advanceMatchState() AFTER the per-player loop, so it sees this tick's
 * resulting positions/alive flags. DM mode (mode 0) takes neither path.
 *
 * Reviewer fix (M3 follow-up): combat/movement must be phase-gated, not just
 * the spike channel. Movement wish-direction is frozen (position frozen,
 * look/camera NOT — yaw/pitch below are always taken from the raw `input`,
 * never from the zeroed `movementInput`) during PHASE_ROUND_END and
 * PHASE_MATCH_END — there is no "round" happening then, and letting players
 * reposition during the round-end freeze was a real bug. PHASE_BUY
 * deliberately still allows movement (barriers gate it instead — see
 * effectiveBoxesForPlayer), matching Valorant. Fire gating for ALL non-round
 * phases (buy/roundEnd/waiting/matchEnd) lives in weapons/logic.ts's
 * stepWeaponLogic, which reads `prev.matchPhase` directly — no ShotEvent is
 * ever emitted for a shot fired outside PHASE_ROUND in match mode.
 */
export function tick(state: SimState, inputs: readonly InputFrame[], boxes: readonly Box[]): TickResult {
  const next = cloneState(state);
  const shots: ShotEvent[] = [];
  const currentTick = state.tick;
  const channelDecisions = computeChannelDecisions(state, inputs);
  const movementFrozenByPhase =
    state.mode === MODE_MATCH && (state.matchPhase === PHASE_ROUND_END || state.matchPhase === PHASE_MATCH_END);

  for (let i = 0; i < next.numPlayers; i++) {
    const input = inputs[i];

    if (state.alive[i] === 0) {
      // Dead: frozen in place, inputs ignored, no collision target (see
      // raycastPlayers). If eligible, respawn deterministically this tick
      // (server and the owning client's own prediction/replay agree bit-
      // for-bit); movement/weapon logic for the newly-live player resumes
      // next tick so this tick's spawn position is exact and untouched by
      // this tick's input. Match mode never schedules a respawn (see
      // weapons/logic.ts scheduleDeath) — revival happens only at the next
      // buy-phase transition (see match.ts enterBuyPhase).
      const respawnAt = state.respawnTick[i]!;
      if (respawnAt !== -1 && currentTick >= respawnAt) {
        respawnPlayer(next, i, currentTick);
      }
      continue;
    }

    if (!input) continue; // unconnected/no-input slot: stays frozen, same as pre-M2 behavior

    // Movement modifiers computed from *last* tick's weapon/tag state (this
    // tick's slot switch, if any, takes effect from next tick's movement —
    // consistent and deterministic either way, and avoids a same-tick
    // read-your-own-write ordering hazard between weapon logic and movement).
    let speedMultiplier = 1;
    if (state.tagTicksLeft[i]! > 0) speedMultiplier *= TAG_MULT;
    if (state.adsStage[i]! > 0) {
      const weaponId = getActiveWeaponId(state, i);
      const weapon = getWeaponDef(weaponId);
      if (weapon) speedMultiplier *= weapon.adsMoveSpeedMult;
    }

    const effectiveBoxes = effectiveBoxesForPlayer(state, boxes, i);
    const channeling = isChanneling(channelDecisions, i);
    const movementInput: InputFrame =
      channeling || movementFrozenByPhase ? { ...input, forward: 0, right: 0, jump: false } : input;

    const result = movePlayer(state, i, movementInput, effectiveBoxes, FIXED_DT, speedMultiplier);

    next.posX[i] = result.posX;
    next.posY[i] = result.posY;
    next.posZ[i] = result.posZ;
    next.velX[i] = result.velX;
    next.velY[i] = result.velY;
    next.velZ[i] = result.velZ;
    next.grounded[i] = result.grounded ? 1 : 0;
    next.crouching[i] = input.crouch ? 1 : 0;
    next.yaw[i] = input.yaw;
    next.pitch[i] = input.pitch;

    // Land penalty: transitioning airborne -> grounded this tick.
    if (state.grounded[i] === 0 && result.grounded) {
      next.landPenaltyTicksLeft[i] = LAND_PENALTY_TICKS;
    } else {
      next.landPenaltyTicksLeft[i] = Math.max(0, state.landPenaltyTicksLeft[i]! - 1);
    }
    next.tagTicksLeft[i] = Math.max(0, state.tagTicksLeft[i]! - 1);

    const shot = stepWeaponLogic(state, next, i, input, currentTick);
    if (shot) shots.push(shot);
  }

  if (next.mode === MODE_MATCH) {
    advanceMatchState(state, next, channelDecisions, currentTick);
  }

  const rng = nextRandom(state.prngState);
  next.prngState = rng.nextState;
  next.tick = state.tick + 1;

  return { state: next, shots };
}
