import { FIXED_DT } from "./constants.js";
import { movePlayer } from "./movement.js";
import { nextRandom } from "./prng.js";
import { cloneState, type Box, type InputFrame, type SimState } from "./state.js";

/**
 * Advances the whole simulation by one fixed timestep. Pure: never mutates
 * `state` or `inputs`, and reads no ambient state (wall clock, module-level
 * mutables) — same (state, inputs, boxes) always produces the same output.
 */
export function tick(state: SimState, inputs: readonly InputFrame[], boxes: readonly Box[]): SimState {
  const next = cloneState(state);

  for (let i = 0; i < next.numPlayers; i++) {
    const input = inputs[i];
    if (!input) continue;

    const result = movePlayer(state, i, input, boxes, FIXED_DT);

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
  }

  const rng = nextRandom(state.prngState);
  next.prngState = rng.nextState;
  next.tick = state.tick + 1;

  return next;
}
