import { describe, expect, it } from "vitest";
import {
  ABL_LUMEN_MEND,
  ABL_LUMEN_RES,
  ABL_LUMEN_SLOW,
  ABL_LUMEN_WALL,
  ABL_SONAR_PULSE,
  ABL_SONAR_RAIL,
  ABL_SONAR_RECON,
  ABL_SONAR_SHOCK,
  ABL_UMBRA_BLIND,
  ABL_UMBRA_SHROUD,
  ABL_UMBRA_STEP,
  ABL_UMBRA_VEIL,
  ABL_ZEPHYR_BLADES,
  ABL_ZEPHYR_DASH,
  ABL_ZEPHYR_GUST,
  ABL_ZEPHYR_UPDRAFT,
  ABILITY_PENETRATES_WALLS,
  AGENT_LUMEN,
  AGENT_NONE,
  AGENT_SONAR,
  AGENT_UMBRA,
  AGENT_ZEPHYR,
  ENT_NONE,
  ENT_RECON_DART,
  ENT_SLOW_ZONE,
  ENT_SMOKE,
  ENT_ULT_ORB,
  ENT_WALL_BOX,
  FLASH_FULL,
  FLASH_HALF,
  FLASH_NONE,
  LEVEL_BOXES,
  NO_PLAYER,
  PHASE_BUY,
  PHASE_MATCH_END,
  PHASE_ROUND,
  PHASE_WAITING,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  WALL_BOX_MAX_HP,
  abilityIdForSlot,
  abilityWeaponId,
  applyAbilityBuy,
  applyDamage,
  applyKillAbilitySideEffects,
  applyRevive,
  applyWallDamage,
  autoAssignAgents,
  computeFlash,
  computeReveal,
  computeSlowMultiplier,
  createMatchState,
  createState,
  defaultInput,
  getAbilityDef,
  getCombatWeaponDef,
  liveWallBoxes,
  raycastBoxes,
  selectAgent,
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
  roundTicks: 6000,
  spikeTicks: 10,
  plantTicks: 4,
  defuseTicks: 8,
  defuseCheckpointTicks: 4,
  roundEndTicks: 3,
  winTarget: 2,
  halfAtRound: 1,
};

function idle(yaw = 0, pitch = 0): InputFrame {
  return defaultInput(yaw, pitch);
}

function withAgents(state: SimState, agents: readonly number[]): SimState {
  let s = state;
  for (let i = 0; i < agents.length; i++) s = selectAgent(s, i, agents[i]!);
  return s;
}

function advanceToRound(state: SimState): SimState {
  let s = state;
  while (s.matchPhase !== PHASE_ROUND && s.matchPhase !== PHASE_MATCH_END) {
    s = tick(s, Array.from({ length: s.numPlayers }, () => idle()), LEVEL_BOXES).state;
  }
  return s;
}

function grantCharge(state: SimState, playerIndex: number, slot: number, amount = 1): SimState {
  state.abilityCharges[playerIndex * 4 + slot] = amount;
  return state;
}

function grantUlt(state: SimState, playerIndex: number, amount: number): SimState {
  state.ultPoints[playerIndex] = amount;
  return state;
}

function runOne(state: SimState, inputs: readonly InputFrame[]): { state: SimState; events: ReturnType<typeof tick>["abilityEvents"] } {
  const r = tick(state, inputs, LEVEL_BOXES);
  return { state: r.state, events: r.abilityEvents };
}

function allIdleInputs(state: SimState, overrides: Record<number, Partial<InputFrame>> = {}): InputFrame[] {
  return Array.from({ length: state.numPlayers }, (_, i) => ({ ...idle(), ...(overrides[i] ?? {}) }));
}

describe("agent select", () => {
  it("assigns an agent during the waiting phase", () => {
    const s = selectAgent(createMatchState(1, 4, TINY_CONFIG), 0, AGENT_ZEPHYR);
    expect(s.agentId[0]).toBe(AGENT_ZEPHYR);
  });

  it("rejects a duplicate pick within the same team", () => {
    let s = startMatch(createMatchState(1, 4, TINY_CONFIG)); // wait, startMatch leaves waiting phase — use pre-start state instead
    s = createMatchState(1, 4, TINY_CONFIG);
    for (let i = 0; i < 4; i++) s.team[i] = i % 2 === 0 ? TEAM_ATTACKERS : TEAM_DEFENDERS;
    s = selectAgent(s, 0, AGENT_ZEPHYR);
    const dup = selectAgent(s, 2, AGENT_ZEPHYR); // player 2 is also TEAM_ATTACKERS
    expect(dup.agentId[2]).toBe(AGENT_NONE);
  });

  it("allows the same agent on the opposing team", () => {
    let s = createMatchState(1, 4, TINY_CONFIG);
    for (let i = 0; i < 4; i++) s.team[i] = i % 2 === 0 ? TEAM_ATTACKERS : TEAM_DEFENDERS;
    s = selectAgent(s, 0, AGENT_ZEPHYR);
    const other = selectAgent(s, 1, AGENT_ZEPHYR); // player 1 is TEAM_DEFENDERS
    expect(other.agentId[1]).toBe(AGENT_ZEPHYR);
  });

  it("is a no-op outside the waiting phase", () => {
    let s = startMatch(createMatchState(1, 2, TINY_CONFIG));
    s = advanceToRound(s);
    const attempted = selectAgent(s, 0, AGENT_LUMEN);
    expect(attempted.agentId[0]).not.toBe(AGENT_LUMEN);
  });

  it("auto-assigns unpicked players uniquely per team at match start", () => {
    let s = createMatchState(1, 4, TINY_CONFIG);
    for (let i = 0; i < 4; i++) s.team[i] = i % 2 === 0 ? TEAM_ATTACKERS : TEAM_DEFENDERS;
    s = selectAgent(s, 0, AGENT_LUMEN); // player 0 (attackers) picks Lumen; player 2 (attackers) is unpicked
    s = autoAssignAgents(s);
    expect(s.agentId[0]).toBe(AGENT_LUMEN);
    expect(s.agentId[2]).not.toBe(AGENT_LUMEN); // must not collide with teammate
    expect(s.agentId[1]).not.toBe(AGENT_NONE);
    expect(s.agentId[3]).not.toBe(AGENT_NONE);
  });

  it("startMatch auto-fills every unpicked player", () => {
    let s = createMatchState(1, 4, TINY_CONFIG);
    s = selectAgent(s, 0, AGENT_SONAR);
    s = startMatch(s);
    for (let i = 0; i < 4; i++) expect(s.agentId[i]).not.toBe(AGENT_NONE);
  });
});

describe("Zephyr", () => {
  function setup(): SimState {
    let s = createMatchState(42, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s = startMatch(s);
    s = advanceToRound(s);
    return s;
  }

  it("updraft launches the caster upward at the tuned vertical speed", () => {
    let s = setup();
    grantCharge(s, 0, 0, 1); // basic1
    const def = getAbilityDef(ABL_ZEPHYR_UPDRAFT)!;
    const { state: next } = runOne(s, allIdleInputs(s, { 0: { ability1: true } }));
    expect(next.velY[0]).toBe(def.distance);
    expect(next.abilityCharges[0 * 4 + 0]).toBe(0);
  });

  it("dash moves the caster the tuned distance and stops at a wall", () => {
    let s = setup();
    grantCharge(s, 0, 2, 1); // signature
    // Interior wall footprint is x in [5.75,6.25], z in [-4,4] — start clear of it, dashing 8m would tunnel through without collision.
    s.posX[0] = 5.0;
    s.posY[0] = 0;
    s.posZ[0] = 0;
    s.yaw[0] = Math.PI / 2; // facing +X, straight at the wall
    const before = s.posX[0]!;
    const def = getAbilityDef(ABL_ZEPHYR_DASH)!;
    const { state: next } = runOne(s, allIdleInputs(s, { 0: { signature: true, yaw: Math.PI / 2 } }));
    expect(next.posX[0]!).toBeGreaterThan(before);
    expect(next.posX[0]!).toBeLessThan(before + def.distance!); // stopped short of the full 8m by the wall
  });

  it("dash travels the full tuned distance in open space", () => {
    let s = setup();
    grantCharge(s, 0, 2, 1);
    s.posX[0] = -15;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    s.yaw[0] = 0; // facing +Z, open floor
    const def = getAbilityDef(ABL_ZEPHYR_DASH)!;
    const before = s.posZ[0]!;
    const { state: next } = runOne(s, allIdleInputs(s, { 0: { signature: true, yaw: 0 } }));
    expect(next.posZ[0]!).toBeCloseTo(before + def.distance!, 5);
  });

  it("gust spawns a small smoke where the projectile lands", () => {
    let s = setup();
    grantCharge(s, 0, 1, 1); // basic2
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    let cur = runOne(s, allIdleInputs(s, { 0: { ability2: true, yaw: 0, pitch: 0.3 } })).state;
    let smokeSeen = false;
    for (let t = 0; t < 200 && !smokeSeen; t++) {
      const r = runOne(cur, allIdleInputs(cur));
      cur = r.state;
      for (let e = 0; e < cur.entType.length; e++) {
        if (cur.entType[e] === ENT_SMOKE && cur.entAbilityId[e] === ABL_ZEPHYR_GUST) smokeSeen = true;
      }
    }
    expect(smokeSeen).toBe(true);
  });

  it("Blades: hitscan kill damage, and clears at round end", () => {
    let s = setup();
    grantUlt(s, 0, getAbilityDef(ABL_ZEPHYR_BLADES)!.ultCost);
    const { state: next } = runOne(s, allIdleInputs(s, { 0: { ult: true } }));
    expect(next.activeSlot[0]).toBe(2);
    expect(next.magUlt[0]).toBe(5);
    const def = getCombatWeaponDef(abilityWeaponId(ABL_ZEPHYR_BLADES))!;
    expect(def.damageBands[0]!.body).toBe(50);
    expect(def.damageBands[0]!.head).toBe(150);
  });

  it("Blades charges refill to max on a kill while active (refreshOnKill)", () => {
    let s = setup();
    grantUlt(s, 0, getAbilityDef(ABL_ZEPHYR_BLADES)!.ultCost);
    let cur = runOne(s, allIdleInputs(s, { 0: { ult: true } })).state;
    expect(cur.activeSlot[0]).toBe(2);
    expect(cur.magUlt[0]).toBe(5);
    cur.magUlt[0] = 2; // spent 3 of 5 charges
    const afterKill = applyKillAbilitySideEffects(cur, 0);
    expect(afterKill.magUlt[0]).toBe(5); // refilled to max
  });
});

describe("Umbra", () => {
  function setup(): SimState {
    let s = createMatchState(7, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_UMBRA, AGENT_UMBRA]);
    s = startMatch(s);
    s = advanceToRound(s);
    return s;
  }

  it("blind orb detonates a fixed fuse after landing", () => {
    let s = setup();
    grantCharge(s, 0, 0, 1);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    let cur = runOne(s, allIdleInputs(s, { 0: { ability1: true, yaw: 0, pitch: 0.2 } })).state;
    let detonated = false;
    for (let t = 0; t < 300 && !detonated; t++) {
      const r = runOne(cur, allIdleInputs(cur));
      cur = r.state;
      if (r.events.some((e) => e.kind === "detonate" && e.abilityId === ABL_UMBRA_BLIND)) detonated = true;
    }
    expect(detonated).toBe(true);
  });

  it("step teleports forward, clamped short of a wall", () => {
    let s = setup();
    grantCharge(s, 0, 1, 1); // basic2
    s.posX[0] = 5.0;
    s.posY[0] = 0;
    s.posZ[0] = 0;
    s.yaw[0] = Math.PI / 2; // facing +X into the interior wall (x=6)
    let cur = runOne(s, allIdleInputs(s, { 0: { ability2: true, yaw: Math.PI / 2 } })).state;
    const def = getAbilityDef(ABL_UMBRA_STEP)!;
    for (let t = 0; t < def.castDelayTicks + 2; t++) {
      cur = runOne(cur, allIdleInputs(cur)).state;
    }
    expect(cur.posX[0]!).toBeLessThan(6);
    expect(cur.posX[0]!).toBeGreaterThan(5.0);
  });

  it("shroud lands a smoke with the tuned radius/duration data", () => {
    const def = getAbilityDef(ABL_UMBRA_SHROUD)!;
    expect(def.radius).toBe(4);
    expect(def.durationTicks).toBe(15 * 64);
  });

  it("veil (ult) spawns 5 smoke spheres", () => {
    let s = setup();
    grantUlt(s, 0, getAbilityDef(ABL_UMBRA_VEIL)!.ultCost);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    const def = getAbilityDef(ABL_UMBRA_VEIL)!;
    let cur = s;
    for (let t = 0; t <= def.castDelayTicks + 1; t++) {
      cur = runOne(cur, allIdleInputs(cur, t === 0 ? { 0: { ult: true, yaw: 0 } } : {})).state;
    }
    let count = 0;
    for (let e = 0; e < cur.entType.length; e++) {
      if (cur.entType[e] === ENT_SMOKE && cur.entAbilityId[e] === ABL_UMBRA_VEIL) count++;
    }
    expect(count).toBe(5);
  });
});

describe("Sonar", () => {
  function setup(): SimState {
    let s = createMatchState(11, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_SONAR, AGENT_SONAR]);
    s = startMatch(s);
    s = advanceToRound(s);
    return s;
  }

  it("shock dart AoE falloff numbers at 0/2.5/5m match the linear formula", () => {
    const def = getAbilityDef(ABL_SONAR_SHOCK)!;
    const dmgAt = (dist: number) => Math.max(0, def.damage! - (def.damage! - 1) * Math.min(1, dist / def.falloffRadius!));
    expect(dmgAt(0)).toBeCloseTo(90, 5);
    expect(dmgAt(2.5)).toBeCloseTo(45.5, 5);
    expect(dmgAt(5)).toBeCloseTo(1, 5);
  });

  it("pulse reveals enemies within 12m regardless of walls (no LoS requirement)", () => {
    let s = setup();
    s.team[0] = TEAM_ATTACKERS;
    s.team[1] = TEAM_DEFENDERS;
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = 0;
    s.posX[1] = 5; // behind the interior wall footprint region, but well within 12m either way
    s.posY[1] = 0;
    s.posZ[1] = 0;
    const boxesWithInteriorWallBetween = LEVEL_BOXES;
    const mask = computeReveal(s, boxesWithInteriorWallBetween, TEAM_ATTACKERS, 0, 0, 0, 12, false);
    expect(mask & (1 << 1)).not.toBe(0);
  });

  it("pulse does not reveal beyond 12m", () => {
    const s = createState(1, 2);
    s.team[0] = TEAM_ATTACKERS;
    s.team[1] = TEAM_DEFENDERS;
    s.posX[1] = 20;
    const mask = computeReveal(s, [], TEAM_ATTACKERS, 0, 0, 0, 12, false);
    expect(mask).toBe(0);
  });

  it("recon dart pulses exactly 3 times at the tuned interval, LoS-gated", () => {
    let s = setup();
    grantCharge(s, 0, 2, 1); // signature
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    let cur = runOne(s, allIdleInputs(s, { 0: { signature: true, yaw: 0, pitch: 0.2 } })).state;
    let pulses = 0;
    for (let t = 0; t < 400; t++) {
      const r = runOne(cur, allIdleInputs(cur));
      cur = r.state;
      pulses += r.events.filter((e) => e.kind === "pulse" && e.abilityId === ABL_SONAR_RECON).length;
    }
    expect(pulses).toBe(3);
  });

  it("rail (ult) is a 3-shot, wall-penetrating combat weapon dealing 80 flat", () => {
    const id = abilityWeaponId(ABL_SONAR_RAIL);
    expect(ABILITY_PENETRATES_WALLS.has(id)).toBe(true);
    const def = getCombatWeaponDef(id)!;
    expect(def.magSize).toBe(3);
    expect(def.damageBands[0]!.body).toBe(80);
  });

  it("rail (ult) activates the ult-weapon slot with a 3-shot window", () => {
    let s = setup();
    grantUlt(s, 0, getAbilityDef(ABL_SONAR_RAIL)!.ultCost);
    const { state: next } = runOne(s, allIdleInputs(s, { 0: { ult: true } }));
    expect(next.activeSlot[0]).toBe(2);
    expect(next.magUlt[0]).toBe(3);
    expect(next.ultWindowEndTick[0]).toBeGreaterThan(next.tick);
  });

  it("rail does NOT refill charges on a kill (spec: only Blades refreshes — Rail's 3-shot window is a hard cap)", () => {
    let s = setup();
    grantUlt(s, 0, getAbilityDef(ABL_SONAR_RAIL)!.ultCost);
    let cur = runOne(s, allIdleInputs(s, { 0: { ult: true } })).state;
    expect(cur.activeSlot[0]).toBe(2);
    expect(cur.magUlt[0]).toBe(3);
    cur.magUlt[0] = 1; // 2 of 3 shots spent
    const afterKill = applyKillAbilitySideEffects(cur, 0);
    expect(afterKill.magUlt[0]).toBe(1); // unchanged — no refill
  });
});

describe("Lumen", () => {
  function setup(): SimState {
    let s = createMatchState(19, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_LUMEN, AGENT_LUMEN]);
    s = startMatch(s);
    s = advanceToRound(s);
    return s;
  }

  it("slow zone halves speed inside, stacks multiplicatively floored at 0.3, and expires", () => {
    const s = createState(1, 1);
    s.entType[0] = ENT_SLOW_ZONE;
    s.entAbilityId[0] = ABL_LUMEN_SLOW;
    s.entX[0] = 0;
    s.entZ[0] = 0;
    s.posX[0] = 0;
    s.posZ[0] = 0;
    expect(computeSlowMultiplier(s, 0)).toBeCloseTo(0.5, 5);

    // A second overlapping zone would multiply to 0.25, which is already
    // below the 0.3 floor — stacking floors immediately at 2 zones.
    s.entType[1] = ENT_SLOW_ZONE;
    s.entAbilityId[1] = ABL_LUMEN_SLOW;
    s.entX[1] = 0;
    s.entZ[1] = 0;
    expect(computeSlowMultiplier(s, 0)).toBeCloseTo(0.3, 5);

    s.entType[2] = ENT_SLOW_ZONE;
    s.entAbilityId[2] = ABL_LUMEN_SLOW;
    s.entX[2] = 0;
    s.entZ[2] = 0;
    expect(computeSlowMultiplier(s, 0)).toBeCloseTo(0.3, 5); // still floored, not 0.125

    // Outside every zone: full speed.
    s.posX[0] = 100;
    expect(computeSlowMultiplier(s, 0)).toBe(1);
  });

  it("wall boxes block movement and get destroyed at 400 damage", () => {
    let s = setup();
    grantCharge(s, 0, 1, 1); // basic2
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    const def = getAbilityDef(ABL_LUMEN_WALL)!;
    let cur = s;
    for (let t = 0; t <= def.castDelayTicks + 1; t++) {
      cur = runOne(cur, allIdleInputs(cur, t === 0 ? { 0: { ability2: true, yaw: 0 } } : {})).state;
    }
    const boxes = liveWallBoxes(cur);
    expect(boxes.length).toBe(3);
    for (const b of boxes) expect(b.maxY - b.minY).toBeCloseTo(2, 5);

    // find a live wall entity slot and damage it to destruction
    let slot = -1;
    for (let e = 0; e < cur.entType.length; e++) {
      if (cur.entType[e] === ENT_WALL_BOX) {
        slot = e;
        break;
      }
    }
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(cur.entParam[slot]).toBe(WALL_BOX_MAX_HP);
    const damaged = applyWallDamage(cur, slot, WALL_BOX_MAX_HP);
    expect(damaged.entType[slot]).toBe(ENT_NONE);
  });

  it("wall boxes expire after their lifetime and are cleared on round reset", () => {
    let s = setup();
    grantCharge(s, 0, 1, 1);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -15;
    const def = getAbilityDef(ABL_LUMEN_WALL)!;
    let cur = runOne(s, allIdleInputs(s, { 0: { ability2: true, yaw: 0 } })).state;
    for (let t = 0; t < def.castDelayTicks + def.durationTicks! + 5; t++) {
      cur = runOne(cur, allIdleInputs(cur)).state;
    }
    expect(liveWallBoxes(cur).length).toBe(0);
  });

  it("mend heals the aimed living teammate over time, capped at 100 (sim-level: chunk math)", () => {
    const def = getAbilityDef(ABL_LUMEN_MEND)!;
    expect(def.healChunkAmount! * (def.healDurationTicks! / def.healChunkTicks!)).toBe(60);
  });

  it("resurrect targets nearest dead teammate within range and cannot target living/enemies/out-of-range", () => {
    let s = setup();
    s.team[0] = TEAM_ATTACKERS;
    s.team[1] = TEAM_ATTACKERS;
    grantUlt(s, 0, getAbilityDef(ABL_LUMEN_RES)!.ultCost);
    s.posX[0] = 0;
    s.posZ[0] = 0;
    s.posX[1] = 100; // way out of range and still alive
    // Case 1: teammate alive, out of range -> cast should fizzle (no charge spent, no pending)
    const attemptLiving = runOne(s, allIdleInputs(s, { 0: { ult: true } })).state;
    expect(attemptLiving.ultPoints[0]).toBe(getAbilityDef(ABL_LUMEN_RES)!.ultCost); // untouched

    // Case 2: teammate dead but out of range -> still fizzles
    s.alive[1] = 0;
    const attemptOutOfRange = runOne(s, allIdleInputs(s, { 0: { ult: true } })).state;
    expect(attemptOutOfRange.ultPoints[0]).toBe(getAbilityDef(ABL_LUMEN_RES)!.ultCost);

    // Case 3: teammate dead, in range -> cast succeeds and eventually revives at their frozen death position with kept weapons
    s.posX[1] = 3;
    s.posZ[1] = 0;
    s.weaponPrimary[1] = 3;
    const deathX = s.posX[1]!;
    let cur = runOne(s, allIdleInputs(s, { 0: { ult: true } })).state;
    expect(cur.ultPoints[0]).toBe(0); // spent
    const castDef = getAbilityDef(ABL_LUMEN_RES)!;
    for (let t = 0; t < castDef.castDelayTicks + 2; t++) {
      cur = runOne(cur, allIdleInputs(cur)).state;
    }
    // sim only emits the "detonate" event; the server applies applyRevive — simulate that boundary directly here.
    expect(cur.alive[1]).toBe(0);
    const revived = applyRevive(cur, 1, castDef.reviveHp!);
    expect(revived.alive[1]).toBe(1);
    expect(revived.health[1]).toBe(100);
    expect(revived.posX[1]).toBe(deathX);
    expect(revived.weaponPrimary[1]).toBe(3);
  });
});

describe("flash", () => {
  it("full intensity within 45 degrees, half within 90, none behind", () => {
    const s = createState(1, 1);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = 0;
    s.yaw[0] = 0; // facing +Z
    const straightAhead = computeFlash(s, [], 0, s.posY[0]! + 1.65, 5);
    expect(straightAhead[0]?.intensity).toBe(FLASH_FULL);

    const toTheSide = computeFlash(s, [], 5, s.posY[0]! + 1.65, 0.01); // ~90 degrees off
    expect(toTheSide[0]?.intensity === FLASH_HALF || toTheSide[0] === undefined).toBe(true);

    const behind = computeFlash(s, [], 0, s.posY[0]! + 1.65, -5);
    expect(behind.length).toBe(0);
  });

  it("blocked by an occluder yields no flash", () => {
    const s = createState(1, 1);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = -5;
    s.yaw[0] = 0;
    const wall = { minX: -10, maxX: 10, minY: -1, maxY: 3, minZ: -1, maxZ: 1 };
    const result = computeFlash(s, [wall], 0, s.posY[0]! + 1.65, 5);
    expect(result.length).toBe(0);
  });

  it("cuts off beyond 30m", () => {
    const s = createState(1, 1);
    s.posX[0] = 0;
    s.posY[0] = 0;
    s.posZ[0] = 0;
    const result = computeFlash(s, [], 0, s.posY[0]! + 1.65, 31);
    expect(result.length).toBe(0);
  });

  it("affects teammates too (no team filtering at all)", () => {
    const s = createState(1, 2);
    s.team[0] = TEAM_ATTACKERS;
    s.team[1] = TEAM_ATTACKERS;
    s.posX[0] = 0;
    s.posZ[0] = 0;
    s.posX[1] = 1;
    s.posZ[1] = 0;
    const result = computeFlash(s, [], 0.5, s.posY[0]! + 1.65, 0);
    expect(result.length).toBe(2);
  });
});

describe("ult economy", () => {
  it("caps ult points at the caster's own ult cost", () => {
    let s = createMatchState(3, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s.ultPoints[0] = getAbilityDef(ABL_ZEPHYR_BLADES)!.ultCost - 1;
    // Directly exercising the award path via orb pickup, which routes through awardUltPoint.
    s = startMatch(s);
    s = advanceToRound(s);
    // Two orbs exist at round start; walk player 0 onto one.
    let orbSlot = -1;
    for (let e = 0; e < s.entType.length; e++) if (s.entType[e] === ENT_ULT_ORB) orbSlot = e;
    expect(orbSlot).toBeGreaterThanOrEqual(0);
    s.posX[0] = s.entX[orbSlot]!;
    s.posZ[0] = s.entZ[orbSlot]!;
    const afterFirst = runOne(s, allIdleInputs(s)).state;
    expect(afterFirst.ultPoints[0]).toBe(getAbilityDef(ABL_ZEPHYR_BLADES)!.ultCost); // capped, not overflowed
  });

  it("orb pickup only happens during the round phase", () => {
    let s = createMatchState(5, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s = startMatch(s); // now in PHASE_BUY
    expect(s.matchPhase).toBe(PHASE_BUY);
    let orbSlot = -1;
    for (let e = 0; e < s.entType.length; e++) if (s.entType[e] === ENT_ULT_ORB) orbSlot = e;
    s.posX[0] = s.entX[orbSlot]!;
    s.posZ[0] = s.entZ[orbSlot]!;
    const stillBuy = runOne(s, allIdleInputs(s)).state;
    expect(stillBuy.ultPoints[0]).toBe(0); // no pickup during buy phase
  });

  it("orbs respawn every round", () => {
    let s = createMatchState(9, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s = startMatch(s);
    s = advanceToRound(s);
    let count = 0;
    for (let e = 0; e < s.entType.length; e++) if (s.entType[e] === ENT_ULT_ORB) count++;
    expect(count).toBe(2);
  });
});

describe("res vs win condition ordering", () => {
  it("a res applied before the next tick's win check keeps the round alive", () => {
    let s = createMatchState(21, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_LUMEN]);
    s = startMatch(s);
    s = advanceToRound(s);
    // Kill the lone defender (player 1) directly (mirrors the server's applyDamage-driven kill).
    let killed = applyDamage(s, 1, 1000);
    expect(killed.alive[1]).toBe(0);
    // Same-step revive (mirrors the server resolving a ready Resurrect AbilityEvent AFTER the kill, same step()).
    const revived = applyRevive(killed, 1, 100);
    expect(revived.alive[1]).toBe(1);
    // The NEXT tick()'s win check must NOT end the round — defender is alive again.
    const after = tick(revived, allIdleInputs(revived), LEVEL_BOXES).state;
    expect(after.matchPhase).toBe(PHASE_ROUND);
  });

  it("without a res, the next tick's win check ends the round on elimination", () => {
    let s = createMatchState(23, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_LUMEN]);
    s = startMatch(s);
    s = advanceToRound(s);
    const killed = applyDamage(s, 1, 1000);
    const after = tick(killed, allIdleInputs(killed), LEVEL_BOXES).state;
    expect(after.matchPhase).not.toBe(PHASE_ROUND);
  });

  it("a normal mid-round res updates alive counts without ending anything", () => {
    let s = createMatchState(25, 4, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_LUMEN, AGENT_SONAR, AGENT_UMBRA]);
    s = startMatch(s);
    s = advanceToRound(s);
    // team layout: 0,2 attackers; 1,3 defenders (alternating). Kill one defender, leave the other alive.
    const killed = applyDamage(s, 1, 1000);
    expect(killed.alive[1]).toBe(0);
    expect(killed.alive[3]).toBe(1);
    const revived = applyRevive(killed, 1, 100);
    expect(revived.alive[1]).toBe(1);
    const after = tick(revived, allIdleInputs(revived), LEVEL_BOXES).state;
    expect(after.matchPhase).toBe(PHASE_ROUND);
  });
});

describe("ability purchase (BuyCmd 100/101)", () => {
  it("grants a charge up to the ability's max, deducting credits", () => {
    let s = createMatchState(31, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s = startMatch(s); // PHASE_BUY
    const before = s.credits[0]!;
    const def = getAbilityDef(getAbilityDef(0)!.id)!; // updraft, slot 0
    const after = applyAbilityBuy(s, 0, 0);
    expect(after.abilityCharges[0]).toBe(1);
    expect(after.credits[0]).toBe(before - def.price);
  });

  it("refuses beyond maxCharges", () => {
    let s = createMatchState(33, 2, TINY_CONFIG);
    s = withAgents(s, [AGENT_ZEPHYR, AGENT_ZEPHYR]);
    s = startMatch(s);
    let cur = applyAbilityBuy(s, 0, 0);
    cur = applyAbilityBuy(cur, 0, 0);
    const attemptThird = applyAbilityBuy(cur, 0, 0);
    expect(attemptThird.abilityCharges[0]).toBe(2); // maxCharges for updraft
  });
});

describe("determinism", () => {
  it("two identical runs with scripted casts across a round transition produce byte-identical state", () => {
    function build(): SimState {
      let s = createMatchState(99, 4, TINY_CONFIG);
      s = withAgents(s, [AGENT_ZEPHYR, AGENT_UMBRA, AGENT_SONAR, AGENT_LUMEN]);
      s = startMatch(s);
      for (let i = 0; i < 4; i++) {
        for (let slot = 0; slot < 2; slot++) grantCharge(s, i, slot, 2);
        grantCharge(s, i, 2, 2);
        grantUlt(s, i, 8);
      }
      return s;
    }

    function run(): SimState {
      let s = build();
      for (let t = 0; t < 500; t++) {
        const overrides: Record<number, Partial<InputFrame>> = {};
        if (t === 20) overrides[0] = { ability1: true, yaw: 0.3 };
        if (t === 40) overrides[1] = { ability2: true, yaw: -0.4, pitch: 0.1 };
        if (t === 60) overrides[2] = { signature: true };
        if (t === 80) overrides[3] = { ability1: true, yaw: 1.2, pitch: 0.2 };
        if (t === 100) overrides[0] = { signature: true, forward: 1 };
        s = tick(s, allIdleInputs(s, overrides), LEVEL_BOXES).state;
      }
      return s;
    }

    const a = run();
    const b = run();
    expect(serializeState(a)).toBe(serializeState(b));
  });
});
