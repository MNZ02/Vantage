import { createPrngState, nextRandom } from "@vg/sim";
import { describe, expect, it } from "vitest";
import {
  MessageType,
  decodeMessage,
  decodeMessageSafely,
  encodeMessage,
  type InputSample,
  type ProtocolMessage,
  type SnapshotDroppedWeapon,
  type SnapshotPlayer,
} from "../src/messages.js";

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
      expect(a.viewTick).toBe(bb.viewTick);
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
        expect(f.ads).toBe(g.ads);
        expect(f.reload).toBe(g.reload);
        expect(f.slot1).toBe(g.slot1);
        expect(f.slot2).toBe(g.slot2);
      });
      break;
    }
    case MessageType.BuyCmd: {
      const bb = b as typeof a;
      expect(a.itemId).toBe(bb.itemId);
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
        expect(p.alive).toBe(q.alive);
        expect(p.activeSlot).toBe(q.activeSlot);
        expect(p.adsStage).toBe(q.adsStage);
        expect(p.health).toBe(q.health);
        expect(p.armor).toBe(q.armor);
        expect(p.weaponPrimary).toBe(q.weaponPrimary);
        expect(p.weaponSecondary).toBe(q.weaponSecondary);
        expect(p.magActive).toBe(q.magActive);
        expect(p.reserveActive).toBe(q.reserveActive);
        expect(p.tagTicksLeft).toBe(q.tagTicksLeft);
        expect(p.credits).toBe(q.credits);
        expect(p.respawnTicksLeft).toBe(q.respawnTicksLeft);
      });
      expect(a.droppedWeapons.length).toBe(bb.droppedWeapons.length);
      a.droppedWeapons.forEach((d, i) => {
        const e = bb.droppedWeapons[i]!;
        expect(d.id).toBe(e.id);
        expect(d.weaponId).toBe(e.weaponId);
        expect(approxEqual(d.x, e.x)).toBe(true);
        expect(approxEqual(d.y, e.y)).toBe(true);
        expect(approxEqual(d.z, e.z)).toBe(true);
        expect(d.mag).toBe(e.mag);
      });
      break;
    }
    case MessageType.KillEvent: {
      const bb = b as typeof a;
      expect(a.killerIndex).toBe(bb.killerIndex);
      expect(a.victimIndex).toBe(bb.victimIndex);
      expect(a.weaponId).toBe(bb.weaponId);
      expect(a.headshot).toBe(bb.headshot);
      expect(a.assistIndex).toBe(bb.assistIndex);
      break;
    }
    case MessageType.HitConfirm: {
      const bb = b as typeof a;
      expect(a.shooterIndex).toBe(bb.shooterIndex);
      expect(a.targetIndex).toBe(bb.targetIndex);
      expect(a.damage).toBe(bb.damage);
      expect(a.region).toBe(bb.region);
      expect(a.targetHealthAfter).toBe(bb.targetHealthAfter);
      break;
    }
    case MessageType.DamageTaken: {
      const bb = b as typeof a;
      expect(a.victimIndex).toBe(bb.victimIndex);
      expect(a.attackerIndex).toBe(bb.attackerIndex);
      expect(a.damage).toBe(bb.damage);
      break;
    }
  }
}

function sampleInput(overrides: Partial<InputSample> = {}): InputSample {
  return {
    forward: 1,
    right: -1,
    yaw: 1.2345,
    pitch: -0.4,
    jump: true,
    crouch: false,
    walk: true,
    fire: false,
    ads: true,
    reload: false,
    slot1: false,
    slot2: true,
    ...overrides,
  };
}

function samplePlayer(overrides: Partial<SnapshotPlayer> = {}): SnapshotPlayer {
  return {
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
    alive: true,
    activeSlot: 0,
    adsStage: 2,
    health: 87,
    armor: 50,
    weaponPrimary: 3,
    weaponSecondary: 0,
    magActive: 25,
    reserveActive: 90,
    tagTicksLeft: 12,
    credits: 4200,
    respawnTicksLeft: 0,
    ...overrides,
  };
}

function sampleDrop(overrides: Partial<SnapshotDroppedWeapon> = {}): SnapshotDroppedWeapon {
  return { id: 3, weaponId: 4, x: 1, y: 0, z: 2, mag: 17, ...overrides };
}

describe("protocol message round-trip", () => {
  it("Hello", () => {
    const msg: ProtocolMessage = { type: MessageType.Hello, protocolVersion: 2 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("InputBatch with redundant frames and viewTick", () => {
    const frames: InputSample[] = [
      sampleInput({ jump: true, crouch: false, walk: true, fire: false }),
      sampleInput({ forward: 0, right: 0, jump: false, fire: true, ads: false, reload: true }),
      sampleInput({ forward: -1, right: 1, crouch: true, slot1: true, slot2: false }),
    ];
    const msg: ProtocolMessage = { type: MessageType.InputBatch, firstSeq: 99, viewTick: 4321, frames };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("BuyCmd", () => {
    const msg: ProtocolMessage = { type: MessageType.BuyCmd, itemId: 201 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Welcome", () => {
    const msg: ProtocolMessage = { type: MessageType.Welcome, playerIndex: 3, seed: 424242, numPlayers: 10, serverTick: 555 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot with several players and dropped weapons", () => {
    const players: SnapshotPlayer[] = [
      samplePlayer(),
      samplePlayer({
        posX: -10,
        posY: 2.2,
        posZ: 0,
        crouching: true,
        grounded: false,
        alive: false,
        activeSlot: 1,
        adsStage: 0,
        respawnTicksLeft: 120,
      }),
    ];
    const droppedWeapons: SnapshotDroppedWeapon[] = [sampleDrop(), sampleDrop({ id: 9, weaponId: 5, x: -5, y: 0, z: 10, mag: 5 })];
    const msg: ProtocolMessage = { type: MessageType.Snapshot, serverTick: 1000, lastProcessedSeq: 998, players, droppedWeapons };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot clamps credits to 9000 and huge tagTicksLeft/respawnTicksLeft to 255 on the wire", () => {
    const players: SnapshotPlayer[] = [samplePlayer({ credits: 50000, tagTicksLeft: 9999, respawnTicksLeft: 9999 })];
    const msg: ProtocolMessage = { type: MessageType.Snapshot, serverTick: 1, lastProcessedSeq: 0, players, droppedWeapons: [] };
    const decoded = decodeMessage(encodeMessage(msg));
    if (decoded.type === MessageType.Snapshot) {
      expect(decoded.players[0]!.credits).toBe(9000);
      expect(decoded.players[0]!.tagTicksLeft).toBe(255);
      expect(decoded.players[0]!.respawnTicksLeft).toBe(255);
    } else {
      throw new Error("expected Snapshot");
    }
  });

  it("KillEvent", () => {
    const msg: ProtocolMessage = { type: MessageType.KillEvent, killerIndex: 2, victimIndex: 7, weaponId: 3, headshot: true, assistIndex: 255 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("HitConfirm", () => {
    const msg: ProtocolMessage = { type: MessageType.HitConfirm, shooterIndex: 1, targetIndex: 4, damage: 160, region: 0, targetHealthAfter: 0 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("DamageTaken", () => {
    const msg: ProtocolMessage = { type: MessageType.DamageTaken, victimIndex: 4, attackerIndex: 1, damage: 40 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });
});

describe("protocol message fuzz round-trip", () => {
  it("round-trips >= 1000 random messages of all types exactly (f32 tolerance)", () => {
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
      const kind = randInt(8);
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
              ads: randBool(),
              reload: randBool(),
              slot1: randBool(),
              slot2: randBool(),
            });
          }
          return { type: MessageType.InputBatch, firstSeq: randInt(2 ** 31), viewTick: randInt(2 ** 31), frames };
        }
        case 2:
          return { type: MessageType.BuyCmd, itemId: randInt(256) };
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
              alive: randBool(),
              activeSlot: randInt(2),
              adsStage: randInt(3),
              health: randInt(256),
              armor: randInt(256),
              weaponPrimary: randInt(256),
              weaponSecondary: randInt(256),
              magActive: randInt(65536),
              reserveActive: randInt(65536),
              tagTicksLeft: randInt(256),
              credits: randInt(9001),
              respawnTicksLeft: randInt(256),
            });
          }
          const dropCount = randInt(5);
          const droppedWeapons: SnapshotDroppedWeapon[] = [];
          for (let i = 0; i < dropCount; i++) {
            droppedWeapons.push({
              id: randInt(256),
              weaponId: randInt(256),
              x: randF32(),
              y: randF32(),
              z: randF32(),
              mag: randInt(65536),
            });
          }
          return {
            type: MessageType.Snapshot,
            serverTick: randInt(2 ** 31),
            lastProcessedSeq: randInt(2 ** 31),
            players,
            droppedWeapons,
          };
        }
        case 5:
          return {
            type: MessageType.KillEvent,
            killerIndex: randInt(16),
            victimIndex: randInt(16),
            weaponId: randInt(256),
            headshot: randBool(),
            assistIndex: randInt(256),
          };
        case 6:
          return {
            type: MessageType.HitConfirm,
            shooterIndex: randInt(16),
            targetIndex: randInt(16),
            damage: randInt(65536),
            region: randInt(3),
            targetHealthAfter: randInt(256),
          };
        default:
          return {
            type: MessageType.DamageTaken,
            victimIndex: randInt(16),
            attackerIndex: randInt(16),
            damage: randInt(65536),
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

describe("malformed-frame safety for new/changed messages", () => {
  it("drops a truncated BuyCmd (no itemId byte)", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.BuyCmd]))).toBeNull();
  });

  it("drops a truncated InputBatch missing the new viewTick field", () => {
    // type=2, firstSeq (4 bytes) but nothing else (no viewTick, no count).
    expect(decodeMessageSafely(new Uint8Array([MessageType.InputBatch, 0, 0, 0, 0]))).toBeNull();
  });

  it("drops a Snapshot truncated mid-player (missing the new combat fields)", () => {
    const full = encodeMessage({
      type: MessageType.Snapshot,
      serverTick: 1,
      lastProcessedSeq: 1,
      players: [samplePlayer()],
      droppedWeapons: [],
    });
    // Cut off partway through the first player's record.
    const truncated = full.slice(0, full.length - 10);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });

  it("drops a Snapshot truncated inside the droppedWeapons list", () => {
    const full = encodeMessage({
      type: MessageType.Snapshot,
      serverTick: 1,
      lastProcessedSeq: 1,
      players: [],
      droppedWeapons: [sampleDrop()],
    });
    const truncated = full.slice(0, full.length - 3);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });

  it("drops a truncated KillEvent/HitConfirm/DamageTaken", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.KillEvent, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.HitConfirm, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.DamageTaken, 1]))).toBeNull();
  });

  it("drops the removed FireCmd tag (3) if it now decodes as BuyCmd-shaped garbage without throwing", () => {
    // Tag 3 is now BuyCmd (u8 itemId); feeding it FireCmd's old 8-byte body
    // must still decode safely (extra trailing bytes are simply unread) —
    // never throw past the boundary regardless of stale-client payloads.
    expect(() => decodeMessageSafely(new Uint8Array([3, 1, 2, 3, 4, 5, 6, 7, 8]))).not.toThrow();
  });

  it("still handles a fully unknown type tag and an empty frame", () => {
    expect(decodeMessageSafely(new Uint8Array([250, 1, 2, 3]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([]))).toBeNull();
  });
});
