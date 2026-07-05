import { FIXED_DT, LAND_PENALTY_TICKS, TAG_MULT } from "./constants.js";
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
 */
export function tick(state: SimState, inputs: readonly InputFrame[], boxes: readonly Box[]): TickResult {
  const next = cloneState(state);
  const shots: ShotEvent[] = [];
  const currentTick = state.tick;

  for (let i = 0; i < next.numPlayers; i++) {
    const input = inputs[i];

    if (state.alive[i] === 0) {
      // Dead: frozen in place, inputs ignored, no collision target (see
      // raycastPlayers). If eligible, respawn deterministically this tick
      // (server and the owning client's own prediction/replay agree bit-
      // for-bit); movement/weapon logic for the newly-live player resumes
      // next tick so this tick's spawn position is exact and untouched by
      // this tick's input.
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

    const result = movePlayer(state, i, input, boxes, FIXED_DT, speedMultiplier);

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

  const rng = nextRandom(state.prngState);
  next.prngState = rng.nextState;
  next.tick = state.tick + 1;

  return { state: next, shots };
}
