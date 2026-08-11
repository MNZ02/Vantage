import { createLoopbackPair, decodeMessage, MessageType, type ProtocolMessage, type WelcomeMessage } from "@vg/protocol";
import { RUN_SPEED } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender } from "./testUtils.js";

describe("ServerHost connect/disconnect", () => {
  it("sends a Welcome with the assigned player index and seed on connect", () => {
    const host = new ServerHost({ seed: 777, numPlayers: 4 });
    const [clientSide, serverSide] = createLoopbackPair();
    const messages: ProtocolMessage[] = [];
    clientSide.onMessage((data) => {
      messages.push(decodeMessage(data));
    });
    const index = host.connect(serverSide);
    expect(index).toBe(0);
    const welcome = messages.find((message): message is WelcomeMessage => message.type === MessageType.Welcome);
    expect(welcome).toBeDefined();
    expect(welcome!.seed).toBe(777);
    expect(welcome!.numPlayers).toBe(4);
    expect(welcome!.playerIndex).toBe(0);
  });

  it("assigns the lowest free slot and frees it again on disconnect", () => {
    const host = new ServerHost({ numPlayers: 3 });
    const [, s0] = createLoopbackPair();
    const [, s1] = createLoopbackPair();
    const [, s2] = createLoopbackPair();
    expect(host.connect(s0)).toBe(0);
    expect(host.connect(s1)).toBe(1);
    s1.close(); // triggers onClose -> disconnect(1)
    expect(host.isConnected(1)).toBe(false);
    expect(host.connect(s2)).toBe(1); // slot 1 reused
  });

  it("throws once all slots are full", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [, s0] = createLoopbackPair();
    const [, s1] = createLoopbackPair();
    host.connect(s0);
    expect(() => host.connect(s1)).toThrow();
  });
});

describe("ServerHost step()", () => {
  it("moves a connected player's input toward run speed over many ticks", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    host.connect(server);
    const send = createScriptedInputSender(client);

    // Kept short enough that the player never reaches the graybox's ramp/walls
    // (spawn is open floor for a good ~15m in every direction) — this test is
    // about jitter-buffer-fed input reaching movement, not level traversal.
    for (let i = 0; i < 100; i++) {
      send({ forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false, ads: false, reload: false, slot1: false, slot2: false });
      host.step();
    }

    const state = host.getState();
    const speed = Math.hypot(state.velX[0]!, state.velZ[0]!);
    expect(speed).toBeGreaterThan(RUN_SPEED - 0.05);
    expect(speed).toBeLessThan(RUN_SPEED + 0.05);
  });

  it("broadcasts a Snapshot every 2nd tick with the receiving client's lastProcessedSeq", () => {
    const host = new ServerHost({ numPlayers: 1, snapshotEveryNTicks: 2 });
    const [client, server] = createLoopbackPair();
    host.connect(server);
    const send = createScriptedInputSender(client);

    const snapshots: Array<{ serverTick: number; lastProcessedSeq: number }> = [];
    client.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Snapshot) snapshots.push({ serverTick: msg.serverTick, lastProcessedSeq: msg.lastProcessedSeq });
    });

    for (let i = 0; i < 20; i++) {
      send({ forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false, ads: false, reload: false, slot1: false, slot2: false });
      host.step();
    }

    expect(snapshots.length).toBeGreaterThan(5);
    for (const s of snapshots) {
      expect(s.serverTick % 2).toBe(0);
    }
    // lastProcessedSeq should climb roughly with ticks as inputs are consumed
    expect(snapshots[snapshots.length - 1]!.lastProcessedSeq).toBeGreaterThan(0);
  });

  it("freezes a disconnected player's position instead of continuing to move it", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [client0, server0] = createLoopbackPair();
    const [, server1] = createLoopbackPair();
    host.connect(server0);
    host.connect(server1);
    const send = createScriptedInputSender(client0);

    for (let i = 0; i < 50; i++) {
      send({ forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false, ads: false, reload: false, slot1: false, slot2: false });
      host.step();
    }
    server1.close();
    const frozenX = host.getState().posX[1]!;
    const frozenZ = host.getState().posZ[1]!;
    for (let i = 0; i < 50; i++) {
      send({ forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false, ads: false, reload: false, slot1: false, slot2: false });
      host.step();
    }
    expect(host.getState().posX[1]!).toBe(frozenX);
    expect(host.getState().posZ[1]!).toBe(frozenZ);
  });
});
