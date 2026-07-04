import { createPrngState, nextRandom } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { MessageType, decodeMessage, encodeMessage, type InputSample, type ProtocolMessage, type SnapshotPlayer } from "../src/messages.js";

function approxEqual(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

function expectMessagesEqual(a: ProtocolMessage, b: ProtocolMessage): void {
  expect(a.type).toBe(b.type);
  switch (a.type) {
    case MessageType.Hello: {
      const bb = b as typeof a;
      expect(a.protocolVersion).toBe(bb.protocolVersion);
      break;
    }
    case MessageType.InputBatch: {
      const bb = b as typeof a;
      expect(a.firstSeq).toBe(bb.firstSeq);
      expect(a.frames.length).toBe(bb.frames.length);
      a.frames.forEach((f, i) => {
        const g = bb.frames[i]!;
        expect(f.forward).toBe(g.forward);
        expect(f.right).toBe(g.right);
        expect(approxEqual(f.yaw, g.yaw)).toBe(true);
        expect(approxEqual(f.pitch, g.pitch)).toBe(true);
        expect(f.jump).toBe(g.jump);
        expect(f.crouch).toBe(g.crouch);
        expect(f.walk).toBe(g.walk);
        expect(f.fire).toBe(g.fire);
      });
      break;
    }
    case MessageType.FireCmd: {
      const bb = b as typeof a;
      expect(a.seq).toBe(bb.seq);
      expect(a.viewTick).toBe(bb.viewTick);
      break;
    }
    case MessageType.Welcome: {
      const bb = b as typeof a;
      expect(a.playerIndex).toBe(bb.playerIndex);
      expect(a.seed).toBe(bb.seed);
      expect(a.numPlayers).toBe(bb.numPlayers);
      expect(a.serverTick).toBe(bb.serverTick);
      break;
    }
    case MessageType.Snapshot: {
      const bb = b as typeof a;
      expect(a.serverTick).toBe(bb.serverTick);
      expect(a.lastProcessedSeq).toBe(bb.lastProcessedSeq);
      expect(a.players.length).toBe(bb.players.length);
      a.players.forEach((p, i) => {
        const q = bb.players[i]!;
        for (const key of ["posX", "posY", "posZ", "velX", "velY", "velZ", "yaw", "pitch"] as const) {
          expect(approxEqual(p[key], q[key])).toBe(true);
        }
        expect(p.crouching).toBe(q.crouching);
        expect(p.grounded).toBe(q.grounded);
        expect(p.connected).toBe(q.connected);
      });
      break;
    }
    case MessageType.HitEvent: {
      const bb = b as typeof a;
      expect(a.shooterIndex).toBe(bb.shooterIndex);
      expect(a.targetIndex).toBe(bb.targetIndex);
      expect(a.serverTick).toBe(bb.serverTick);
      break;
    }
  }
}

describe("protocol message round-trip", () => {
  it("Hello", () => {
    const msg: ProtocolMessage = { type: MessageType.Hello, protocolVersion: 1 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("InputBatch with redundant frames", () => {
    const frames: InputSample[] = [
      { forward: 1, right: -1, yaw: 1.2345, pitch: -0.4, jump: true, crouch: false, walk: true, fire: false },
      { forward: 0, right: 0, yaw: 1.23, pitch: -0.39, jump: false, crouch: false, walk: true, fire: true },
      { forward: -1, right: 1, yaw: 1.22, pitch: -0.38, jump: false, crouch: true, walk: false, fire: false },
    ];
    const msg: ProtocolMessage = { type: MessageType.InputBatch, firstSeq: 99, frames };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("FireCmd", () => {
    const msg: ProtocolMessage = { type: MessageType.FireCmd, seq: 12345, viewTick: 6789 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Welcome", () => {
    const msg: ProtocolMessage = { type: MessageType.Welcome, playerIndex: 3, seed: 424242, numPlayers: 10, serverTick: 555 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot with several players", () => {
    const players: SnapshotPlayer[] = [
      {
        posX: 1.5,
        posY: 0,
        posZ: -3.25,
        velX: 6.7,
        velY: 0,
        velZ: -1.1,
        yaw: 0.5,
        pitch: 0.1,
        crouching: false,
        grounded: true,
        connected: true,
      },
      {
        posX: -10,
        posY: 2.2,
        posZ: 0,
        velX: 0,
        velY: -3.3,
        velZ: 0,
        yaw: -1.5,
        pitch: -0.2,
        crouching: true,
        grounded: false,
        connected: true,
      },
    ];
    const msg: ProtocolMessage = { type: MessageType.Snapshot, serverTick: 1000, lastProcessedSeq: 998, players };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("HitEvent", () => {
    const msg: ProtocolMessage = { type: MessageType.HitEvent, shooterIndex: 2, targetIndex: 7, serverTick: 42 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });
});

describe("protocol message fuzz round-trip", () => {
  it("round-trips >= 1000 random messages of random types exactly (f32 tolerance)", () => {
    let state = createPrngState(20260704);
    function rand(): number {
      const r = nextRandom(state);
      state = r.nextState;
      return r.value;
    }
    function randInt(max: number): number {
      return Math.floor(rand() * max);
    }
    function randF32(range = 1000): number {
      // round-trip through Float32Array so the "expected" value is already
      // f32-precision — the wire format is exact at f32 precision, not f64.
      const f = new Float32Array(1);
      f[0] = (rand() * 2 - 1) * range;
      return f[0]!;
    }
    function randBool(): boolean {
      return rand() < 0.5;
    }
    function randAxis(): number {
      return randInt(3) - 1; // -1, 0, 1 (exact wire representation)
    }

    function randomMessage(): ProtocolMessage {
      const kind = randInt(6);
      switch (kind) {
        case 0:
          return { type: MessageType.Hello, protocolVersion: randInt(256) };
        case 1: {
          const count = 1 + randInt(3);
          const frames: InputSample[] = [];
          for (let i = 0; i < count; i++) {
            frames.push({
              forward: randAxis(),
              right: randAxis(),
              yaw: randF32(Math.PI * 4),
              pitch: randF32(Math.PI),
              jump: randBool(),
              crouch: randBool(),
              walk: randBool(),
              fire: randBool(),
            });
          }
          return { type: MessageType.InputBatch, firstSeq: randInt(2 ** 31), frames };
        }
        case 2:
          return { type: MessageType.FireCmd, seq: randInt(2 ** 31), viewTick: randInt(2 ** 31) };
        case 3:
          return {
            type: MessageType.Welcome,
            playerIndex: randInt(16),
            seed: randInt(2 ** 31),
            numPlayers: 1 + randInt(16),
            serverTick: randInt(2 ** 31),
          };
        case 4: {
          const count = randInt(16);
          const players: SnapshotPlayer[] = [];
          for (let i = 0; i < count; i++) {
            players.push({
              posX: randF32(),
              posY: randF32(),
              posZ: randF32(),
              velX: randF32(20),
              velY: randF32(20),
              velZ: randF32(20),
              yaw: randF32(Math.PI * 4),
              pitch: randF32(Math.PI),
              crouching: randBool(),
              grounded: randBool(),
              connected: randBool(),
            });
          }
          return {
            type: MessageType.Snapshot,
            serverTick: randInt(2 ** 31),
            lastProcessedSeq: randInt(2 ** 31),
            players,
          };
        }
        default:
          return {
            type: MessageType.HitEvent,
            shooterIndex: randInt(16),
            targetIndex: randInt(16),
            serverTick: randInt(2 ** 31),
          };
      }
    }

    for (let i = 0; i < 1000; i++) {
      const msg = randomMessage();
      const decoded = decodeMessage(encodeMessage(msg));
      expectMessagesEqual(decoded, msg);
    }
  });
});
