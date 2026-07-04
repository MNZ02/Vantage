import { createLoopbackPair } from "@vg/protocol";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender } from "./testUtils.js";

// Acceptance criterion (reviewer finding F1): a single malformed frame from
// one client must never crash the server process, and must never disrupt
// other connected clients. Reproduces the exact byte sequences the reviewer
// used to kill a live devServer process: an unknown type tag, and a
// truncated InputBatch that claims 5 frames but supplies none.
describe("malformed input handling (blocker fix F1)", () => {
  it("survives an unknown message type tag", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [attacker, attackerServer] = createLoopbackPair();
    host.connect(attackerServer);

    expect(() => attacker.send(new Uint8Array([99, 1, 2, 3]))).not.toThrow();
    expect(() => host.step()).not.toThrow();
    expect(host.getMalformedFrameCount()).toBeGreaterThan(0);
  });

  it("survives a truncated InputBatch (claims 5 frames, supplies none)", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [attacker, attackerServer] = createLoopbackPair();
    host.connect(attackerServer);

    // type=2 (InputBatch), firstSeq=0 (4 bytes), count=5, then nothing.
    expect(() => attacker.send(new Uint8Array([2, 0, 0, 0, 0, 5]))).not.toThrow();
    expect(() => host.step()).not.toThrow();
    expect(host.getMalformedFrameCount()).toBeGreaterThan(0);
  });

  it("survives an empty frame", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [attacker, attackerServer] = createLoopbackPair();
    host.connect(attackerServer);

    expect(() => attacker.send(new Uint8Array([]))).not.toThrow();
    expect(() => host.step()).not.toThrow();
    expect(host.getMalformedFrameCount()).toBeGreaterThan(0);
  });

  it("survives an oversized/garbage frame", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [attacker, attackerServer] = createLoopbackPair();
    host.connect(attackerServer);

    const garbage = new Uint8Array(4096);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
    // Byte 0 is the type tag: force it out of the known enum range too.
    garbage[0] = 250;

    expect(() => attacker.send(garbage)).not.toThrow();
    expect(() => host.step()).not.toThrow();
    expect(host.getMalformedFrameCount()).toBeGreaterThan(0);
  });

  it("keeps ticking and keeps serving a well-behaved second client after a barrage of malformed frames", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [attacker, attackerServer] = createLoopbackPair();
    const [good, goodServer] = createLoopbackPair();
    const attackerIndex = host.connect(attackerServer);
    const goodIndex = host.connect(goodServer);
    const send = createScriptedInputSender(good);

    const malformedFrames = [
      new Uint8Array([99, 1, 2, 3]),
      new Uint8Array([2, 0, 0, 0, 0, 5]),
      new Uint8Array([]),
      new Uint8Array([5]), // Snapshot tag with nothing else
      new Uint8Array([250, 250, 250]),
    ];

    for (let i = 0; i < 100; i++) {
      const malformed = malformedFrames[i % malformedFrames.length]!;
      expect(() => attacker.send(malformed)).not.toThrow();
      send({ forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false });
      expect(() => host.step()).not.toThrow();
    }

    expect(host.getMalformedFrameCount()).toBeGreaterThanOrEqual(100);
    expect(host.isConnected(attackerIndex)).toBe(true);
    expect(host.isConnected(goodIndex)).toBe(true);

    // The well-behaved client's input was still processed: it moved forward
    // from spawn despite the attacker's barrage.
    const state = host.getState();
    const speed = Math.hypot(state.velX[goodIndex]!, state.velZ[goodIndex]!);
    expect(speed).toBeGreaterThan(0.5);
  });
});
