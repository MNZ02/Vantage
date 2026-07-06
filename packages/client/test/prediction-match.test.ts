import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency } from "@vg/protocol";
import { FIXED_DT, LEVEL_BOXES, PHASE_BUY, PHASE_ROUND, SITE_ZONES, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { PredictedClient } from "../src/prediction.js";
import { createScriptedInputSender, idleInput, toAuthoritative } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

describe("prediction exactness in match mode (acceptance criterion 13, match-mode variant)", () => {
  it("reconciliation stays exact (<4e-6, f32 wire ULP at map scale) while pushing against a buy-phase barrier and while channeling a plant in the round phase", () => {
    const host = new ServerHost({
      numPlayers: 2,
      mode: "match",
      minPlayers: 2,
      seed: 909,
      matchConfig: { buyTicks: 128, firstRoundBuyTicks: 128, roundTicks: 2000 },
    });
    const [rawClient, rawServer] = createLoopbackPair();
    const [, rawServer2] = createLoopbackPair();
    const clock = createVirtualClock();
    const clientTransport = withLatency(rawClient, { delayMs: 40, jitterMs: 0, lossRate: 0, seed: 1, scheduler: clock.scheduler });

    let predicted: PredictedClient | null = null;
    let localIndex = -1;
    const diffs: number[] = [];

    clientTransport.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        localIndex = msg.playerIndex;
        if (!predicted) predicted = new PredictedClient(msg.seed, msg.numPlayers, localIndex, LEVEL_BOXES, msg.mode);
      } else if (msg.type === MessageType.Snapshot && predicted) {
        const diff = predicted.reconcile(toAuthoritative(msg));
        diffs.push(diff);
      }
    });

    host.connect(rawServer);
    host.connect(rawServer2); // second player: match starts (minPlayers=2)
    const send = createScriptedInputSender(clientTransport);

    const zone = SITE_ZONES[0]!.box;
    const zoneCx = (zone.minX + zone.maxX) / 2;
    const zoneCz = (zone.minZ + zone.maxZ) / 2;

    let t = 0;
    let reachedRound = false;
    let plantedInputTicks = 0;

    for (let i = 0; i < 900; i++) {
      if (predicted) {
        const state = predicted.getPredictedState();
        let input: InputFrame;
        if (state.matchPhase === PHASE_BUY) {
          // Push north (+Z, toward the attacker-side barrier at z=-8) the
          // whole buy phase — deterministic barrier collision, both sides
          // must agree exactly on how far this gets blocked.
          input = { ...idleInput(0), forward: 1 };
        } else if (state.matchPhase === PHASE_ROUND && !reachedRound) {
          reachedRound = true;
          input = idleInput(0);
        } else if (state.matchPhase === PHASE_ROUND) {
          // Walk toward site A, then hold interact to channel a plant (only
          // does anything if this player happens to be the spike carrier —
          // exactness is what's under test either way, not the outcome).
          const dx = zoneCx - state.posX[localIndex]!;
          const dz = zoneCz - state.posZ[localIndex]!;
          const dist = Math.hypot(dx, dz);
          const yaw = Math.atan2(dx, dz);
          if (dist > 1.5) {
            input = { ...idleInput(yaw), forward: 1 };
          } else {
            input = { ...idleInput(yaw), interact: true };
            plantedInputTicks++;
          }
        } else {
          input = idleInput(0);
        }
        const { seq, quantizedInput } = predicted.queueAndPredict(input);
        send(seq, quantizedInput, Math.round(t));
      }
      t++;
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    expect(predicted).not.toBeNull();
    expect(diffs.length).toBeGreaterThan(20);
    expect(reachedRound).toBe(true);
    expect(plantedInputTicks).toBeGreaterThan(0);
    // Skip the first handful of snapshots (pre-Welcome-sync warmup); every
    // later reconciliation — through the barrier push AND the interact
    // channel — must stay within the same exactness bound as DM mode.
    for (const d of diffs.slice(10)) {
      expect(d).toBeLessThan(4e-6); // f32 ULP is ~3.8e-6 at |coord| up to 36 m (Crossing v2 map half-extent), so wire quantization alone can produce ~1e-6 diffs
    }
  });
});
