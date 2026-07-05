// M5 audio: footstep audibility/stride gating (Valorant's rule: running is
// audible at range, walking/crouching is silent). Pure — no AudioContext, no
// wall-clock — so it's unit-testable headlessly (spec acceptance criterion).
import { WALK_SPEED } from "@vg/sim";

/** Distance (m) between footstep sounds while running — an authored approximation of a run stride. */
export const RUN_STRIDE_M = 2.2;

/** Max distance (m) a footstep is audible from — mirrors Valorant's ~20 m running-audible range. */
export const FOOTSTEP_MAX_AUDIBLE_M = 20;

/** Speed (m/s) at/below which a player is "walking or crouching" and makes no audible footsteps. Mirrors sim's WALK_SPEED exactly (see @vg/sim constants.ts) so the audio rule and the movement rule can never drift apart. */
export const FOOTSTEP_SILENT_MAX_SPEED = WALK_SPEED;

export interface FootstepTrackerState {
  distanceSinceStepM: number;
}

export function createFootstepTracker(): FootstepTrackerState {
  return { distanceSinceStepM: 0 };
}

/**
 * Advances the stride tracker by `speedMps` over `dtSeconds`. Returns true
 * exactly when a footstep should fire this update (and consumes one stride's
 * worth of accumulated distance, keeping remainder so cadence stays exact
 * over many small steps rather than drifting). Walking/crouching (speed at
 * or below FOOTSTEP_SILENT_MAX_SPEED) resets the accumulator to zero and
 * never fires — mirrors Valorant's audibility rule (spec).
 */
export function updateFootstepTracker(
  state: FootstepTrackerState,
  speedMps: number,
  dtSeconds: number,
  silentMaxSpeed = FOOTSTEP_SILENT_MAX_SPEED,
): boolean {
  if (speedMps <= silentMaxSpeed) {
    state.distanceSinceStepM = 0;
    return false;
  }
  state.distanceSinceStepM += speedMps * dtSeconds;
  if (state.distanceSinceStepM >= RUN_STRIDE_M) {
    state.distanceSinceStepM -= RUN_STRIDE_M;
    return true;
  }
  return false;
}

/** Whether a footstep at `distanceM` away from the listener is audible at all (spec: "max audible 20 m"). */
export function isFootstepAudible(distanceM: number, maxAudibleM = FOOTSTEP_MAX_AUDIBLE_M): boolean {
  return distanceM <= maxAudibleM;
}
