import { createLoopbackPair, MessageType, encodeMessage } from "@vg/protocol";
import { FIXED_DT, STAND_HEIGHT, eyePosition } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

function ticksForRttMs(rttMs: number): number {
  return Math.round(rttMs / FIXED_DT_MS);
}

/**
 * Runs the scenario once (target strafing perpendicular to a stationary
 * shooter, 20 m away) and returns whether the server registered a hit when
 * the shooter fires aimed at the target's *past* (viewTick-delayed) position
 * — exactly what a real client would do after rendering the target via its
 * ~100 ms-behind interpolation buffer plus network transit.
 *
 * `viewTick` is computed directly from a recorded position history rather
 * than by round-tripping delayed messages: the mechanism under test is the
 * server's ring-buffer rewind (StateRingBuffer + handleFire), which only
 * cares about the numeric viewTick and the ring buffer's recorded past
 * state — transport-level delay is already covered by the protocol
 * latencysim tests and the client interpolation/reconciliation tests.
 */
function runScenario(rttMs: number, lagComp: boolean): { hit: boolean } {
  const host = new ServerHost({ numPlayers: 2, lagComp });
  const [shooterClient, shooterServer] = createLoopbackPair();
  const [targetClient, targetServer] = createLoopbackPair();
  const shooterIndex = host.connect(shooterServer);
  const targetIndex = host.connect(targetServer);
  expect(shooterIndex).toBe(0);
  expect(targetIndex).toBe(1);

  const sendShooter = createScriptedInputSender(shooterClient);
  const sendTarget = createScriptedInputSender(targetClient);

  // Place the shooter and the target 20 m apart along Z, in the open floor
  // area well clear of the graybox's ramp (z >= 10, see levels.ts) and
  // interior wall (x in [5.75, 6.25]); the target then strafes along +X —
  // perpendicular to the shooter's line of sight — for a few meters, still
  // nowhere near that wall.
  const state = host.getState();
  state.posX[shooterIndex] = 0;
  state.posY[shooterIndex] = 0;
  state.posZ[shooterIndex] = -15;
  state.posX[targetIndex] = 0;
  state.posY[targetIndex] = 0;
  state.posZ[targetIndex] = 5;

  const positionHistory: Array<{ x: number; y: number; z: number }> = [];

  // Settle both players onto the ground first.
  for (let i = 0; i < 10; i++) {
    sendShooter(idleInput());
    sendTarget(idleInput());
    host.step();
    positionHistory[host.getState().tick] = {
      x: host.getState().posX[targetIndex]!,
      y: host.getState().posY[targetIndex]!,
      z: host.getState().posZ[targetIndex]!,
    };
  }

  // Target strafes at full run speed (yaw=0, right=1 -> +X, see movement.ts wishDirection).
  const strafeInput = { forward: 0, right: 1, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false };

  const delayTicks = ticksForRttMs(rttMs);
  const FIRE_AT_TICK = 60; // past settle+warm-up, short enough to stay far from any wall

  let firedTick = -1;
  for (let i = 0; i < FIRE_AT_TICK + 5; i++) {
    sendTarget(strafeInput);

    const currentTickAboutToRun = host.getState().tick + 1;
    if (currentTickAboutToRun === FIRE_AT_TICK) {
      const viewTick = currentTickAboutToRun - delayTicks;
      const viewPos = positionHistory[viewTick];
      if (!viewPos) throw new Error(`test setup error: no recorded position for viewTick ${viewTick}`);

      const eye = eyePosition(host.getState(), shooterIndex);
      const targetCenter = { x: viewPos.x, y: viewPos.y + STAND_HEIGHT / 2, z: viewPos.z };
      const dx = targetCenter.x - eye.x;
      const dy = targetCenter.y - eye.y;
      const dz = targetCenter.z - eye.z;
      const horizontalDist = Math.hypot(dx, dz);
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(dy, horizontalDist);

      sendShooter({ ...idleInput(), yaw, pitch });
      host.step();
      // Give the jitter buffer a couple of ticks to actually apply the aim
      // before firing (its own ~2-tick warm-up/consume delay).
      for (let w = 0; w < 3; w++) {
        sendShooter({ ...idleInput(), yaw, pitch });
        sendTarget(strafeInput);
        host.step();
        positionHistory[host.getState().tick] = {
          x: host.getState().posX[targetIndex]!,
          y: host.getState().posY[targetIndex]!,
          z: host.getState().posZ[targetIndex]!,
        };
      }

      shooterClient.send(encodeMessage({ type: MessageType.FireCmd, seq: 999, viewTick }));
      sendShooter({ ...idleInput(), yaw, pitch });
      sendTarget(strafeInput);
      host.step();
      firedTick = host.getState().tick;
      break;
    }

    host.step();
    positionHistory[host.getState().tick] = {
      x: host.getState().posX[targetIndex]!,
      y: host.getState().posY[targetIndex]!,
      z: host.getState().posZ[targetIndex]!,
    };
  }

  const hit = host.getHits().some((h) => h.shooterIndex === shooterIndex && h.targetIndex === targetIndex && h.serverTick === firedTick);
  return { hit };
}

describe("lag compensation proof (acceptance criterion 7)", () => {
  it("registers a hit at 80ms RTT with lag comp ON", () => {
    expect(runScenario(80, true).hit).toBe(true);
  });

  it("registers a hit at 150ms RTT with lag comp ON", () => {
    expect(runScenario(150, true).hit).toBe(true);
  });

  it("misses at 80ms RTT with lag comp OFF (LAGCOMP=off equivalent)", () => {
    expect(runScenario(80, false).hit).toBe(false);
  });

  it("misses at 150ms RTT with lag comp OFF (LAGCOMP=off equivalent)", () => {
    expect(runScenario(150, false).hit).toBe(false);
  });
});
