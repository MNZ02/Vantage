import { RUN_SPEED, WALK_SPEED, CROUCH_SPEED } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { FOOTSTEP_MAX_AUDIBLE_M, RUN_STRIDE_M, createFootstepTracker, isFootstepAudible, updateFootstepTracker } from "../src/audio/footsteps.js";

describe("footstep stride/audibility gating (M5 acceptance criterion 3)", () => {
  it("running emits a step roughly every 2.2m stride", () => {
    const tracker = createFootstepTracker();
    const dt = 1 / 64; // one fixed sim tick
    let stepsFired = 0;
    let distanceCovered = 0;
    const totalSeconds = 10;
    for (let t = 0; t < totalSeconds / dt; t++) {
      if (updateFootstepTracker(tracker, RUN_SPEED, dt)) stepsFired++;
      distanceCovered += RUN_SPEED * dt;
    }
    const expectedSteps = distanceCovered / RUN_STRIDE_M;
    expect(stepsFired).toBeGreaterThanOrEqual(Math.floor(expectedSteps) - 1);
    expect(stepsFired).toBeLessThanOrEqual(Math.ceil(expectedSteps) + 1);
    expect(stepsFired).toBeGreaterThan(0);
  });

  it("walking emits no footsteps at all", () => {
    const tracker = createFootstepTracker();
    const dt = 1 / 64;
    let stepsFired = 0;
    for (let t = 0; t < (10 / dt); t++) {
      if (updateFootstepTracker(tracker, WALK_SPEED, dt)) stepsFired++;
    }
    expect(stepsFired).toBe(0);
  });

  it("crouch-walking emits no footsteps at all", () => {
    const tracker = createFootstepTracker();
    const dt = 1 / 64;
    let stepsFired = 0;
    for (let t = 0; t < (10 / dt); t++) {
      if (updateFootstepTracker(tracker, CROUCH_SPEED, dt)) stepsFired++;
    }
    expect(stepsFired).toBe(0);
  });

  it("resets stride distance to zero the instant speed drops to walk/stop, so a later run doesn't fire an immediate stale step", () => {
    const tracker = createFootstepTracker();
    const dt = 1 / 64;
    // Run for a bit short of one stride...
    updateFootstepTracker(tracker, RUN_SPEED, RUN_STRIDE_M / RUN_SPEED - dt);
    expect(tracker.distanceSinceStepM).toBeGreaterThan(0);
    // ...then stop/walk: accumulator must reset.
    updateFootstepTracker(tracker, WALK_SPEED, dt);
    expect(tracker.distanceSinceStepM).toBe(0);
  });

  it("footsteps are audible within 20m and inaudible beyond it", () => {
    expect(isFootstepAudible(0)).toBe(true);
    expect(isFootstepAudible(FOOTSTEP_MAX_AUDIBLE_M)).toBe(true);
    expect(isFootstepAudible(FOOTSTEP_MAX_AUDIBLE_M + 0.01)).toBe(false);
    expect(isFootstepAudible(50)).toBe(false);
  });
});
