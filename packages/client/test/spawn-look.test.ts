import {
  MODE_MATCH,
  PHASE_BUY,
  PHASE_ROUND,
  PHASE_WAITING,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  createState,
} from "@vg/sim";
import { describe, expect, it } from "vitest";
import { spawnLookTarget } from "../src/spawnLook.js";

describe("spawn look target", () => {
  it("uses canonical team directions even when replay has overwritten predicted yaw", () => {
    const state = createState(1, 2);
    state.mode = MODE_MATCH;
    state.matchPhase = PHASE_BUY;
    state.roundNumber = 3;
    state.team[0] = TEAM_ATTACKERS;
    state.team[1] = TEAM_DEFENDERS;
    state.yaw[0] = 1.25;
    state.yaw[1] = -0.75;

    expect(spawnLookTarget(state, 0)).toEqual({ key: "match:3", yaw: 0, pitch: 0 });
    expect(spawnLookTarget(state, 1)).toEqual({ key: "match:3", yaw: Math.PI, pitch: 0 });

    state.roundNumber = 4;
    expect(spawnLookTarget(state, 1)?.key).toBe("match:4");
  });

  it("waits until match spawn setup leaves the waiting phase", () => {
    const state = createState(2, 1);
    state.mode = MODE_MATCH;
    state.matchPhase = PHASE_WAITING;
    expect(spawnLookTarget(state, 0)).toBeNull();
  });

  it("does not snap live-round reconnects back to spawn direction", () => {
    const state = createState(3, 1);
    state.mode = MODE_MATCH;
    state.matchPhase = PHASE_ROUND;
    state.team[0] = TEAM_DEFENDERS;
    state.yaw[0] = 0.42;

    expect(spawnLookTarget(state, 0)).toBeNull();
  });
});
