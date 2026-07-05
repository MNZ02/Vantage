import { describe, expect, it } from "vitest";
import {
  BUY_ITEM_HEAVY_ARMOR,
  BUY_ITEM_LIGHT_ARMOR,
  DEFENDER_SPAWNS,
  LEVEL_BOXES,
  NO_PLAYER,
  PHASE_BUY,
  PHASE_MATCH_END,
  PHASE_ROUND,
  PHASE_ROUND_END,
  PHASE_WAITING,
  ROUND_END_DEFUSE,
  ROUND_END_DETONATION,
  ROUND_END_ELIMINATION,
  ROUND_END_TIMEOUT,
  SITE_ZONES,
  SPIKE_CARRIED,
  SPIKE_DROPPED,
  SPIKE_PLANTED,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  WEAPON_FALCON,
  WEAPON_VIPER,
  applyBuy,
  applyDamage,
  applySell,
  createMatchState,
  defaultInput,
  livingTeammates,
  raycastPlayers,
  serializeState,
  startMatch,
  tick,
  type InputFrame,
  type MatchConfig,
  type SimState,
} from "../src/index.js";

const TINY_CONFIG: Partial<MatchConfig> = {
  buyTicks: 5,
  firstRoundBuyTicks: 5,
  roundTicks: 200,
  spikeTicks: 10,
  plantTicks: 4,
  defuseTicks: 8,
  defuseCheckpointTicks: 4,
  roundEndTicks: 3,
  winTarget: 2,
  halfAtRound: 1,
};

function idle(yaw = 0): InputFrame {
  return defaultInput(yaw, 0);
}

function runTicks(state: SimState, n: number, inputsFn: (t: number, s: SimState) => readonly InputFrame[]): SimState {
  let s = state;
  for (let i = 0; i < n; i++) {
    s = tick(s, inputsFn(i, s), LEVEL_BOXES).state;
  }
  return s;
}

function allIdle(state: SimState): InputFrame[] {
  return Array.from({ length: state.numPlayers }, () => idle());
}

/** Ticks until PHASE_ROUND is reached (works from BUY or ROUND_END; stops early on MATCH_END so it can never spin forever). */
function advanceToRound(state: SimState): SimState {
  let s = state;
  while (s.matchPhase !== PHASE_ROUND && s.matchPhase !== PHASE_MATCH_END) {
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
  }
  return s;
}

describe("match state machine", () => {
  it("startMatch assigns teams alternating by index and enters buy phase", () => {
    const s = startMatch(createMatchState(1, 4, TINY_CONFIG));
    expect(Array.from(s.team)).toEqual([TEAM_ATTACKERS, TEAM_DEFENDERS, TEAM_ATTACKERS, TEAM_DEFENDERS]);
    expect(s.matchPhase).toBe(PHASE_BUY);
    expect(s.roundNumber).toBe(1);
  });

  it("is a no-op outside the waiting phase or DM mode", () => {
    const s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    const again = startMatch(s);
    expect(again).toBe(s);
  });

  it("buy phase transitions to round phase after phaseEndTick, using firstRoundBuyTicks for round 1", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    expect(s.phaseEndTick - s.tick).toBe(TINY_CONFIG.firstRoundBuyTicks);
    s = runTicks(s, TINY_CONFIG.firstRoundBuyTicks! - 1, allIdle);
    expect(s.matchPhase).toBe(PHASE_BUY);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_ROUND);
  });

  it("elimination ends the round for the surviving team", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    expect(s.matchPhase).toBe(PHASE_ROUND);
    // Kill the lone defender (player 1) -> attackers win by elimination.
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    expect(s.lastRoundWinnerTeam).toBe(TEAM_ATTACKERS);
    expect(s.lastRoundEndReason).toBe(ROUND_END_ELIMINATION);
    expect(s.scoreTeam0).toBe(1);
  });

  it("round timeout with no plant awards defenders", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    const ticksLeft = s.phaseEndTick - s.tick;
    s = runTicks(s, ticksLeft, allIdle);
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    expect(s.lastRoundWinnerTeam).toBe(TEAM_DEFENDERS);
    expect(s.lastRoundEndReason).toBe(ROUND_END_TIMEOUT);
  });

  it("detonation after a full plant awards attackers", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    s = plantSpike(s);
    expect(s.spikeState).toBe(SPIKE_PLANTED);
    const untilDetonation = s.spikePlantedTick + TINY_CONFIG.spikeTicks! - s.tick;
    s = runTicks(s, untilDetonation, allIdle);
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    expect(s.lastRoundWinnerTeam).toBe(TEAM_ATTACKERS);
    expect(s.lastRoundEndReason).toBe(ROUND_END_DETONATION);
  });

  it("defuse after a full plant awards defenders, and plant bonus still pays attackers", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    s = plantSpike(s);
    const creditsBeforeRoundEnd = s.credits[0]!;
    // Defender (player 1) walks to the spike and holds interact.
    s.posX[1] = s.spikeX;
    s.posY[1] = s.spikeY;
    s.posZ[1] = s.spikeZ;
    for (let t = 0; t < TINY_CONFIG.defuseTicks!; t++) {
      const inputs = [idle(), { ...idle(), interact: true }];
      s = tick(s, inputs, LEVEL_BOXES).state;
    }
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    expect(s.lastRoundWinnerTeam).toBe(TEAM_DEFENDERS);
    expect(s.lastRoundEndReason).toBe(ROUND_END_DEFUSE);
    // Attacker (player 0, lost the round) still got the +300 plant bonus.
    expect(s.credits[0]).toBe(creditsBeforeRoundEnd + TINY_CONFIG_LOSS_FIRST + 300);
  });
});

// First-loss credit award from DEFAULT_LOSS_CREDITS[0] (config not overridden in TINY_CONFIG).
const TINY_CONFIG_LOSS_FIRST = 1900;

/** Drives the sole attacker (player 0) into site A and holds interact until the spike plants. */
function plantSpike(state: SimState): SimState {
  let s = state;
  const zone = SITE_ZONES[0]!.box;
  const cx = (zone.minX + zone.maxX) / 2;
  const cz = (zone.minZ + zone.maxZ) / 2;
  s = { ...s };
  s.posX[0] = cx;
  s.posY[0] = 0;
  s.posZ[0] = cz;
  s.velX[0] = 0;
  s.velZ[0] = 0;
  expect(s.spikeCarrier).toBe(0);
  expect(s.spikeState).toBe(SPIKE_CARRIED);
  for (let t = 0; t < TINY_CONFIG.plantTicks!; t++) {
    const inputs: InputFrame[] = new Array(s.numPlayers).fill(0).map(() => idle());
    inputs[0] = { ...idle(), interact: true };
    s = tick(s, inputs, LEVEL_BOXES).state;
  }
  return s;
}

describe("half swap and overtime", () => {
  it("half swap resets credits/streaks/loadouts and flips team assignment", () => {
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, halfAtRound: 1 }));
    s = advanceToRound(s);
    // Attacker (0) kills defender (1) -> round 1 ends, halfAtRound(1) reached -> half swap on next buy entry.
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    const ticksLeft = s.phaseEndTick - s.tick;
    s = runTicks(s, ticksLeft, allIdle);
    expect(s.matchPhase).toBe(PHASE_BUY);
    expect(s.halvesSwapped).toBe(1);
    expect(Array.from(s.team)).toEqual([TEAM_DEFENDERS, TEAM_ATTACKERS]);
    expect(s.credits[0]).toBe(s.config.startCredits);
    expect(s.credits[1]).toBe(s.config.startCredits);
    expect(s.lossStreakTeam0).toBe(0);
    expect(s.lossStreakTeam1).toBe(0);
    // Score persists per ORIGINAL squad: squad 0 (player 0) still leads 1-0
    // even though player 0 is now on the defending side.
    expect(s.scoreTeam0).toBe(1);
    expect(s.scoreTeam1).toBe(0);
  });

  it("enters overtime with otStartCredits and full loadout reset once both teams reach winTarget-1", () => {
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, winTarget: 3, halfAtRound: 99 }));
    // Round 1: attacker (0) wins by elimination.
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle); // -> buy 2
    // Round 2: defender (1) wins by elimination (kill attacker 0).
    s = advanceToRound(s);
    s = applyDamage(s, 0, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.scoreTeam0).toBe(1);
    expect(s.scoreTeam1).toBe(1);
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle); // -> buy 3, both at winTarget-1=2? no: 1-1 with winTarget 3 -> winTarget-1=2, not yet OT.
    expect(s.matchPhase).toBe(PHASE_BUY);
  });

  it("match ends only once a team leads by 2 at/above winTarget (13-12 continues, 14-12 ends) — generalized with a small target", () => {
    // winTarget=2: first team to reach 2 wins ONLY if leading by >=2; otherwise OT (win-by-2) continues.
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, winTarget: 2, halfAtRound: 99 }));
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000); // attacker wins round 1: score 1-0
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle); // -> buy 2
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000); // attacker wins round 2 too: score 2-0, leads by 2 -> match ends
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_MATCH_END);
    expect(s.scoreTeam0).toBe(2);
    expect(s.scoreTeam1).toBe(0);
  });

  it("matchEnd freezes phase forever (no further ticks change matchPhase)", () => {
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, winTarget: 2, halfAtRound: 99 }));
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000); // round 1: attacker wins, 1-0
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000); // round 2: attacker wins again, 2-0 (lead by 2) -> match ends
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_MATCH_END);
    const frozen = runTicks(s, 500, allIdle);
    expect(frozen.matchPhase).toBe(PHASE_MATCH_END);
    expect(frozen.scoreTeam0).toBe(s.scoreTeam0);
  });
});

describe("spike lifecycle", () => {
  it("is assigned to the lowest-index living attacker at buy start", () => {
    const s = startMatch(createMatchState(1, 4, TINY_CONFIG));
    expect(s.spikeCarrier).toBe(0);
    expect(s.spikeState).toBe(SPIKE_CARRIED);
  });

  it("drops at the death spot when the carrier dies, and only an attacker can pick it up", () => {
    let s = startMatch(createMatchState(1, 4, TINY_CONFIG));
    s = advanceToRound(s);
    s.posX[0] = 1;
    s.posY[0] = 0;
    s.posZ[0] = 2;
    s = applyDamage(s, 0, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.spikeState).toBe(SPIKE_DROPPED);
    expect(s.spikeCarrier).toBe(NO_PLAYER);
    expect(s.spikeX).toBe(1);
    expect(s.spikeZ).toBe(2);

    // Defender (player 1, or 3) walking onto it does NOT pick it up.
    s.posX[1] = s.spikeX;
    s.posZ[1] = s.spikeZ;
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.spikeState).toBe(SPIKE_DROPPED);

    // Attacker (player 2) walks onto it and picks it up.
    s.posX[2] = s.spikeX;
    s.posZ[2] = s.spikeZ;
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.spikeState).toBe(SPIKE_CARRIED);
    expect(s.spikeCarrier).toBe(2);
  });

  it("plant only progresses in a site zone while roughly stationary, and resets on leaving the zone", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    const zone = SITE_ZONES[0]!.box;
    s.posX[0] = (zone.minX + zone.maxX) / 2;
    s.posZ[0] = (zone.minZ + zone.maxZ) / 2;

    // Holding interact OUTSIDE any zone: no progress.
    s.posX[0] = zone.minX - 10;
    let before = s;
    s = tick(s, [{ ...idle(), interact: true }, idle()], LEVEL_BOXES).state;
    expect(s.plantProgress).toBe(0);

    // Move into the zone, hold interact: progress accumulates.
    s.posX[0] = (zone.minX + zone.maxX) / 2;
    s.posZ[0] = (zone.minZ + zone.maxZ) / 2;
    s.velX[0] = 0;
    s.velZ[0] = 0;
    s = tick(s, [{ ...idle(), interact: true }, idle()], LEVEL_BOXES).state;
    expect(s.plantProgress).toBe(1);
    s = tick(s, [{ ...idle(), interact: true }, idle()], LEVEL_BOXES).state;
    expect(s.plantProgress).toBe(2);

    // Release interact: resets to 0.
    s = tick(s, [idle(), idle()], LEVEL_BOXES).state;
    expect(s.plantProgress).toBe(0);
  });

  it("completes at plantTicks -> planted, position frozen", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    s = plantSpike(s);
    expect(s.spikeState).toBe(SPIKE_PLANTED);
    expect(s.spikePlantedTick).toBeGreaterThan(0);
    const frozenX = s.spikeX;
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.spikeX).toBe(frozenX);
  });

  it("defuse checkpoint at half; interrupting after 60% resumes from 50%, not from 0", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    s = plantSpike(s);
    s.posX[1] = s.spikeX;
    s.posY[1] = s.spikeY;
    s.posZ[1] = s.spikeZ;
    const total = TINY_CONFIG.defuseTicks!; // 8
    const sixtyPercentTicks = Math.round(total * 0.6); // 5
    for (let t = 0; t < sixtyPercentTicks; t++) {
      s = tick(s, [idle(), { ...idle(), interact: true }], LEVEL_BOXES).state;
    }
    expect(s.defuseProgress).toBe(sixtyPercentTicks);
    expect(s.defuseCheckpointHit).toBe(1); // checkpoint (50%=4 ticks) already passed
    // Interrupt: release interact for a tick.
    s = tick(s, [idle(), idle()], LEVEL_BOXES).state;
    expect(s.defuseProgress).toBe(total / 2); // resumed at the 50% checkpoint, not 0
    expect(s.defuserIndex).toBe(NO_PLAYER);
  });
});

describe("economy", () => {
  it("win/loss streak escalation and reset-on-win, cap at maxCredits", () => {
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, winTarget: 10, halfAtRound: 99, maxCredits: 5000 }));
    const startCredits = s.config.startCredits;

    // Round 1: defenders (1) win by timeout -> attacker (0) first loss (1900), defender (1) win (3000, capped).
    s = advanceToRound(s);
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle);
    expect(s.lastRoundEndReason).toBe(ROUND_END_TIMEOUT);
    expect(s.credits[0]).toBe(Math.min(5000, startCredits + 1900));
    expect(s.credits[1]).toBe(Math.min(5000, startCredits + 3000));
    expect(s.lossStreakTeam0).toBe(1);

    // Round 2: defenders win again by timeout -> attacker second loss (2400).
    const creditsBefore0 = s.credits[0]!;
    s = advanceToRound(s);
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle);
    expect(s.credits[0]).toBe(Math.min(5000, creditsBefore0 + 2400));
    expect(s.lossStreakTeam0).toBe(2);

    // Round 3: defenders win again -> attacker third+ loss (2900), streak caps at reported index 2.
    const creditsBefore0b = s.credits[0]!;
    s = advanceToRound(s);
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle);
    expect(s.credits[0]).toBe(Math.min(5000, creditsBefore0b + 2900));

    // Round 4: attacker wins by elimination -> their own streak resets to 0.
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.lastRoundWinnerTeam).toBe(TEAM_ATTACKERS);
    expect(s.lossStreakTeam0).toBe(0);
  });

  it("refund: selling a weapon bought this buy phase restores the previous slot weapon and full price", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s.credits[0] = 5000;
    s = applyBuy(s, 0, WEAPON_FALCON);
    expect(s.weaponPrimary[0]).toBe(WEAPON_FALCON);
    const creditsAfterBuy = s.credits[0]!;
    s = applySell(s, 0, WEAPON_FALCON);
    expect(s.weaponPrimary[0]).toBe(255); // WEAPON_NONE, reverted to buy-start snapshot
    expect(s.credits[0]).toBe(creditsAfterBuy + 2900); // Falcon's price
  });

  it("refund: armor sells back and reverts to the buy-start value", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s.credits[0] = 5000;
    s = applyBuy(s, 0, BUY_ITEM_HEAVY_ARMOR);
    expect(s.armor[0]).toBe(50);
    const after = s.credits[0]!;
    s = applySell(s, 0, BUY_ITEM_HEAVY_ARMOR);
    expect(s.armor[0]).toBe(0);
    expect(s.credits[0]).toBe(after + 1000);
  });

  it("sell no-ops for an item not purchased this buy phase (e.g. the free starting Viper)", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    const before = s.credits[0];
    s = applySell(s, 0, WEAPON_VIPER);
    expect(s.credits[0]).toBe(before);
    expect(s.weaponSecondary[0]).toBe(WEAPON_VIPER);
  });
});

describe("no respawn in match mode", () => {
  it("a player who dies mid-round stays dead until the next buy phase, which revives everyone", () => {
    // 4 players, kill only ONE defender (player 1) so the round does NOT end
    // (player 3, also a defender, is still alive) — isolates "no auto-respawn"
    // from round-end revival.
    let s = startMatch(createMatchState(1, 4, TINY_CONFIG));
    s = advanceToRound(s);
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.alive[1]).toBe(0);
    expect(s.matchPhase).toBe(PHASE_ROUND);
    // Stays dead through many ticks (no RESPAWN_TICKS-style auto-revive).
    for (let i = 0; i < 50; i++) {
      s = tick(s, allIdle(s), LEVEL_BOXES).state;
    }
    expect(s.alive[1]).toBe(0);
    expect(s.matchPhase).toBe(PHASE_ROUND);

    // Now eliminate the whole defending team (player 3 too) -> round ends,
    // and the next buy phase revives everyone.
    s = applyDamage(s, 3, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    expect(s.matchPhase).toBe(PHASE_ROUND_END);
    s = advanceToRound(s); // runs through the roundEnd freeze into the next buy, then into round
    expect(s.alive[1]).toBe(1);
    expect(s.alive[3]).toBe(1);
  });

  it("survivors keep loadout+armor across a round; players who died reset to Viper-only", () => {
    let s = startMatch(createMatchState(1, 2, { ...TINY_CONFIG, halfAtRound: 99 }));
    s.credits[0] = 5000;
    s.credits[1] = 5000;
    s = applyBuy(s, 0, WEAPON_FALCON);
    s = applyBuy(s, 0, BUY_ITEM_HEAVY_ARMOR);
    s = applyBuy(s, 1, WEAPON_FALCON);
    s = advanceToRound(s);
    // Player 1 (defender) dies; player 0 (attacker) survives by eliminating them.
    s = applyDamage(s, 1, 1000);
    s = tick(s, allIdle(s), LEVEL_BOXES).state;
    s = runTicks(s, s.phaseEndTick - s.tick, allIdle); // -> next buy phase
    expect(s.matchPhase).toBe(PHASE_BUY);
    expect(s.weaponPrimary[0]).toBe(WEAPON_FALCON); // survivor keeps weapon
    expect(s.armor[0]).toBe(50); // and armor
    expect(s.weaponPrimary[1]).toBe(255); // dead player reset to Viper-only (WEAPON_NONE primary)
    expect(s.weaponSecondary[1]).toBe(WEAPON_VIPER);
    expect(s.armor[1]).toBe(0);
  });
});

describe("spectate target selection", () => {
  it("lists only living teammates, excluding self and enemies", () => {
    const s = startMatch(createMatchState(1, 4, TINY_CONFIG)); // teams: [0]=atk,[1]=def,[2]=atk,[3]=def
    expect(livingTeammates(s, 0)).toEqual([2]);
    const dead = applyDamage(s, 2, 1000);
    expect(livingTeammates(dead, 0)).toEqual([]);
  });
});

describe("friendly fire off in match mode", () => {
  it("raycastPlayers with excludeTeammates skips same-team targets", () => {
    const s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s.posX[1] = 0;
    s.posY[1] = 0;
    s.posZ[1] = 5;
    const origin = { x: 0, y: 1.6, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    // player 0 (attacker) vs player 1 (defender): normal hit.
    const hitEnemy = raycastPlayers(s, 0, origin, dir, 20, true);
    expect(hitEnemy?.playerIndex).toBe(1);

    const same = startMatch(createMatchState(1, 2, TINY_CONFIG));
    same.team[1] = TEAM_ATTACKERS; // force same team as shooter
    same.posX[1] = 0;
    same.posZ[1] = 5;
    const hitTeammate = raycastPlayers(same, 0, origin, dir, 20, true);
    expect(hitTeammate).toBeNull();
    const hitWithoutFilter = raycastPlayers(same, 0, origin, dir, 20, false);
    expect(hitWithoutFilter?.playerIndex).toBe(1);
  });
});

describe("barriers", () => {
  it("block only the gated team during the buy phase, and disappear in the round phase", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    // Player 0 (attacker) spawns south of z=-8 and tries to run north (+Z).
    s.posX[0] = 0;
    s.posZ[0] = -12;
    s.velX[0] = 0;
    s.velZ[0] = 0;
    for (let t = 0; t < 200; t++) {
      s = tick(s, [{ ...idle(0), forward: 1 }, idle()], LEVEL_BOXES).state;
      if (s.matchPhase !== PHASE_BUY) break;
    }
    // Blocked well south of the barrier at z=-8.
    expect(s.posZ[0]).toBeLessThan(-8);

    // Advance into the round phase and try again: barrier is gone.
    s = advanceToRound(s);
    s.posX[0] = 0;
    s.posZ[0] = -12;
    s.velX[0] = 0;
    s.velZ[0] = 0;
    for (let t = 0; t < 200; t++) {
      s = tick(s, [{ ...idle(0), forward: 1 }, idle()], LEVEL_BOXES).state;
    }
    expect(s.posZ[0]).toBeGreaterThan(-8);
  });
});

describe("match determinism", () => {
  it("two identical scripted 2v2 runs through buy/round/kill/round-end are byte-identical every 100 ticks", () => {
    function scriptedInput(t: number, i: number): InputFrame {
      return {
        ...idle((t * 0.01 + i) % 6.28),
        forward: (t + i) % 7 === 0 ? 1 : 0,
        interact: (t + i) % 11 === 0,
      };
    }

    function run(): string[] {
      let s = startMatch(createMatchState(777, 4, TINY_CONFIG));
      const snapshots: string[] = [];
      for (let t = 0; t < 400; t++) {
        const inputs = Array.from({ length: 4 }, (_, i) => scriptedInput(t, i));
        s = tick(s, inputs, LEVEL_BOXES).state;
        if (t === 50) s = applyDamage(s, 1, 30); // deterministic scripted damage event
        if ((t + 1) % 100 === 0) snapshots.push(serializeState(s));
      }
      return snapshots;
    }

    const a = run();
    const b = run();
    expect(a.length).toBe(4);
    expect(a).toEqual(b);
  });
});
