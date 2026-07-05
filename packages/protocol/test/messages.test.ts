import { createPrngState, nextRandom } from "@vg/sim";
import { describe, expect, it } from "vitest";
import {
  MessageType,
  NO_TOKEN,
  PROTOCOL_VERSION,
  TOKEN_LENGTH,
  decodeMessage,
  decodeMessageSafely,
  encodeMessage,
  type InputSample,
  type ProtocolMessage,
  type SnapshotAbilityEntity,
  type SnapshotDroppedWeapon,
  type SnapshotPlayer,
} from "../src/messages.js";

function approxEqual(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

function tokenBytes(seed: number): Uint8Array {
  const out = new Uint8Array(TOKEN_LENGTH);
  for (let i = 0; i < TOKEN_LENGTH; i++) out[i] = (seed + i * 7) & 0xff;
  return out;
}

function expectMessagesEqual(a: ProtocolMessage, b: ProtocolMessage): void {
  expect(a.type).toBe(b.type);
  switch (a.type) {
    case MessageType.Hello: {
      const bb = b as typeof a;
      expect(a.protocolVersion).toBe(bb.protocolVersion);
      expect(Array.from(a.reconnectToken)).toEqual(Array.from(bb.reconnectToken));
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
        expect(f.interact).toBe(g.interact);
        expect(f.ping).toBe(g.ping);
        expect(f.ability1).toBe(g.ability1);
        expect(f.ability2).toBe(g.ability2);
        expect(f.signature).toBe(g.signature);
        expect(f.ult).toBe(g.ult);
      });
      break;
    }
    case MessageType.BuyCmd: {
      const bb = b as typeof a;
      expect(a.itemId).toBe(bb.itemId);
      break;
    }
    case MessageType.SellCmd: {
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
      expect(Array.from(a.token)).toEqual(Array.from(bb.token));
      expect(a.team).toBe(bb.team);
      expect(a.mode).toBe(bb.mode);
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
        expect(p.team).toBe(q.team);
        expect(p.agentId).toBe(q.agentId);
        expect(p.ultPoints).toBe(q.ultPoints);
        expect(p.flashedTicksLeft).toBe(q.flashedTicksLeft);
        expect(p.flashIntensity).toBe(q.flashIntensity);
        expect(p.abilityCharges).toEqual(q.abilityCharges);
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
      expect(a.abilityEntities.length).toBe(bb.abilityEntities.length);
      a.abilityEntities.forEach((ent, i) => {
        const f = bb.abilityEntities[i]!;
        expect(ent.entType).toBe(f.entType);
        expect(ent.owner).toBe(f.owner);
        expect(ent.abilityId).toBe(f.abilityId);
        expect(approxEqual(ent.x, f.x)).toBe(true);
        expect(approxEqual(ent.y, f.y)).toBe(true);
        expect(approxEqual(ent.z, f.z)).toBe(true);
        expect(ent.endTicksLeft).toBe(f.endTicksLeft);
        expect(ent.param).toBe(f.param);
      });
      expect(a.mode).toBe(bb.mode);
      expect(a.matchPhase).toBe(bb.matchPhase);
      expect(a.phaseTicksLeft).toBe(bb.phaseTicksLeft);
      expect(a.roundNumber).toBe(bb.roundNumber);
      expect(a.scoreTeam0).toBe(bb.scoreTeam0);
      expect(a.scoreTeam1).toBe(bb.scoreTeam1);
      expect(a.spikeState).toBe(bb.spikeState);
      expect(a.spikeCarrier).toBe(bb.spikeCarrier);
      expect(approxEqual(a.spikeX, bb.spikeX)).toBe(true);
      expect(approxEqual(a.spikeY, bb.spikeY)).toBe(true);
      expect(approxEqual(a.spikeZ, bb.spikeZ)).toBe(true);
      expect(a.spikePlantedTicksLeft).toBe(bb.spikePlantedTicksLeft);
      expect(a.activePlantProgress).toBe(bb.activePlantProgress);
      expect(a.planterIndex).toBe(bb.planterIndex);
      expect(a.activeDefuseProgress).toBe(bb.activeDefuseProgress);
      expect(a.defuserIndex).toBe(bb.defuserIndex);
      expect(a.visibleEnemyMask).toBe(bb.visibleEnemyMask);
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
    case MessageType.MapPing: {
      const bb = b as typeof a;
      expect(approxEqual(a.x, bb.x)).toBe(true);
      expect(approxEqual(a.z, bb.z)).toBe(true);
      break;
    }
    case MessageType.TeamPing: {
      const bb = b as typeof a;
      expect(a.playerIndex).toBe(bb.playerIndex);
      expect(approxEqual(a.x, bb.x)).toBe(true);
      expect(approxEqual(a.z, bb.z)).toBe(true);
      break;
    }
    case MessageType.MatchEvent: {
      const bb = b as typeof a;
      expect(a.kind).toBe(bb.kind);
      expect(a.winnerTeam).toBe(bb.winnerTeam);
      expect(a.reason).toBe(bb.reason);
      expect(a.roundNumber).toBe(bb.roundNumber);
      break;
    }
    case MessageType.AgentSelectCmd: {
      const bb = b as typeof a;
      expect(a.agentId).toBe(bb.agentId);
      break;
    }
    case MessageType.AbilityEvent: {
      const bb = b as typeof a;
      expect(a.kind).toBe(bb.kind);
      expect(a.owner).toBe(bb.owner);
      expect(a.abilityId).toBe(bb.abilityId);
      expect(approxEqual(a.x, bb.x)).toBe(true);
      expect(approxEqual(a.y, bb.y)).toBe(true);
      expect(approxEqual(a.z, bb.z)).toBe(true);
      expect(a.targetIndex).toBe(bb.targetIndex);
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
    interact: false,
    ping: false,
    ability1: false,
    ability2: true,
    signature: false,
    ult: true,
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
    team: 0,
    agentId: 2,
    ultPoints: 5,
    flashedTicksLeft: 40,
    flashIntensity: 1,
    abilityCharges: [2, 1, 0, 0],
    ...overrides,
  };
}

function sampleDrop(overrides: Partial<SnapshotDroppedWeapon> = {}): SnapshotDroppedWeapon {
  return { id: 3, weaponId: 4, x: 1, y: 0, z: 2, mag: 17, ...overrides };
}

function sampleAbilityEntity(overrides: Partial<SnapshotAbilityEntity> = {}): SnapshotAbilityEntity {
  return { entType: 1, owner: 2, abilityId: 3, x: 1.5, y: 0, z: -2.5, endTicksLeft: 100, param: 400, ...overrides };
}

function sampleSnapshot(overrides: Partial<ProtocolMessage & { type: MessageType.Snapshot }> = {}): ProtocolMessage {
  return {
    type: MessageType.Snapshot,
    serverTick: 1000,
    lastProcessedSeq: 998,
    players: [samplePlayer()],
    droppedWeapons: [sampleDrop()],
    abilityEntities: [sampleAbilityEntity()],
    mode: 1,
    matchPhase: 2,
    phaseTicksLeft: 4321,
    roundNumber: 7,
    scoreTeam0: 5,
    scoreTeam1: 4,
    spikeState: 2,
    spikeCarrier: 255,
    spikeX: 1.5,
    spikeY: 0,
    spikeZ: -2.5,
    spikePlantedTicksLeft: 1800,
    activePlantProgress: 0,
    planterIndex: 255,
    activeDefuseProgress: 30,
    defuserIndex: 3,
    visibleEnemyMask: 0b101,
    ...overrides,
  };
}

describe("protocol message round-trip", () => {
  it("Hello with no reconnect token", () => {
    const msg: ProtocolMessage = { type: MessageType.Hello, protocolVersion: 3, reconnectToken: NO_TOKEN };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Hello with a reconnect token", () => {
    const msg: ProtocolMessage = { type: MessageType.Hello, protocolVersion: 3, reconnectToken: tokenBytes(42) };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("InputBatch with redundant frames, viewTick, interact and ping", () => {
    const frames: InputSample[] = [
      sampleInput({ jump: true, crouch: false, walk: true, fire: false }),
      sampleInput({ forward: 0, right: 0, jump: false, fire: true, ads: false, reload: true, interact: true }),
      sampleInput({ forward: -1, right: 1, crouch: true, slot1: true, slot2: false, ping: true }),
    ];
    const msg: ProtocolMessage = { type: MessageType.InputBatch, firstSeq: 99, viewTick: 4321, frames };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("BuyCmd", () => {
    const msg: ProtocolMessage = { type: MessageType.BuyCmd, itemId: 201 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("SellCmd", () => {
    const msg: ProtocolMessage = { type: MessageType.SellCmd, itemId: 3 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Welcome carries token/team/mode", () => {
    const msg: ProtocolMessage = {
      type: MessageType.Welcome,
      playerIndex: 3,
      seed: 424242,
      numPlayers: 10,
      serverTick: 555,
      token: tokenBytes(7),
      team: 1,
      mode: 1,
    };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot with the M3 match section, several players, and dropped weapons", () => {
    const msg = sampleSnapshot({
      players: [
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
          team: 1,
        }),
      ],
      droppedWeapons: [sampleDrop(), sampleDrop({ id: 9, weaponId: 5, x: -5, y: 0, z: 10, mag: 5 })],
    });
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot clamps credits to 9000 and huge tagTicksLeft/respawnTicksLeft to 255 on the wire", () => {
    const msg = sampleSnapshot({ players: [samplePlayer({ credits: 50000, tagTicksLeft: 9999, respawnTicksLeft: 9999 })] });
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

  it("MapPing", () => {
    const msg: ProtocolMessage = { type: MessageType.MapPing, x: 12.5, z: -3.25 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("TeamPing", () => {
    const msg: ProtocolMessage = { type: MessageType.TeamPing, playerIndex: 2, x: 12.5, z: -3.25 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("MatchEvent", () => {
    const msg: ProtocolMessage = { type: MessageType.MatchEvent, kind: 3, winnerTeam: 255, reason: 255, roundNumber: 9 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("AgentSelectCmd (M4a)", () => {
    const msg: ProtocolMessage = { type: MessageType.AgentSelectCmd, agentId: 2 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("AbilityEvent (M4a)", () => {
    const msg: ProtocolMessage = { type: MessageType.AbilityEvent, kind: 1, owner: 3, abilityId: 8, x: 12.5, y: 1.2, z: -3.25, targetIndex: 255 };
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot with a live ability-entity section (projectile, wall, recon dart)", () => {
    const msg = sampleSnapshot({
      abilityEntities: [
        sampleAbilityEntity({ entType: 1, owner: 0, abilityId: 1, endTicksLeft: 0 }), // in-flight projectile
        sampleAbilityEntity({ entType: 3, owner: 1, abilityId: 13, param: 400, endTicksLeft: 1920 }), // wall box
        sampleAbilityEntity({ entType: 5, owner: 2, abilityId: 10, param: 2, endTicksLeft: 40 }), // recon dart, 2 pulses left
      ],
    });
    expectMessagesEqual(decodeMessage(encodeMessage(msg)), msg);
  });

  it("Snapshot ability-entity section edge sizes: 0 and 64 entities", () => {
    const empty = sampleSnapshot({ abilityEntities: [] });
    const decodedEmpty = decodeMessage(encodeMessage(empty));
    expectMessagesEqual(decodedEmpty, empty);

    const sixtyFour = sampleSnapshot({
      abilityEntities: Array.from({ length: 64 }, (_, i) => sampleAbilityEntity({ owner: i % 16, abilityId: i % 16 })),
    });
    const decodedFull = decodeMessage(encodeMessage(sixtyFour));
    expectMessagesEqual(decodedFull, sixtyFour);
    if (decodedFull.type === MessageType.Snapshot) {
      expect(decodedFull.abilityEntities.length).toBe(64);
    }
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
    function randToken(): Uint8Array {
      const t = new Uint8Array(TOKEN_LENGTH);
      for (let i = 0; i < TOKEN_LENGTH; i++) t[i] = randInt(256);
      return t;
    }

    function randomMessage(): ProtocolMessage {
      const kind = randInt(14);
      switch (kind) {
        case 0:
          return { type: MessageType.Hello, protocolVersion: randInt(256), reconnectToken: randBool() ? randToken() : NO_TOKEN };
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
              interact: randBool(),
              ping: randBool(),
              ability1: randBool(),
              ability2: randBool(),
              signature: randBool(),
              ult: randBool(),
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
            token: randToken(),
            team: randInt(256),
            mode: randInt(2),
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
              team: randInt(256),
              agentId: randInt(256),
              ultPoints: randInt(256),
              flashedTicksLeft: randInt(65536),
              flashIntensity: randInt(3),
              abilityCharges: [randInt(256), randInt(256), randInt(256), randInt(256)],
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
          // Deliberately covers both edges: 0 and 64 (MAX_ABILITY_ENTITIES).
          const entityCount = randBool() ? (randBool() ? 0 : 64) : randInt(65);
          const abilityEntities = Array.from({ length: entityCount }, () => ({
            entType: randInt(256),
            owner: randInt(256),
            abilityId: randInt(256),
            x: randF32(),
            y: randF32(),
            z: randF32(),
            endTicksLeft: randInt(65536),
            param: randInt(65536),
          }));
          return {
            type: MessageType.Snapshot,
            serverTick: randInt(2 ** 31),
            lastProcessedSeq: randInt(2 ** 31),
            players,
            droppedWeapons,
            abilityEntities,
            mode: randInt(2),
            matchPhase: randInt(256),
            phaseTicksLeft: randInt(2 ** 31),
            roundNumber: randInt(256),
            scoreTeam0: randInt(256),
            scoreTeam1: randInt(256),
            spikeState: randInt(256),
            spikeCarrier: randInt(256),
            spikeX: randF32(),
            spikeY: randF32(),
            spikeZ: randF32(),
            spikePlantedTicksLeft: randInt(2 ** 31),
            activePlantProgress: randInt(65536),
            planterIndex: randInt(256),
            activeDefuseProgress: randInt(65536),
            defuserIndex: randInt(256),
            visibleEnemyMask: randInt(65536),
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
        case 7:
          return {
            type: MessageType.DamageTaken,
            victimIndex: randInt(16),
            attackerIndex: randInt(16),
            damage: randInt(65536),
          };
        case 8:
          return { type: MessageType.MapPing, x: randF32(), z: randF32() };
        case 9:
          return { type: MessageType.TeamPing, playerIndex: randInt(16), x: randF32(), z: randF32() };
        case 10:
          return { type: MessageType.MatchEvent, kind: randInt(256), winnerTeam: randInt(256), reason: randInt(256), roundNumber: randInt(256) };
        case 11:
          return { type: MessageType.SellCmd, itemId: randInt(256) };
        case 12:
          return { type: MessageType.AgentSelectCmd, agentId: randInt(256) };
        default:
          return {
            type: MessageType.AbilityEvent,
            kind: randInt(256),
            owner: randInt(256),
            abilityId: randInt(256),
            x: randF32(),
            y: randF32(),
            z: randF32(),
            targetIndex: randInt(256),
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

  it("drops a truncated SellCmd (no itemId byte)", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.SellCmd]))).toBeNull();
  });

  it("drops a truncated Hello (missing the 16-byte reconnect token)", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.Hello, 3]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.Hello, 3, 1, 2, 3]))).toBeNull(); // partial token
  });

  it("drops a truncated Welcome (missing token/team/mode)", () => {
    const bytes = [MessageType.Welcome, 1, 0, 0, 0, 0, 5, 0, 0, 0, 0]; // playerIndex,seed(4),numPlayers,serverTick(4) then nothing
    expect(decodeMessageSafely(new Uint8Array(bytes))).toBeNull();
  });

  it("drops a truncated InputBatch missing the new u16 buttons field", () => {
    // type, firstSeq(4), viewTick(4), count=1, forward, right, yaw(4), pitch(4), then only 1 button byte (needs 2).
    const bytes = [MessageType.InputBatch, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(decodeMessageSafely(new Uint8Array(bytes))).toBeNull();
  });

  it("drops a Snapshot truncated mid-player (missing team/combat fields)", () => {
    const full = encodeMessage(sampleSnapshot());
    const truncated = full.slice(0, full.length - 40);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });

  it("drops a Snapshot truncated inside the match section", () => {
    const full = encodeMessage(sampleSnapshot());
    const truncated = full.slice(0, full.length - 5);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });

  it("drops a Snapshot truncated inside the droppedWeapons list", () => {
    const full = encodeMessage(sampleSnapshot({ players: [], droppedWeapons: [sampleDrop()] }));
    // Cut inside the match section AND partially into drops is covered above;
    // here we cut precisely mid-drop-list, well before the match section.
    const truncated = full.slice(0, 12);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });

  it("drops truncated MapPing/TeamPing/MatchEvent", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.MapPing, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.TeamPing, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.MatchEvent, 1, 2]))).toBeNull();
  });

  it("drops a truncated KillEvent/HitConfirm/DamageTaken", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.KillEvent, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.HitConfirm, 1, 2]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([MessageType.DamageTaken, 1]))).toBeNull();
  });

  it("still handles a fully unknown type tag and an empty frame", () => {
    expect(decodeMessageSafely(new Uint8Array([250, 1, 2, 3]))).toBeNull();
    expect(decodeMessageSafely(new Uint8Array([]))).toBeNull();
  });

  it("drops a truncated AgentSelectCmd (no agentId byte)", () => {
    expect(decodeMessageSafely(new Uint8Array([MessageType.AgentSelectCmd]))).toBeNull();
  });

  it("drops a truncated AbilityEvent (missing z/targetIndex)", () => {
    // type, kind, owner, abilityId, x(4), y(4) -- missing z(4) and targetIndex(1)
    const bytes = [MessageType.AbilityEvent, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(decodeMessageSafely(new Uint8Array(bytes))).toBeNull();
  });

  it("drops a Snapshot truncated inside the ability-entity section", () => {
    const full = encodeMessage(sampleSnapshot({ abilityEntities: [sampleAbilityEntity(), sampleAbilityEntity()] }));
    const truncated = full.slice(0, full.length - 3);
    expect(decodeMessageSafely(truncated)).toBeNull();
  });
});

describe("protocol version", () => {
  it("a v2-shaped Hello (old 1-byte body, no token) is rejected as malformed by a v4 decoder", () => {
    // Old Hello was exactly [type, protocolVersion] — 2 bytes total. A v4
    // decoder additionally expects a 16-byte token and must treat the
    // missing bytes as a truncated (thus malformed, thus safely-dropped)
    // frame, never silently accept it as valid.
    expect(decodeMessageSafely(new Uint8Array([MessageType.Hello, 2]))).toBeNull();
  });

  it("is bumped to 4 for M4a (abilities/agents)", () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it("a v3 Hello (protocolVersion byte = 3) decodes structurally but carries the OLD version value, so the server-side version-gate (see @vg/server) correctly rejects it", () => {
    const msg: ProtocolMessage = { type: MessageType.Hello, protocolVersion: 3, reconnectToken: NO_TOKEN };
    const decoded = decodeMessage(encodeMessage(msg));
    if (decoded.type === MessageType.Hello) {
      expect(decoded.protocolVersion).toBe(3);
      expect(decoded.protocolVersion).not.toBe(PROTOCOL_VERSION);
    } else {
      throw new Error("expected Hello");
    }
  });
});
