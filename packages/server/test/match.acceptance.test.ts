import { createLoopbackPair, decodeMessage, MessageType, encodeMessage, type ProtocolMessage } from "@vg/protocol";
import { PHASE_BUY, PHASE_ROUND, TEAM_ATTACKERS, TEAM_DEFENDERS, WEAPON_FALCON, WEAPON_VIPER } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

const TINY_CONFIG = {
  buyTicks: 5,
  firstRoundBuyTicks: 5,
  roundTicks: 300,
  spikeTicks: 20,
  plantTicks: 4,
  defuseTicks: 8,
  defuseCheckpointTicks: 4,
  roundEndTicks: 3,
  winTarget: 5,
  halfAtRound: 99,
};

function connectMatch(numPlayers = 2, minPlayers = 2) {
  const host = new ServerHost({ numPlayers, mode: "match", minPlayers, matchConfig: TINY_CONFIG, seed: 55 });
  const conns = Array.from({ length: numPlayers }, () => createLoopbackPair());
  // Per client, keep only the LATEST Welcome received: connect() may resend
  // an already-connected client a fresh Welcome once the match actually
  // starts (their very first Welcome can predate team assignment) — see
  // ServerHost.connect()'s doc comment. Tests care about the settled value.
  const lastWelcomeByClient: (ProtocolMessage | null)[] = new Array(numPlayers).fill(null);
  const welcomeCountByClient: number[] = new Array(numPlayers).fill(0);
  conns.forEach(([client], i) => {
    client.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Welcome) {
        lastWelcomeByClient[i] = msg;
        welcomeCountByClient[i] = (welcomeCountByClient[i] ?? 0) + 1;
      }
    });
  });
  const indices: number[] = [];
  for (const [, server] of conns) {
    indices.push(host.connect(server));
  }
  const welcomes = lastWelcomeByClient as ProtocolMessage[];
  return { host, conns, welcomes, indices, welcomeCountByClient };
}

function advanceToRound(host: ServerHost, senders: Array<(s: ReturnType<typeof idleInput>) => void>): void {
  let guard = 0;
  while (host.getState().matchPhase !== PHASE_ROUND && guard < 10000) {
    for (const send of senders) send(idleInput());
    host.step();
    guard++;
  }
}

describe("match mode: team assignment and start", () => {
  it("assigns teams alternating by join order and starts the match once minPlayers connect", () => {
    const { host, welcomes, welcomeCountByClient } = connectMatch(4, 2);
    expect(welcomes.length).toBe(4);
    expect(welcomeCountByClient.every((c) => c >= 1)).toBe(true);
    expect(welcomes.map((w) => (w.type === MessageType.Welcome ? w.team : -1))).toEqual([
      TEAM_ATTACKERS,
      TEAM_DEFENDERS,
      TEAM_ATTACKERS,
      TEAM_DEFENDERS,
    ]);
    expect(host.getState().matchPhase).toBe(PHASE_BUY);
  });

  it("does not start the match before minPlayers are connected", () => {
    const host = new ServerHost({ numPlayers: 4, mode: "match", minPlayers: 3, matchConfig: TINY_CONFIG });
    const [, s0] = createLoopbackPair();
    const [, s1] = createLoopbackPair();
    host.connect(s0);
    host.connect(s1);
    expect(host.getState().matchPhase).toBe(0); // PHASE_WAITING
  });
});

describe("match mode: buy/sell gating", () => {
  it("BuyCmd/SellCmd only apply during the buy phase", () => {
    const { host, conns, indices } = connectMatch(2, 2);
    const [client0] = conns[0]!;
    const idx0 = indices[0]!;
    host.getState().credits[idx0] = 5000;

    client0.send(encodeMessage({ type: MessageType.BuyCmd, itemId: WEAPON_FALCON }));
    host.step();
    expect(host.getState().weaponPrimary[idx0]).toBe(WEAPON_FALCON);

    const send0 = createScriptedInputSender(client0);
    advanceToRound(host, [send0, () => {}]);
    expect(host.getState().matchPhase).toBe(PHASE_ROUND);

    const creditsInRound = host.getState().credits[idx0];
    client0.send(encodeMessage({ type: MessageType.BuyCmd, itemId: WEAPON_VIPER }));
    host.step();
    // Viper is free/secondary anyway; assert credits didn't change and
    // primary is untouched by a buy attempt mid-round (gating check, not a
    // meaningful weapon change either way).
    expect(host.getState().credits[idx0]).toBe(creditsInRound);
    expect(host.getState().weaponPrimary[idx0]).toBe(WEAPON_FALCON);

    client0.send(encodeMessage({ type: MessageType.SellCmd, itemId: WEAPON_FALCON }));
    host.step();
    expect(host.getState().weaponPrimary[idx0]).toBe(WEAPON_FALCON); // sell rejected outside buy phase
  });
});

describe("match mode: friendly fire off", () => {
  it("a teammate shot deals 0 damage and is never a hit", () => {
    const { host, conns, indices } = connectMatch(2, 2);
    // Force both players onto the same team for this test.
    host.getState().team[indices[1]!] = host.getState().team[indices[0]!]!;

    const [client0] = conns[0]!;
    const send0 = createScriptedInputSender(client0);
    const state = host.getState();
    state.posX[indices[0]!] = 0;
    state.posY[indices[0]!] = 0;
    state.posZ[indices[0]!] = 0;
    state.posX[indices[1]!] = 0;
    state.posY[indices[1]!] = 0;
    state.posZ[indices[1]!] = 5;
    state.health[indices[1]!] = 100;
    state.weaponPrimary[indices[0]!] = 3; // Falcon
    state.activeSlot[indices[0]!] = 0;
    state.magPrimary[indices[0]!] = 25;
    state.reservePrimary[indices[0]!] = 100;

    for (let i = 0; i < 30; i++) {
      send0({ ...idleInput(), fire: true });
      host.step();
    }

    expect(host.getHits().length).toBe(0);
    expect(host.getState().health[indices[1]!]).toBe(100);
  });
});

describe("match mode: visibility masks (minimap fog of war)", () => {
  it("an enemy behind a wall from every teammate has bit 0; one teammate with LoS sets it for the whole team", () => {
    const { host, conns } = connectMatch(2, 2);
    void conns;
    const state = host.getState();
    const attacker = 0;
    const defender = 1;
    state.team[attacker] = TEAM_ATTACKERS;
    state.team[defender] = TEAM_DEFENDERS;

    // Defender directly behind the west lane-divider wall (x=-12, spans z in [-1,8]) from the attacker's viewpoint.
    state.posX[attacker] = -16;
    state.posY[attacker] = 0;
    state.posZ[attacker] = 4;
    state.yaw[attacker] = Math.atan2(1, 0); // facing +X, toward the wall/defender
    state.posX[defender] = -8;
    state.posY[defender] = 0;
    state.posZ[defender] = 4;

    for (let i = 0; i < 5; i++) host.step();
    expect(host.getVisibilityMask(TEAM_ATTACKERS) & (1 << defender)).toBe(0);

    // Move the defender into the open (same side of the divider, no wall between them) and re-check.
    // host.getState() returns a FRESH cloned object each tick, so we must
    // re-fetch it after the steps above before mutating again.
    const state2 = host.getState();
    state2.posX[defender] = -14;
    state2.posZ[defender] = 4;
    for (let i = 0; i < 5; i++) host.step();
    expect(host.getVisibilityMask(TEAM_ATTACKERS) & (1 << defender)).not.toBe(0);
  });

  it("an enemy more than 110 degrees behind the viewer is invisible unless another teammate sees them", () => {
    const { host } = connectMatch(3, 2);
    const state = host.getState();
    state.team[0] = TEAM_ATTACKERS;
    state.team[1] = TEAM_ATTACKERS;
    state.team[2] = TEAM_DEFENDERS;

    state.posX[0] = 0;
    state.posY[0] = 0;
    state.posZ[0] = 0;
    state.yaw[0] = 0; // facing +Z
    state.posX[2] = 0;
    state.posY[2] = 0;
    state.posZ[2] = -5; // directly BEHIND player 0 (>110 deg off their forward)

    // Player 1 (teammate) is far away and not looking at player 2 either.
    state.posX[1] = 15;
    state.posY[1] = 0;
    state.posZ[1] = 15;
    state.yaw[1] = 0;

    for (let i = 0; i < 5; i++) host.step();
    expect(host.getVisibilityMask(TEAM_ATTACKERS) & (1 << 2)).toBe(0);

    // Now player 1 turns to look directly at player 2 -> whole team sees it.
    // (host.getState() returns a fresh object each tick — re-fetch before mutating.)
    const state2 = host.getState();
    state2.posX[1] = 0;
    state2.posZ[1] = -3;
    state2.yaw[1] = Math.PI; // facing -Z, toward player 2
    for (let i = 0; i < 5; i++) host.step();
    expect(host.getVisibilityMask(TEAM_ATTACKERS) & (1 << 2)).not.toBe(0);
  });
});

describe("match mode: map pings", () => {
  it("a MapPing from A reaches teammates (including A) as TeamPing, never enemies, and is rate-limited", () => {
    const { host, conns, indices } = connectMatch(3, 2);
    const [clientA] = conns[0]!;
    const [clientB] = conns[1]!; // same team as A (alternating: 0,1,2 -> atk,def,atk)
    const [clientC] = conns[2]!;
    const a = indices[0]!;
    const c = indices[2]!;
    host.getState().team[a] = TEAM_ATTACKERS;
    host.getState().team[indices[1]!] = TEAM_DEFENDERS;
    host.getState().team[c] = TEAM_ATTACKERS;

    const receivedByA: ProtocolMessage[] = [];
    const receivedByB: ProtocolMessage[] = [];
    const receivedByC: ProtocolMessage[] = [];
    clientA.onMessage((d) => {
      const m = decodeMessage(d);
      if (m.type === MessageType.TeamPing) receivedByA.push(m);
    });
    clientB.onMessage((d) => {
      const m = decodeMessage(d);
      if (m.type === MessageType.TeamPing) receivedByB.push(m);
    });
    clientC.onMessage((d) => {
      const m = decodeMessage(d);
      if (m.type === MessageType.TeamPing) receivedByC.push(m);
    });

    clientA.send(encodeMessage({ type: MessageType.MapPing, x: 3, z: 4 }));
    host.step();

    expect(receivedByA.length).toBe(1); // reaches the sender too
    expect(receivedByC.length).toBe(1); // reaches teammate C
    expect(receivedByB.length).toBe(0); // never reaches the enemy team

    // Rate limit: a second ping immediately after is dropped.
    clientA.send(encodeMessage({ type: MessageType.MapPing, x: 1, z: 1 }));
    host.step();
    expect(receivedByA.length).toBe(1);
  });
});
