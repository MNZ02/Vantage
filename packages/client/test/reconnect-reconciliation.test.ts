import { MessageType, NO_TOKEN, PROTOCOL_VERSION, createLoopbackPair, decodeMessage, encodeMessage } from "@vg/protocol";
import { LEVEL_BOXES, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { PredictedClient } from "../src/prediction.js";
import { createScriptedInputSender, idleInput, observePrediction, toAuthoritative } from "./testUtils.js";

// Acceptance criterion 12 (reconnect) / 13 (prediction exactness): after a
// mid-match disconnect and a token-carrying reattach, the client's own
// PredictedClient must re-converge with the server, not just "eventually
// look right" — reconcile()'s reported diff must fall back under the same
// 1e-3 fallback-reconciliation bound the spec calls out, within 64 ticks of
// the tick jump the reattach introduces (server keeps advancing the whole
// time the client is disconnected).
describe("reconnect reconciliation re-convergence (acceptance criterion 12)", () => {
  it("re-converges to <1e-3 within 64 ticks of reattaching with the saved token", () => {
    const host = new ServerHost({
      numPlayers: 2,
      mode: "match",
      minPlayers: 2,
      seed: 55,
      matchConfig: { buyTicks: 20, firstRoundBuyTicks: 20, roundTicks: 5000 },
    });
    const [client0, server0] = createLoopbackPair();
    const [, server1] = createLoopbackPair();

    let predicted: PredictedClient | null = null;
    let localIndex = -1;
    let token = NO_TOKEN;

    client0.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        localIndex = msg.playerIndex;
        token = msg.token;
        if (!predicted) predicted = new PredictedClient(msg.seed, msg.numPlayers, localIndex, LEVEL_BOXES, msg.mode);
      } else if (msg.type === MessageType.Snapshot && predicted) {
        predicted.reconcile(toAuthoritative(msg));
      }
    });

    host.connect(server0);
    host.connect(server1);
    const send = createScriptedInputSender(client0);

    // Build up some real, non-trivial state before disconnecting.
    for (let t = 0; t < 100; t++) {
      const active = observePrediction(predicted);
      if (active) {
        const input: InputFrame = { ...idleInput((t * 0.02) % 1), forward: 1, right: t % 20 < 10 ? 1 : -1 };
        const { seq, quantizedInput } = active.queueAndPredict(input);
        send(seq, quantizedInput, t);
      }
      host.step();
    }

    expect(predicted).not.toBeNull();
    expect(localIndex).toBeGreaterThanOrEqual(0);
    const creditsBeforeDisconnect = host.getState().credits[localIndex]!;

    // Disconnect (simulated tab close/refresh) — the slot is HELD (match
    // mode), and the server keeps ticking without this client the whole time.
    client0.close();
    expect(host.isConnected(localIndex)).toBe(false);
    for (let t = 0; t < 50; t++) host.step();

    // Reconnect: a brand-new transport (post-refresh), Hello with the saved token.
    const [client0b, server0b] = createLoopbackPair();
    const diffs: number[] = [];
    client0b.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        localIndex = msg.playerIndex; // must be the SAME slot
      } else if (msg.type === MessageType.Snapshot && predicted) {
        diffs.push(predicted.reconcile(toAuthoritative(msg)));
      }
    });
    const pendingIndex = host.connect(server0b);
    expect(pendingIndex).toBe(-1); // match is full (2/2) — awaits the Hello below, see ServerHost.connect()
    client0b.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: token }));
    host.step();
    expect(host.isConnected(localIndex)).toBe(true);
    expect(host.getState().credits[localIndex]).toBe(creditsBeforeDisconnect); // continuity through the reconnect

    // Resume sending input on the new connection for 64 ticks (the tick-jump
    // window the reattach introduced) and confirm reconciliation converges.
    const send2 = createScriptedInputSender(client0b);
    for (let t = 0; t < 64; t++) {
      const input: InputFrame = idleInput(0);
      const { seq, quantizedInput } = predicted!.queueAndPredict(input);
      send2(seq, quantizedInput, t);
      host.step();
    }

    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs[diffs.length - 1]).toBeLessThan(1e-3);
  });
});
