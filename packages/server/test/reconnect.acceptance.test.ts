import { createLoopbackPair, decodeMessage, MessageType, encodeMessage, NO_TOKEN, PROTOCOL_VERSION, type ProtocolMessage } from "@vg/protocol";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

function collectWelcomes(client: ReturnType<typeof createLoopbackPair>[0]): ProtocolMessage[] {
  const out: ProtocolMessage[] = [];
  client.onMessage((data) => {
    const msg = decodeMessage(data);
    if (msg.type === MessageType.Welcome) out.push(msg);
  });
  return out;
}

describe("reconnect (acceptance criterion 12)", () => {
  it("mid-round disconnect + reconnect with the correct token reattaches the same slot/team/credits on a FULL match, match keeps running", () => {
    // numPlayers === connected count: this is the realistic case (a full
    // 5v5/10p match) that stresses connect()'s "no free slot, but a Hello
    // might still be a valid reconnect" path (see awaitReconnectOrReject).
    const host = new ServerHost({ numPlayers: 2, mode: "match", minPlayers: 2, matchConfig: { buyTicks: 5, firstRoundBuyTicks: 5 } });
    const [client0, server0] = createLoopbackPair();
    const [client1, server1] = createLoopbackPair();
    const welcomes0 = collectWelcomes(client0);
    host.connect(server0);
    host.connect(server1);

    // Client 0's very first Welcome (sent at its own connect() call) can
    // predate team assignment (team is only assigned once minPlayers is
    // reached, which happens at client 1's connect() call) — connect()
    // resends a corrected Welcome to already-connected clients when that
    // happens (see ServerHost.connect()'s doc comment), so use the LATEST
    // one received for the settled team/token.
    const settledWelcome = welcomes0[welcomes0.length - 1]!;
    expect(settledWelcome.type).toBe(MessageType.Welcome);
    const originalIndex = settledWelcome.type === MessageType.Welcome ? settledWelcome.playerIndex : -1;
    const token = settledWelcome.type === MessageType.Welcome ? settledWelcome.token : NO_TOKEN;
    const originalTeam = settledWelcome.type === MessageType.Welcome ? settledWelcome.team : -1;

    host.getState().credits[originalIndex] = 4321;

    const send1 = createScriptedInputSender(client1);
    for (let i = 0; i < 20; i++) {
      send1(idleInput());
      host.step();
    }

    // Client 0 disconnects (simulated tab close/refresh).
    client0.close();
    expect(host.isConnected(originalIndex)).toBe(false);

    // Match keeps running while the slot is held.
    for (let i = 0; i < 30; i++) {
      send1(idleInput());
      host.step();
    }

    // Reconnect: new transport. The match is full (both slots occupied: 1
    // connected + 1 held), so connect() can't hand out a fresh slot — it
    // returns -1 and waits for this transport's first Hello to decide.
    const [client0b, server0b] = createLoopbackPair();
    const welcomesB = collectWelcomes(client0b);
    const pendingIndex = host.connect(server0b);
    expect(pendingIndex).toBe(-1);
    client0b.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: token }));
    host.step();

    expect(welcomesB.length).toBe(1);
    const reattachWelcome = welcomesB[0]!;
    expect(reattachWelcome.type).toBe(MessageType.Welcome);
    if (reattachWelcome.type === MessageType.Welcome) {
      expect(reattachWelcome.playerIndex).toBe(originalIndex);
      expect(reattachWelcome.team).toBe(originalTeam);
      expect(Array.from(reattachWelcome.token)).toEqual(Array.from(token));
    }
    expect(host.isConnected(originalIndex)).toBe(true);
    expect(host.getState().credits[originalIndex]).toBe(4321); // continuity: credits untouched by the disconnect/reconnect

    // Match never paused: ticks kept advancing the whole time.
    expect(host.getState().tick).toBeGreaterThan(0);
  });

  it("with spare capacity, a reconnect attempt presenting no token is treated as a fresh join onto a different slot", () => {
    const host = new ServerHost({ numPlayers: 4, mode: "match", minPlayers: 3 });
    const [client0, server0] = createLoopbackPair();
    const [, server1] = createLoopbackPair();
    const [, server2] = createLoopbackPair();
    const idx0 = host.connect(server0);
    host.connect(server1);
    host.connect(server2); // match starts here (minPlayers=3); slot 3 stays free

    client0.close();
    expect(host.isConnected(idx0)).toBe(false);

    const [client0b, server0b] = createLoopbackPair();
    const welcomesB = collectWelcomes(client0b);
    const newIndex = host.connect(server0b); // no Hello with a token ever sent; a free slot (3) exists

    expect(newIndex).not.toBe(-1);
    expect(newIndex).not.toBe(idx0); // held slot stays reserved, untouched by a fresh join
    expect(welcomesB.length).toBe(1);
  });

  it("with spare capacity, closing a token-reattached transport disconnects the restored slot rather than its provisional slot", () => {
    const host = new ServerHost({ numPlayers: 3, mode: "match", minPlayers: 2 });
    const [client0, server0] = createLoopbackPair();
    const welcomes0 = collectWelcomes(client0);
    host.connect(server0);
    const [, server1] = createLoopbackPair();
    host.connect(server1);

    const welcome = welcomes0[welcomes0.length - 1]!;
    expect(welcome.type).toBe(MessageType.Welcome);
    if (welcome.type !== MessageType.Welcome) throw new Error("expected Welcome");
    const originalIndex = welcome.playerIndex;
    client0.close();

    const [reconnectedClient, reconnectedServer] = createLoopbackPair();
    const provisionalIndex = host.connect(reconnectedServer);
    expect(provisionalIndex).not.toBe(originalIndex);
    reconnectedClient.send(
      encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: welcome.token }),
    );
    expect(host.isConnected(originalIndex)).toBe(true);

    reconnectedClient.close();
    expect(host.isConnected(originalIndex)).toBe(false);
    expect(host.isConnected(provisionalIndex)).toBe(false);
  });

  it("on a full match, a connect attempt with no valid token is rejected (connection closed), never silently granted a slot", () => {
    const host = new ServerHost({ numPlayers: 3, mode: "match", minPlayers: 3 });
    const [, server0] = createLoopbackPair();
    const [, server1] = createLoopbackPair();
    const [, server2] = createLoopbackPair();
    host.connect(server0);
    host.connect(server1);
    host.connect(server2); // all 3 slots now occupied

    const [strangerClient, strangerServer] = createLoopbackPair();
    let closed = false;
    strangerClient.onClose(() => {
      closed = true;
    });
    const pendingIndex = host.connect(strangerServer);
    expect(pendingIndex).toBe(-1);

    strangerClient.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: NO_TOKEN }));
    host.step();
    expect(closed).toBe(true);
  });

  it("an expired hold frees the slot for a brand-new join", async () => {
    const host = new ServerHost({ numPlayers: 2, mode: "match", minPlayers: 2, reconnectHoldMs: 20 });
    const [client0, server0] = createLoopbackPair();
    const [, server1] = createLoopbackPair();
    const idx0 = host.connect(server0);
    host.connect(server1);

    client0.close();
    expect(host.isConnected(idx0)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 40));

    // Slot is now free (hold expired), but the match is still nominally
    // "full" capacity-wise with only 1 other connected — connect() should
    // hand out the freed slot synchronously, same as any fresh join.
    const [, server0b] = createLoopbackPair();
    const rejoinIndex = host.connect(server0b);
    expect(rejoinIndex).toBe(idx0); // the expired hold freed the slot back up
  });

  it("DM mode keeps M2 behavior: disconnect frees the slot immediately, no hold", () => {
    const host = new ServerHost({ numPlayers: 1 }); // default mode: dm
    const [client0, server0] = createLoopbackPair();
    const idx0 = host.connect(server0);
    client0.close();
    expect(host.isConnected(idx0)).toBe(false);
    const [, server0b] = createLoopbackPair();
    expect(host.connect(server0b)).toBe(idx0); // immediately reusable, no reconnect token dance
  });
});
