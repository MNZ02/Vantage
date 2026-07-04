import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency, type SnapshotMessage } from "@vg/protocol";
import { FIXED_DT, LEVEL_BOXES, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { PredictedClient, type AuthoritativeSnapshot } from "../src/prediction.js";
import { createScriptedInputSender } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;
const NUM_CLIENTS = 10;
const TICKS = 1920; // 30s @ 64Hz

// Mixed latency profiles: 30/80/150ms RTT (delayMs = RTT/2, see latencysim.ts
// doc comment), some with jitter+loss, spread across the 10 clients.
const PROFILES: ReadonlyArray<{ delayMs: number; jitterMs: number; lossRate: number }> = [
  { delayMs: 15, jitterMs: 0, lossRate: 0 }, // 30ms clean
  { delayMs: 40, jitterMs: 0, lossRate: 0 }, // 80ms clean
  { delayMs: 75, jitterMs: 0, lossRate: 0 }, // 150ms clean
  { delayMs: 15, jitterMs: 10, lossRate: 0.02 },
  { delayMs: 40, jitterMs: 20, lossRate: 0.03 },
  { delayMs: 75, jitterMs: 30, lossRate: 0.05 },
  { delayMs: 15, jitterMs: 5, lossRate: 0 },
  { delayMs: 40, jitterMs: 15, lossRate: 0.02 },
  { delayMs: 75, jitterMs: 10, lossRate: 0.01 },
  { delayMs: 40, jitterMs: 10, lossRate: 0.01 },
];

function toAuthoritative(msg: SnapshotMessage): AuthoritativeSnapshot {
  return {
    serverTick: msg.serverTick,
    lastProcessedSeq: msg.lastProcessedSeq,
    players: msg.players.map((pl) => ({
      posX: pl.posX,
      posY: pl.posY,
      posZ: pl.posZ,
      velX: pl.velX,
      velY: pl.velY,
      velZ: pl.velZ,
      yaw: pl.yaw,
      pitch: pl.pitch,
      crouching: pl.crouching,
      grounded: pl.grounded,
    })),
  };
}

// Deterministic per-client wander: forward/right kept to exactly -1/0/1 (like
// a real keyboard client — the wire quantizes to i8, see messages.ts), yaw
// drifts slowly. Different phase per client index so they don't all move in
// lockstep (not that it matters for correctness — the sim has no
// player-vs-player collision — but it's a more representative load).
function wanderInput(clientIndex: number, t: number): InputFrame {
  const phase = clientIndex * 37;
  const forward = Math.sin((t + phase) * 0.023) > 0 ? 1 : -1;
  const right = Math.cos((t + phase) * 0.031) > 0 ? 1 : -1;
  const yaw = Math.sin((t + phase) * 0.007) * 1.2;
  return { forward, right, yaw, pitch: 0, jump: false, crouch: false, walk: false, fire: false };
}

describe("10-client soak (acceptance criterion 8)", () => {
  it("no crash, every bot's reconciled position matches server within 1e-3 at the end, server p95 tick time < 15.625ms", () => {
    const host = new ServerHost({ numPlayers: NUM_CLIENTS });
    const clock = createVirtualClock();

    const predictedByIndex = new Map<number, PredictedClient>();
    const lastDiffByIndex = new Map<number, number>();
    const senders: Array<(seq: number, input: InputFrame) => void> = [];
    const localIndexBySlot: number[] = [];

    for (let slot = 0; slot < NUM_CLIENTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const profile = PROFILES[slot]!;
      const clientTransport = withLatency(rawClient, { ...profile, seed: 1000 + slot, scheduler: clock.scheduler });

      clientTransport.onMessage((data) => {
        const msg = decodeMessage(data);
        if (msg.type === MessageType.Welcome) {
          const p = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES);
          predictedByIndex.set(slot, p);
          localIndexBySlot[slot] = msg.playerIndex;
        } else if (msg.type === MessageType.Snapshot) {
          const p = predictedByIndex.get(slot);
          if (p) {
            const diff = p.reconcile(toAuthoritative(msg));
            lastDiffByIndex.set(slot, diff);
          }
        }
      });

      host.connect(rawServer);
      senders.push(createScriptedInputSender(clientTransport));
    }

    for (let t = 0; t < TICKS; t++) {
      for (let slot = 0; slot < NUM_CLIENTS; slot++) {
        const predicted = predictedByIndex.get(slot);
        if (!predicted) continue;
        const input = wanderInput(slot, t);
        const seq = predicted.queueAndPredict(input);
        senders[slot]!(seq, input);
      }
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    // Settle phase: stop changing input and let any in-flight
    // messages/reconciliations drain so the "at the end" comparison isn't
    // racing the network.
    const SETTLE_TICKS = 60;
    for (let t = 0; t < SETTLE_TICKS; t++) {
      for (let slot = 0; slot < NUM_CLIENTS; slot++) {
        const predicted = predictedByIndex.get(slot);
        if (!predicted) continue;
        const input: InputFrame = { forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false };
        const seq = predicted.queueAndPredict(input);
        senders[slot]!(seq, input);
      }
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    expect(predictedByIndex.size).toBe(NUM_CLIENTS);

    for (let slot = 0; slot < NUM_CLIENTS; slot++) {
      const diff = lastDiffByIndex.get(slot);
      expect(diff, `client ${slot} never reconciled`).not.toBeUndefined();
      expect(diff!, `client ${slot} final reconciliation diff`).toBeLessThan(1e-3);
    }

    // Server per-tick sim+broadcast time p95 < 15.625ms (one fixed tick's budget).
    const durations = host.stepDurationsMs.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[Math.min(p95Index, durations.length - 1)]!;
    expect(p95).toBeLessThan(FIXED_DT * 1000);
  });
});
