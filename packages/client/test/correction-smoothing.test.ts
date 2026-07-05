import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency } from "@vg/protocol";
import { FIXED_DT, LEVEL_BOXES } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { PredictedClient } from "../src/prediction.js";
import { createScriptedInputSender, idleInput, toAuthoritative } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

describe("correction smoothing (acceptance criterion 4)", () => {
  it("converges within 32 ticks after a forced server-side teleport, with no single-frame render jump > 0.5m", () => {
    const host = new ServerHost({ numPlayers: 1, seed: 99 });
    const [rawClient, rawServer] = createLoopbackPair();
    const clock = createVirtualClock();
    const clientTransport = withLatency(rawClient, { delayMs: 20, jitterMs: 0, lossRate: 0, seed: 5, scheduler: clock.scheduler });

    let predicted: PredictedClient | null = null;
    let localIndex = -1;
    const renderPositions: Array<{ x: number; y: number; z: number }> = [];
    let teleported = false;
    let ticksSinceTeleportDetected = -1;
    let correctionDetectedAt = -1;

    clientTransport.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        localIndex = msg.playerIndex;
        predicted = new PredictedClient(msg.seed, msg.numPlayers, localIndex, LEVEL_BOXES);
      } else if (msg.type === MessageType.Snapshot && predicted) {
        const diff = predicted.reconcile(toAuthoritative(msg));
        if (teleported && correctionDetectedAt === -1 && diff > 0.5) {
          correctionDetectedAt = renderPositions.length;
        }
      }
    });

    host.connect(rawServer);
    const send = createScriptedInputSender(clientTransport);

    const TELEPORT_AT_TICK = 80;
    const TELEPORT_OFFSET = { x: 1.5, y: 0, z: 0 }; // modest divergence, see prediction.ts's decay constant

    let t = 0;
    for (let i = 0; i < 400; i++) {
      if (predicted) {
        const input = idleInput();
        const { seq, quantizedInput } = predicted.queueAndPredict(input);
        send(seq, quantizedInput);
        renderPositions.push(predicted.getRenderPosition());
      }

      t++;
      clock.advance(FIXED_DT_MS);
      host.step();

      if (!teleported && host.getState().tick >= TELEPORT_AT_TICK) {
        const s = host.getState();
        s.posX[localIndex] = s.posX[localIndex]! + TELEPORT_OFFSET.x;
        s.posZ[localIndex] = s.posZ[localIndex]! + TELEPORT_OFFSET.z;
        teleported = true;
      }
    }

    expect(teleported).toBe(true);
    expect(correctionDetectedAt).toBeGreaterThan(0);

    // No single render-to-render jump > 0.5m at or after the correction is detected.
    for (let i = correctionDetectedAt + 1; i < renderPositions.length; i++) {
      const a = renderPositions[i - 1]!;
      const b = renderPositions[i]!;
      const jump = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      expect(jump).toBeLessThan(0.5);
    }

    // Converges (predicted position tracks the true post-teleport server
    // position) within 32 ticks of the correction being detected.
    const finalRender = renderPositions[renderPositions.length - 1]!;
    const finalServerX = host.getState().posX[0]!;
    const finalServerZ = host.getState().posZ[0]!;
    expect(Math.hypot(finalRender.x - finalServerX, finalRender.z - finalServerZ)).toBeLessThan(0.02);

    // Check convergence specifically within a 32-tick window of detection,
    // not just "eventually" — sample the render position 32 render-ticks
    // after correctionDetectedAt and require it to already be close.
    const at32 = renderPositions[Math.min(renderPositions.length - 1, correctionDetectedAt + 32)]!;
    // Compare against predicted's *simulated* (unsmoothed) position at that
    // same moment, which by tick 32 has already fully caught up to the
    // server (only the *rendered/smoothed* value lags).
    const simPos = predicted!.getPredictedState();
    expect(Math.hypot(at32.x - simPos.posX[0]!, at32.z - simPos.posZ[0]!)).toBeLessThan(0.02);
  });
});
