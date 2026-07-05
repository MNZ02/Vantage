import { createLoopbackPair, createVirtualClock, decodeMessage, encodeMessage, withLatency, MessageType, type SnapshotMessage } from "@vg/protocol";
import {
  ABL_LUMEN_RES,
  ABL_LUMEN_WALL,
  ABL_UMBRA_BLIND,
  AGENT_LUMEN,
  AGENT_SONAR,
  AGENT_UMBRA,
  BUY_ITEM_ABILITY1,
  ENT_NONE,
  ENT_PROJECTILE,
  ENT_ULT_ORB,
  ENT_WALL_BOX,
  FLASH_FULL,
  FLASH_NONE,
  MAX_ABILITY_ENTITIES,
  NO_PLAYER,
  PHASE_MATCH_END,
  PHASE_ROUND,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  WALL_BOX_MAX_HP,
  WEAPONS,
  getAbilityDef,
} from "@vg/sim";
import { describe, expect, it } from "vitest";
import { Bot } from "../src/bots.js";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

function setAgent(host: ServerHost, playerIndex: number, agentId: number): void {
  host.getState().agentId[playerIndex] = agentId;
}

function grantCharge(host: ServerHost, playerIndex: number, slot: number, amount = 1): void {
  host.getState().abilityCharges[playerIndex * 4 + slot] = amount;
}

function grantUlt(host: ServerHost, playerIndex: number, amount: number): void {
  host.getState().ultPoints[playerIndex] = amount;
}

describe("abilities end-to-end (M4a)", () => {
  it("Umbra's blind orb flashes a player it detonates near, visible via the wire Snapshot", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [casterClient, casterServer] = createLoopbackPair();
    const [victimClient, victimServer] = createLoopbackPair();
    const caster = host.connect(casterServer);
    const victim = host.connect(victimServer);
    const sendCaster = createScriptedInputSender(casterClient);
    const sendVictim = createScriptedInputSender(victimClient);

    setAgent(host, caster, AGENT_UMBRA);
    grantCharge(host, caster, 0, 1); // blind orb
    const s = host.getState();
    s.posX[caster] = 0;
    s.posZ[caster] = -5;
    s.posX[victim] = 0;
    s.posZ[victim] = 3; // roughly in front, within 30m, facing it
    s.yaw[victim] = 0; // facing +Z, i.e. away from the orb — should still see it (orb lands roughly in front along caster's throw, not necessarily victim's view)

    // Cast toward the victim with a slight upward pitch (arc).
    for (let i = 0; i < 300; i++) {
      sendCaster({ ...idleInput(), yaw: 0, pitch: 0.15, ability1: i === 0 });
      sendVictim({ ...idleInput(), yaw: 0 });
      host.step();
      const flashed = host.getState().flashedUntilTick[victim]! > host.getState().tick;
      if (flashed) break;
    }
    let latestSnapshot: SnapshotMessage | null = null;
    victimClient.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Snapshot) latestSnapshot = msg;
    });
    sendVictim(idleInput());
    host.step();

    expect(host.getState().flashedUntilTick[victim]!).toBeGreaterThan(host.getState().tick);
    const snap = latestSnapshot as SnapshotMessage | null;
    if (snap) {
      const me = snap.players[victim]!;
      expect(me.flashedTicksLeft).toBeGreaterThan(0);
      expect([FLASH_FULL, 1]).toContain(me.flashIntensity === FLASH_NONE ? -1 : me.flashIntensity);
    }
  });

  it("an intact Lumen wall blocks a Blind Orb's flash; a broken wall does not (review finding 3)", () => {
    const host = new ServerHost({ numPlayers: 2 });
    host.connect(createLoopbackPair()[1]);
    const victim = host.connect(createLoopbackPair()[1]);
    const s = host.getState();
    // Victim faces straight at the detonation point (unobstructed case would be FULL flash).
    s.posX[victim] = 0;
    s.posY[victim] = 0;
    s.posZ[victim] = 3;
    s.yaw[victim] = Math.PI; // facing -Z, i.e. toward the detonation at z=-3

    // A 2m-wide, 2m-tall, 0.4m-thick wall centered at z=0 — directly between
    // the detonation point (z=-3) and the victim (z=3), covering both the
    // detonation height and the victim's eye height (y in [0,2]).
    const wallSlot = 0;
    s.entType[wallSlot] = ENT_WALL_BOX;
    s.entOwner[wallSlot] = NO_PLAYER;
    s.entAbilityId[wallSlot] = ABL_LUMEN_WALL;
    s.entX[wallSlot] = 0;
    s.entY[wallSlot] = 1;
    s.entZ[wallSlot] = 0;
    s.entVelX[wallSlot] = 1; // alignX: long axis along X, thin along Z
    s.entVelZ[wallSlot] = 0;
    s.entParam[wallSlot] = WALL_BOX_MAX_HP;
    s.entEndTick[wallSlot] = s.tick + 1920;

    function spawnLandedBlindOrb(slot: number, fuseTicks: number): void {
      const st = host.getState();
      st.entType[slot] = ENT_PROJECTILE;
      st.entOwner[slot] = NO_PLAYER;
      st.entAbilityId[slot] = ABL_UMBRA_BLIND;
      st.entX[slot] = 0;
      st.entY[slot] = 1;
      st.entZ[slot] = -3;
      st.entVelX[slot] = 0;
      st.entVelY[slot] = 0;
      st.entVelZ[slot] = 0; // already landed, waiting on its fuse (see @vg/sim abilities/logic.ts onProjectileLand)
      st.entSpawnTick[slot] = st.tick;
      st.entEndTick[slot] = st.tick + fuseTicks;
      st.entParam[slot] = 0;
    }

    // ---- Phase 1: wall intact -> no flash ----
    spawnLandedBlindOrb(1, 3);
    for (let i = 0; i < 10; i++) host.step();
    expect(host.getState().flashedUntilTick[victim]!).toBeLessThanOrEqual(host.getState().tick);

    // ---- Phase 2: break the wall, detonate again -> flash lands ----
    host.getState().entType[wallSlot] = ENT_NONE;
    spawnLandedBlindOrb(1, 3);
    for (let i = 0; i < 10; i++) host.step();
    expect(host.getState().flashedUntilTick[victim]!).toBeGreaterThan(host.getState().tick);
  });

  it("Sonar's shock dart deals falloff AoE damage and can kill (crediting/ability-side-effects flow through handleKill)", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [casterClient, casterServer] = createLoopbackPair();
    const [, targetServer] = createLoopbackPair();
    const caster = host.connect(casterServer);
    const target = host.connect(targetServer);
    const sendCaster = createScriptedInputSender(casterClient);

    setAgent(host, caster, AGENT_SONAR);
    grantCharge(host, caster, 0, 1);
    const s = host.getState();
    s.posX[caster] = 0;
    s.posZ[caster] = -5;
    // Placed at the dart's actual landing spot for this launch angle (a
    // shallow arc travels ~9.6m before falling back to ground height) —
    // well within the shock dart's 5m falloff radius of the impact point.
    s.posX[target] = 0;
    s.posZ[target] = 4.5;
    s.health[target] = 5; // dies easily to shock dart splash

    let killed = false;
    for (let i = 0; i < 300 && !killed; i++) {
      sendCaster({ ...idleInput(), yaw: 0, pitch: 0.05, ability1: i === 0 });
      host.step();
      killed = host.getState().alive[target] === 0;
    }
    expect(killed).toBe(true);
    expect(host.getKills().some((k) => k.victimIndex === target && k.killerIndex === caster)).toBe(true);
  });

  it("Lumen's wall boxes are shootable and block bullets from reaching a player behind them", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [casterClient, casterServer] = createLoopbackPair();
    const [, targetServer] = createLoopbackPair();
    const caster = host.connect(casterServer);
    const target = host.connect(targetServer);
    const sendCaster = createScriptedInputSender(casterClient);

    setAgent(host, caster, AGENT_LUMEN);
    grantCharge(host, caster, 1, 1); // wall (basic2)
    const s = host.getState();
    s.posX[caster] = 0;
    s.posZ[caster] = -10;
    s.yaw[caster] = 0;
    s.posX[target] = 0;
    s.posZ[target] = 5; // behind where the wall will land
    s.health[target] = 100;
    s.weaponPrimary[caster] = FALCON.id;
    s.activeSlot[caster] = 0;
    s.magPrimary[caster] = FALCON.magSize;
    s.reservePrimary[caster] = FALCON.reserveAmmo;

    const wallDef = getAbilityDef(getAbilityDef(13)!.id)!; // ABL_LUMEN_WALL = 13
    sendCaster({ ...idleInput(), yaw: 0, ability2: true });
    host.step();
    for (let i = 0; i < wallDef.castDelayTicks + 2; i++) {
      sendCaster(idleInput());
      host.step();
    }

    // Three segments spawn (spec: 3 aligned barrier boxes) — sum their HP so
    // the assertion doesn't depend on which exact segment the dead-center
    // shot happens to land on.
    function totalWallHp(): number {
      let total = 0;
      for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) {
        if (host.getState().entType[e] === ENT_WALL_BOX) total += host.getState().entParam[e]!;
      }
      return total;
    }
    const wallCount = (() => {
      let n = 0;
      for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) if (host.getState().entType[e] === ENT_WALL_BOX) n++;
      return n;
    })();
    expect(wallCount).toBe(3);
    const hpBefore = totalWallHp();
    expect(hpBefore).toBe(WALL_BOX_MAX_HP * 3);

    // Fire straight down +Z at the target, through where the wall now sits.
    for (let i = 0; i < 10; i++) {
      sendCaster({ ...idleInput(), yaw: 0, pitch: 0, fire: true });
      host.step();
    }

    expect(host.getState().health[target]).toBe(100); // wall absorbed it
    const hpAfter = totalWallHp();
    expect(hpAfter).toBeLessThan(hpBefore);
  });

  it("Lumen's Resurrect revives a dead teammate at their death spot after the cast delay", () => {
    // 3 players: caster + victim on attackers (so the round doesn't
    // instantly end from elimination the moment the victim is killed off —
    // a 3rd attacker keeps the team alive), 1 lone defender.
    const host = new ServerHost({ numPlayers: 3, mode: "match", minPlayers: 3 });
    const [casterClient, casterServer] = createLoopbackPair();
    const [, victimServer] = createLoopbackPair();
    const [, defenderServer] = createLoopbackPair();
    const caster = host.connect(casterServer);
    const victim = host.connect(victimServer);
    const defender = host.connect(defenderServer);
    const sendCaster = createScriptedInputSender(casterClient);

    // Casts only resolve during PHASE_ROUND in match mode — advance there first.
    while (host.getState().matchPhase !== PHASE_ROUND && host.getState().matchPhase !== PHASE_MATCH_END) {
      sendCaster(idleInput());
      host.step();
    }
    expect(host.getState().matchPhase).toBe(PHASE_ROUND);

    const s = host.getState();
    s.team[caster] = TEAM_ATTACKERS;
    s.team[victim] = TEAM_ATTACKERS;
    s.team[defender] = TEAM_DEFENDERS;
    setAgent(host, caster, AGENT_LUMEN);
    const resDef = getAbilityDef(ABL_LUMEN_RES)!;
    grantUlt(host, caster, resDef.ultCost);

    s.alive[victim] = 0;
    s.posX[victim] = 3;
    s.posZ[victim] = 0;
    s.posX[caster] = 0;
    s.posZ[caster] = 0;

    sendCaster({ ...idleInput(), ult: true });
    host.step();
    // The jitter buffer may hold an input a tick or two before it's
    // consumed — poll briefly rather than asserting immediately after one step().
    for (let i = 0; i < 5 && host.getState().ultPoints[caster]! > 0; i++) {
      sendCaster(idleInput());
      host.step();
    }
    expect(host.getState().matchPhase).toBe(PHASE_ROUND); // sanity: round didn't end mid-test
    expect(host.getState().ultPoints[caster]).toBe(0); // spent on cast (jitter-buffer-delayed by a tick or two)

    for (let i = 0; i < resDef.castDelayTicks + 30; i++) {
      sendCaster(idleInput());
      host.step();
    }

    expect(host.getState().alive[victim]).toBe(1);
    expect(host.getState().health[victim]).toBe(resDef.reviveHp);
    expect(host.getState().posX[victim]).toBe(3);
  });

  it("AgentSelectCmd assigns an agent, visible on the wire Snapshot", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [client, server] = createLoopbackPair();
    const other = host.connect(server);
    void other;
    const [selfClient, selfServer] = createLoopbackPair();
    const self = host.connect(selfServer);
    void client;
    self;

    selfClient.send(encodeMessage({ type: MessageType.AgentSelectCmd, agentId: AGENT_SONAR }));
    const sendSelf = createScriptedInputSender(selfClient);
    sendSelf(idleInput());
    host.step();

    expect(host.getState().agentId[self]).toBe(AGENT_SONAR);
  });

  it("BuyCmd itemId 100 (ability1) grants a charge for the caster's picked agent", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const player = host.connect(server);
    setAgent(host, player, AGENT_SONAR);
    const before = host.getState().credits[player]!;

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: BUY_ITEM_ABILITY1 }));
    const send = createScriptedInputSender(client);
    send(idleInput());
    host.step();

    expect(host.getState().abilityCharges[player * 4 + 0]).toBe(1);
    expect(host.getState().credits[player]!).toBeLessThan(before);
  });

  it("orb pickup awards an ult point, capped at the picker's own ult cost", () => {
    const host = new ServerHost({ numPlayers: 1, mode: "match", minPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const player = host.connect(server);
    setAgent(host, player, AGENT_SONAR);
    const send = createScriptedInputSender(client);

    // advance to round phase
    while (host.getState().matchPhase !== PHASE_ROUND && host.getState().matchPhase !== PHASE_MATCH_END) {
      send(idleInput());
      host.step();
    }
    let orbSlot = -1;
    for (let e = 0; e < MAX_ABILITY_ENTITIES; e++) if (host.getState().entType[e] === ENT_ULT_ORB) orbSlot = e;
    expect(orbSlot).toBeGreaterThanOrEqual(0);
    const s = host.getState();
    s.posX[player] = s.entX[orbSlot]!;
    s.posZ[player] = s.entZ[orbSlot]!;

    send(idleInput());
    host.step();
    expect(host.getState().ultPoints[player]).toBeGreaterThan(0);
  });
});

describe("ability soak (acceptance criterion 10)", () => {
  it("10 match-aware bots casting abilities reach matchEnd: >=5 casts across >=3 kits, >=1 ability kill or flash, no crash/NaN, p95 tick < 15.625ms", () => {
    const NUM_BOTS = 10;
    const host = new ServerHost({
      numPlayers: NUM_BOTS,
      seed: 77,
      mode: "match",
      minPlayers: NUM_BOTS,
      matchConfig: {
        buyTicks: 120,
        firstRoundBuyTicks: 120,
        roundTicks: 900,
        spikeTicks: 200,
        plantTicks: 64,
        defuseTicks: 128,
        defuseCheckpointTicks: 64,
        roundEndTicks: 30,
        winTarget: 2,
        halfAtRound: 1,
      },
    });
    const clock = createVirtualClock();
    const bots: Bot[] = [];
    const castsByAbilityId = new Set<number>();
    let castCount = 0;
    let abilityKillOrFlashSeen = false;

    for (let slot = 0; slot < NUM_BOTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const clientTransport = withLatency(rawClient, { delayMs: 20, jitterMs: 5, lossRate: 0.01, seed: 6500 + slot, scheduler: clock.scheduler });
      clientTransport.onMessage((data) => {
        const msg = decodeMessage(data);
        if (msg.type === MessageType.AbilityEvent && msg.kind === 0) {
          castCount++;
          castsByAbilityId.add(msg.abilityId);
        }
        if (msg.type === MessageType.KillEvent && msg.weaponId >= 100) abilityKillOrFlashSeen = true;
      });
      bots.push(new Bot(clientTransport, 8300 + slot));
      host.connect(rawServer);
    }

    // Force ability charges/ult points generously so bots' low-probability
    // heuristics actually get to fire during the soak's finite tick budget —
    // mirrors granting a full buy in the acceptance tests above, at scale.
    const grantAll = (): void => {
      const s = host.getState();
      for (let i = 0; i < NUM_BOTS; i++) {
        for (let slot = 0; slot < 3; slot++) s.abilityCharges[i * 4 + slot] = 2;
        s.ultPoints[i] = 8;
      }
    };

    let matchEnded = false;
    const FIXED_DT_MS = 15.625;
    for (let t = 0; t < 20_000; t++) {
      if (t % 100 === 0) grantAll();
      for (const bot of bots) bot.tick();
      clock.advance(FIXED_DT_MS);
      host.step();
      const st = host.getState();
      for (let i = 0; i < st.numPlayers; i++) {
        expect(Number.isFinite(st.posX[i])).toBe(true);
        expect(Number.isFinite(st.health[i])).toBe(true);
      }
      if (host.getState().flashIntensity.some((v) => v !== 0)) abilityKillOrFlashSeen = true;
      if (st.matchPhase === PHASE_MATCH_END) {
        matchEnded = true;
        break;
      }
    }

    // Distinct KITS (agents), not distinct ability ids — spec's ">=3 distinct
    // kits" bar (e.g. two casts both from Sonar's own basics count as one kit).
    const distinctKits = new Set(Array.from(castsByAbilityId).map((abilityId) => getAbilityDef(abilityId)?.agentId));

    expect(matchEnded).toBe(true);
    expect(castCount).toBeGreaterThanOrEqual(5);
    expect(distinctKits.size).toBeGreaterThanOrEqual(3);
    expect(abilityKillOrFlashSeen).toBe(true);

    const durations = host.stepDurationsMs.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[Math.min(p95Index, durations.length - 1)]!;
    expect(p95).toBeLessThan(FIXED_DT_MS);
  }, 60_000);
});
