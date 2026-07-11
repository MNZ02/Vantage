import {
  ATTACKER_SPAWNS,
  DEFENDER_SPAWNS,
  MODE_MATCH,
  PHASE_BUY,
  PHASE_WAITING,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  type SimState,
} from "@vg/sim";

export interface SpawnLookTarget {
  key: string;
  yaw: number;
  pitch: number;
}

/**
 * Returns the one-time look target for a mode/round. Match targets use the
 * canonical team spawn direction instead of predicted yaw, which may already
 * have been overwritten by replayed input during snapshot reconciliation.
 */
export function spawnLookTarget(state: SimState, localIndex: number): SpawnLookTarget | null {
  if (state.mode === MODE_MATCH) {
    if (state.matchPhase === PHASE_WAITING) return null;
    // A canonical spawn direction is valid only while players are actually
    // at their round spawns. Reloading/reconnecting during live or end-round
    // play must preserve the current aim instead of snapping to 0/PI.
    if (state.matchPhase !== PHASE_BUY) return null;
    const team = state.team[localIndex]!;
    const spawns = team === TEAM_ATTACKERS ? ATTACKER_SPAWNS : team === TEAM_DEFENDERS ? DEFENDER_SPAWNS : null;
    return {
      key: `match:${state.roundNumber}`,
      yaw: spawns?.[0]?.yaw ?? state.yaw[localIndex]!,
      pitch: 0,
    };
  }

  return {
    key: `mode:${state.mode}`,
    yaw: state.yaw[localIndex]!,
    pitch: state.pitch[localIndex]!,
  };
}
