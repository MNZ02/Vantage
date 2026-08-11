import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency } from "@vg/protocol";
import { FIXED_DT, LEVEL_BOXES, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { PredictedClient } from "../src/prediction.js";
import { createScriptedInputSender, observePrediction, toAuthoritative } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

// Bounded, deterministic-but-non-trivial scripted movement — stays near spawn
// so it never wanders into the graybox's ramp/walls during a long
// warmup+measurement run. forward/right are kept to exactly -1/0/1 (like a
// real keyboard-driven client — see input.ts's buildInputFrame, which never
// produces anything else): the wire protocol quantizes forward/right to i8
// -1/0/1 (see @vg/protocol messages.ts), so an analog/fractional scripted
// input would legitimately diverge between local (float) prediction and what
// the server actually consumes (quantized) — that's a test-input concern,
// not a reconciliation bug.
function scriptedInput(t: number): InputFrame {
  return {
    forward: Math.sin(t * 0.05) > 0 ? 1 : -1,
    right: Math.cos(t * 0.07) > 0 ? 1 : -1,
    yaw: Math.sin(t * 0.013) * 0.5,
    pitch: Math.sin(t * 0.011) * 0.2,
    jump: false,
    crouch: t % 300 < 40,
    walk: false,
    fire: false,
    ads: false,
    reload: false,
    slot1: false,
    slot2: false,
  };
}

describe("reconciliation correctness (acceptance criterion 3)", () => {
  it("reconciled local-player position matches the server's authoritative position within 4e-6 (f32 wire ULP at map scale) after a 2s warmup, at 80ms symmetric RTT with no jitter/loss", () => {
    const host = new ServerHost({ numPlayers: 1, seed: 4242 });
    const [rawClient, rawServer] = createLoopbackPair();
    const clock = createVirtualClock();
    const clientTransport = withLatency(rawClient, { delayMs: 40, jitterMs: 0, lossRate: 0, seed: 1, scheduler: clock.scheduler });

    let predicted: PredictedClient | null = null;
    let localIndex = -1;
    const diffs: number[] = [];
    const WARMUP_TICKS = 128; // 2s @ 64Hz

    clientTransport.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        localIndex = msg.playerIndex;
        predicted = new PredictedClient(msg.seed, msg.numPlayers, localIndex, LEVEL_BOXES);
      } else if (msg.type === MessageType.Snapshot && predicted) {
        const diff = predicted.reconcile(toAuthoritative(msg));
        if (msg.serverTick > WARMUP_TICKS) diffs.push(diff);
      }
    });

    host.connect(rawServer);
    const send = createScriptedInputSender(clientTransport);

    const TOTAL_TICKS = WARMUP_TICKS + 128;
    let t = 0;
    for (let i = 0; i < TOTAL_TICKS; i++) {
      // Client side: build + predict + send this tick's input, once the
      // local predicted sim exists (i.e. once Welcome has arrived) — before
      // that there's nothing to predict or buffer against yet.
      const active = observePrediction(predicted);
      if (active) {
        const input = scriptedInput(t);
        const { seq, quantizedInput } = active.queueAndPredict(input);
        send(seq, quantizedInput);
      }
      t++;
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    expect(predicted).not.toBeNull();
    expect(diffs.length).toBeGreaterThan(20);
    for (const d of diffs) {
      expect(d).toBeLessThan(4e-6); // f32 ULP is ~3.8e-6 at |coord| up to 36 m (Crossing v2 map half-extent), so wire quantization alone can produce ~1e-6 diffs
    }
  });
});
