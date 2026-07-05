import {
  AGENT_NONE,
  DEFAULT_BUY_TICKS,
  DEFAULT_DEFUSE_CHECKPOINT_TICKS,
  DEFAULT_DEFUSE_TICKS,
  DEFAULT_FIRST_ROUND_BUY_TICKS,
  DEFAULT_HALF_AT_ROUND,
  DEFAULT_LOSS_CREDITS,
  DEFAULT_OT_START_CREDITS,
  DEFAULT_PLANT_BONUS,
  DEFAULT_PLANT_TICKS,
  DEFAULT_ROUND_END_TICKS,
  DEFAULT_ROUND_TICKS,
  DEFAULT_SPIKE_TICKS,
  DEFAULT_WIN_CREDITS,
  DEFAULT_WIN_TARGET,
  ENT_NONE,
  MAX_ABILITY_ENTITIES,
  MAX_CREDITS,
  MAX_PLAYERS,
  MODE_DM,
  NO_PLAYER,
  PHASE_WAITING,
  ROUND_END_NONE,
  SPAWN_HEALTH,
  SPIKE_CARRIED,
  START_CREDITS,
  TEAM_NONE,
  WEAPON_NONE,
} from "./constants.js";
import { createPrngState } from "./prng.js";
import { WEAPON_VIPER, WEAPONS } from "./weapons/data.js";

/** Static, axis-aligned collision geometry. Defined once by level data (the
 * client's graybox) and consumed by both sim collision and rendering. */
export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** One player's input for a single tick. Plain, serializable, no methods. */
export interface InputFrame {
  readonly forward: number; // -1..1, local +forward
  readonly right: number; // -1..1, local +right
  readonly yaw: number; // radians, look yaw used to build the world-space wish direction
  readonly pitch: number; // radians, look pitch; movement ignores it, carried for view/raycast purposes
  readonly jump: boolean;
  readonly crouch: boolean;
  readonly walk: boolean;
  readonly fire: boolean; // consumed by weapons/logic.ts fire gating inside tick()
  readonly ads: boolean; // edge-triggered: cycles ADS stage
  readonly reload: boolean; // level-triggered: starts a reload if eligible
  readonly slot1: boolean; // edge-triggered: switch to primary slot
  readonly slot2: boolean; // edge-triggered: switch to secondary slot
  /** Level-triggered (held): channels plant/defuse in match mode. See match.ts. */
  readonly interact: boolean;
  /** Edge-triggered: cast a map ping (server-only concern — sim's tick() never reads this field). */
  readonly ping: boolean;
  /** M4a, edge-triggered: cast the agent's basic1/basic2/signature/ult ability. See abilities/logic.ts. */
  readonly ability1: boolean;
  readonly ability2: boolean;
  readonly signature: boolean;
  readonly ult: boolean;
}

export function defaultInput(yaw = 0, pitch = 0): InputFrame {
  return {
    forward: 0,
    right: 0,
    yaw,
    pitch,
    jump: false,
    crouch: false,
    walk: false,
    fire: false,
    ads: false,
    reload: false,
    slot1: false,
    slot2: false,
    interact: false,
    ping: false,
    ability1: false,
    ability2: false,
    signature: false,
    ult: false,
  };
}

/** One ability event this tick, as returned by tick(). Effects on players (damage/flash/slow/reveal/heal/res) are applied ONLY server-side (see abilities/effects.ts), never inside tick(). */
export interface AbilityEvent {
  readonly kind: "cast" | "detonate" | "pulse" | "expire";
  readonly owner: number;
  readonly abilityId: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Recon dart/pulse: which entity slot this came from (-1 if n/a), so the server can track per-dart pulse counts if needed. */
  readonly entitySlot: number;
}

/** One shot fired this tick, as returned by tick(). Damage/hit resolution happens server-side, outside tick(). */
export interface ShotEvent {
  readonly playerIndex: number;
  /** The shooter's ever-incrementing shot counter value for this shot (unique per shot, used as the spread hash input). */
  readonly shotIndex: number;
  readonly sprayIndex: number;
  readonly weaponId: number;
}

/**
 * Full match tuning table, stored INSIDE SimState (plain numbers only, no
 * methods) so the sim stays a pure function of (state, inputs) and tests can
 * shrink timers/win target deterministically. See createMatchState().
 */
export interface MatchConfig {
  readonly buyTicks: number;
  readonly firstRoundBuyTicks: number;
  readonly roundTicks: number;
  readonly spikeTicks: number;
  readonly plantTicks: number;
  readonly defuseTicks: number;
  readonly defuseCheckpointTicks: number;
  readonly roundEndTicks: number;
  readonly winTarget: number;
  readonly halfAtRound: number;
  readonly otStartCredits: number;
  readonly startCredits: number;
  readonly winCredits: number;
  readonly lossCredits: readonly [number, number, number];
  readonly plantBonus: number;
  readonly maxCredits: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = {
  buyTicks: DEFAULT_BUY_TICKS,
  firstRoundBuyTicks: DEFAULT_FIRST_ROUND_BUY_TICKS,
  roundTicks: DEFAULT_ROUND_TICKS,
  spikeTicks: DEFAULT_SPIKE_TICKS,
  plantTicks: DEFAULT_PLANT_TICKS,
  defuseTicks: DEFAULT_DEFUSE_TICKS,
  defuseCheckpointTicks: DEFAULT_DEFUSE_CHECKPOINT_TICKS,
  roundEndTicks: DEFAULT_ROUND_END_TICKS,
  winTarget: DEFAULT_WIN_TARGET,
  halfAtRound: DEFAULT_HALF_AT_ROUND,
  otStartCredits: DEFAULT_OT_START_CREDITS,
  startCredits: START_CREDITS,
  winCredits: DEFAULT_WIN_CREDITS,
  lossCredits: DEFAULT_LOSS_CREDITS,
  plantBonus: DEFAULT_PLANT_BONUS,
  maxCredits: MAX_CREDITS,
};

/**
 * Simulation state for up to MAX_PLAYERS players, stored as flat typed arrays
 * (ECS-lite) so it stays cheap to snapshot/serialize/hash and, later, to
 * transmit over the wire.
 */
export interface SimState {
  tick: number;
  prngState: number;
  /** The original seed passed to createState, constant across ticks — reused as the stateless shot-spread/respawn hash seed (see prng.ts hashSeed3). */
  readonly seed: number;
  readonly numPlayers: number;

  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly posZ: Float64Array;

  readonly velX: Float64Array;
  readonly velY: Float64Array;
  readonly velZ: Float64Array;

  readonly yaw: Float64Array;
  readonly pitch: Float64Array;
  readonly crouching: Uint8Array;
  readonly grounded: Uint8Array;

  // ---- Combat/gunplay state (M2) ----
  readonly health: Uint8Array;
  readonly armor: Uint8Array;
  readonly alive: Uint8Array;
  readonly respawnTick: Int32Array; // -1 = not scheduled

  readonly weaponPrimary: Uint8Array; // WEAPON_NONE (255) if not picked up yet
  readonly weaponSecondary: Uint8Array; // WEAPON_VIPER by default
  readonly activeSlot: Uint8Array; // 0 = primary, 1 = secondary
  readonly magPrimary: Uint16Array;
  readonly reservePrimary: Uint16Array;
  readonly magSecondary: Uint16Array;
  readonly reserveSecondary: Uint16Array;

  readonly shotCounter: Uint32Array; // ever-incrementing, per player; also the spread hash input
  readonly sprayIndex: Uint16Array;
  readonly ticksSinceFire: Uint16Array;
  readonly nextFireTick: Uint32Array;
  readonly reloadEndTick: Int32Array; // -1 = not reloading
  readonly equipEndTick: Int32Array; // -1 = not mid-equip-delay
  readonly adsStage: Uint8Array; // 0 = hip, 1.. = ADS stage
  readonly tagTicksLeft: Uint16Array;
  readonly landPenaltyTicksLeft: Uint16Array;
  readonly credits: Uint32Array;
  /** Bitmask of ads/reload/slot1/slot2 from the previous tick's input, for edge detection. */
  readonly prevButtons: Uint8Array;

  // ---- M3 match/round state ----
  /** MODE_DM (0) or MODE_MATCH (1). See constants.ts. */
  mode: number;
  /** Fixed tuning table for match mode; present (as DEFAULT_MATCH_CONFIG) even in DM, where it's unused. */
  config: MatchConfig;
  /** Per-player team: TEAM_ATTACKERS (0), TEAM_DEFENDERS (1), TEAM_NONE (255). */
  readonly team: Uint8Array;
  matchPhase: number;
  /** Absolute tick at which the current phase's timer expires (buy/round/roundEnd only). */
  phaseEndTick: number;
  roundNumber: number;
  /** Cumulative rounds won by the SQUAD that started the match assigned team 0 ("squad A"). See halvesSwapped. */
  scoreTeam0: number;
  /** Cumulative rounds won by squad B (started the match assigned team 1). */
  scoreTeam1: number;
  /** Current loss streak, indexed by CURRENT role (0 attackers, 1 defenders) — reset to 0 for both at half swap, so role-vs-squad indexing never matters across that boundary. */
  lossStreakTeam0: number;
  lossStreakTeam1: number;
  /** 0 before halftime, 1 after. Used to translate a round-winning ROLE into the persistent squad score counter (scoreTeam0/1). */
  halvesSwapped: number;
  /** Winning ROLE (0/1) of the most recently finished round, or ROUND_END_NONE-sentineled via NO_PLAYER-style 255 when n/a. */
  lastRoundWinnerTeam: number;
  /** Reason code (see ROUND_END_* constants) for the most recently finished round. */
  lastRoundEndReason: number;

  // ---- Spike ----
  spikeState: number; // SPIKE_CARRIED/DROPPED/PLANTED/DETONATED/DEFUSED
  spikeCarrier: number; // player index, or NO_PLAYER (255)
  spikeX: number;
  spikeY: number;
  spikeZ: number;
  /** Absolute tick the spike was planted, or -1. */
  spikePlantedTick: number;
  /** Ticks accumulated toward plantTicks by the current planter (0 if none active). */
  plantProgress: number;
  planterIndex: number; // NO_PLAYER if no one is currently channeling a plant
  /** Ticks accumulated toward defuseTicks by the current defuser (0 if none active or reset). */
  defuseProgress: number;
  defuserIndex: number; // NO_PLAYER if no one is currently channeling a defuse
  /** 1 once defuseProgress has ever reached defuseCheckpointTicks THIS plant — an interruption after that resumes from the checkpoint instead of 0. */
  defuseCheckpointHit: number;

  // ---- Buy/sell bookkeeping (for refunds — see damage.ts applySell) ----
  /** Loadout/armor snapshot taken at the start of the current buy phase — what a sell reverts to. */
  readonly weaponPrimaryAtBuyStart: Uint8Array;
  readonly weaponSecondaryAtBuyStart: Uint8Array;
  readonly armorAtBuyStart: Uint8Array;
  /** Item id purchased into that slot THIS buy phase (WEAPON_NONE if the slot's current item wasn't bought this buy phase — e.g. kept from a prior round, or never touched). Sellable only while this is set. */
  readonly primaryPurchasedItemId: Uint8Array;
  readonly secondaryPurchasedItemId: Uint8Array;
  /** Armor item id purchased this buy phase (BUY_ITEM_LIGHT_ARMOR/BUY_ITEM_HEAVY_ARMOR), or 255 (NO_PLAYER-reused sentinel) if none. */
  readonly armorPurchasedItemId: Uint8Array;

  // ---- M4a abilities/agents ----
  /** AGENT_NONE (255) until picked (see abilities/effects.ts selectAgent). */
  readonly agentId: Uint8Array;
  readonly ultPoints: Uint8Array;
  /** Flat [playerIndex*4 + slot] charge counts for ABILITY_SLOT_BASIC1/BASIC2/SIGNATURE (slot 3/ult is gated by ultPoints instead and always reads 0 here). */
  readonly abilityCharges: Uint8Array;
  /** Absolute tick the player's signature ability's NEXT charge finishes recharging, or -1 if already at max/no signature recharge in progress. */
  readonly signatureRechargeEndTick: Int32Array;
  /** Absolute tick a flash (if any) expires; compare against currentTick, not a countdown. 0 = never flashed / expired. */
  readonly flashedUntilTick: Int32Array;
  /** FLASH_NONE/HALF/FULL, valid only while currentTick < flashedUntilTick. */
  readonly flashIntensity: Uint8Array;
  /** Zephyr only: kills since the last free Dash-charge re-earn (see abilities/logic.ts killsToRefresh). */
  readonly dashKillCounter: Uint8Array;
  /** Ult-weapon (Blades/Rail) charge count while activeSlot === 2; unused (0) otherwise. */
  readonly magUlt: Uint8Array;
  /** Rail only: absolute tick its 3-shot activation window closes, or -1 if not active. */
  readonly ultWindowEndTick: Int32Array;
  /** Bitmask of ability1/ability2/signature/ult from the previous tick's input, for edge detection (see abilities/logic.ts). */
  readonly prevAbilityButtons: Uint8Array;

  // ---- M4a pending (cast-delayed) ability resolution — at most one in flight per player ----
  /** 255 = no pending cast. Charge/ult-points cost is deducted at cast time, not resolve time (Valorant locks it in on cast attempt). */
  readonly pendingAbilityId: Uint8Array;
  /** Absolute tick the pending cast resolves, or -1 if none pending. */
  readonly pendingReadyTick: Int32Array;
  readonly pendingOriginX: Float64Array;
  readonly pendingOriginY: Float64Array;
  readonly pendingOriginZ: Float64Array;
  readonly pendingYaw: Float64Array;
  /** Resurrect only: the dead teammate index chosen at cast time, re-validated at resolve time. NO_PLAYER otherwise. */
  readonly pendingTargetIndex: Uint8Array;

  // ---- M4a ability world-entities (projectiles, smokes, walls, zones, recon darts, ult orbs) ----
  readonly entType: Uint8Array;
  readonly entOwner: Uint8Array;
  readonly entAbilityId: Uint8Array;
  readonly entX: Float64Array;
  readonly entY: Float64Array;
  readonly entZ: Float64Array;
  /** Flight velocity while entType===ENT_PROJECTILE; reused as a fixed (unit-ish) long-axis direction vector for stationary ENT_WALL_BOX entities (see abilities/entities.ts) — never both at once for the same entity. */
  readonly entVelX: Float64Array;
  readonly entVelY: Float64Array;
  readonly entVelZ: Float64Array;
  readonly entSpawnTick: Int32Array;
  /** Meaning depends on entType: smoke/zone/wall/orb-respawn = expiry tick; reconDart = next-pulse-due tick; projectile = flight-timeout deadline. */
  readonly entEndTick: Int32Array;
  /** Meaning depends on entType: wallBox = current HP; reconDart = pulses remaining; otherwise unused (0). */
  readonly entParam: Int32Array;
}

const ADS_BIT = 1 << 0;
const SLOT1_BIT = 1 << 1;
const SLOT2_BIT = 1 << 2;

export function encodeEdgeButtons(input: Pick<InputFrame, "ads" | "slot1" | "slot2">): number {
  return (input.ads ? ADS_BIT : 0) | (input.slot1 ? SLOT1_BIT : 0) | (input.slot2 ? SLOT2_BIT : 0);
}

export function wasButtonHeld(prevButtons: number, bit: number): boolean {
  return (prevButtons & bit) !== 0;
}

export { ADS_BIT, SLOT1_BIT, SLOT2_BIT };

export function createState(seed: number, numPlayers: number = MAX_PLAYERS): SimState {
  return createStateInternal(seed, numPlayers, MODE_DM, DEFAULT_MATCH_CONFIG);
}

/**
 * Match-mode state: same shape as createState() (DM), but mode = MODE_MATCH
 * and `config` holds a full MatchConfig (defaults, or a partial override —
 * tests shrink timers/winTarget so round-flow tests don't need to run real
 * 30s/100s durations). Players start unassigned (TEAM_NONE) and in the
 * waiting phase; call the pure startMatch() helper (see match.ts) once
 * enough players have joined.
 */
export function createMatchState(seed: number, numPlayers: number = MAX_PLAYERS, config: Partial<MatchConfig> = {}): SimState {
  const fullConfig: MatchConfig = { ...DEFAULT_MATCH_CONFIG, ...config };
  return createStateInternal(seed, numPlayers, 1, fullConfig);
}

function createStateInternal(seed: number, numPlayers: number, mode: number, config: MatchConfig): SimState {
  if (numPlayers < 1 || numPlayers > MAX_PLAYERS) {
    throw new Error(`numPlayers must be in [1, ${MAX_PLAYERS}]`);
  }
  const health = new Uint8Array(numPlayers).fill(SPAWN_HEALTH);
  const alive = new Uint8Array(numPlayers).fill(1);
  const respawnTick = new Int32Array(numPlayers).fill(-1);
  const weaponPrimary = new Uint8Array(numPlayers).fill(WEAPON_NONE);
  const weaponSecondary = new Uint8Array(numPlayers).fill(WEAPON_VIPER);
  const activeSlot = new Uint8Array(numPlayers).fill(1); // start on the free sidearm
  const viperDef = WEAPONS[WEAPON_VIPER]!;
  const magSecondary = new Uint16Array(numPlayers).fill(viperDef.magSize);
  const reserveSecondary = new Uint16Array(numPlayers).fill(viperDef.reserveAmmo);
  const reloadEndTick = new Int32Array(numPlayers).fill(-1);
  const equipEndTick = new Int32Array(numPlayers).fill(-1);
  const credits = new Uint32Array(numPlayers).fill(mode === MODE_DM ? START_CREDITS : config.startCredits);

  return {
    tick: 0,
    prngState: createPrngState(seed),
    seed: seed >>> 0,
    numPlayers,
    posX: new Float64Array(numPlayers),
    posY: new Float64Array(numPlayers),
    posZ: new Float64Array(numPlayers),
    velX: new Float64Array(numPlayers),
    velY: new Float64Array(numPlayers),
    velZ: new Float64Array(numPlayers),
    yaw: new Float64Array(numPlayers),
    pitch: new Float64Array(numPlayers),
    crouching: new Uint8Array(numPlayers),
    // Defaults to grounded=true: spawn points sit exactly on the floor, and a
    // freshly-created player should read as "standing on the ground", not
    // "just left the ground" — the latter would make the very first tick's
    // grounded-transition-detection (see tick.ts's land-penalty check)
    // misfire as if they'd just landed from a jump they never took.
    grounded: new Uint8Array(numPlayers).fill(1),

    health,
    armor: new Uint8Array(numPlayers),
    alive,
    respawnTick,
    weaponPrimary,
    weaponSecondary,
    activeSlot,
    magPrimary: new Uint16Array(numPlayers),
    reservePrimary: new Uint16Array(numPlayers),
    magSecondary,
    reserveSecondary,
    shotCounter: new Uint32Array(numPlayers),
    sprayIndex: new Uint16Array(numPlayers),
    ticksSinceFire: new Uint16Array(numPlayers).fill(SPRAY_RESET_FILL),
    nextFireTick: new Uint32Array(numPlayers),
    reloadEndTick,
    equipEndTick,
    adsStage: new Uint8Array(numPlayers),
    tagTicksLeft: new Uint16Array(numPlayers),
    landPenaltyTicksLeft: new Uint16Array(numPlayers),
    credits,
    prevButtons: new Uint8Array(numPlayers),

    mode,
    config,
    team: new Uint8Array(numPlayers).fill(TEAM_NONE),
    matchPhase: PHASE_WAITING,
    phaseEndTick: -1,
    roundNumber: 0,
    scoreTeam0: 0,
    scoreTeam1: 0,
    lossStreakTeam0: 0,
    lossStreakTeam1: 0,
    halvesSwapped: 0,
    lastRoundWinnerTeam: NO_PLAYER,
    lastRoundEndReason: ROUND_END_NONE,

    spikeState: SPIKE_CARRIED,
    spikeCarrier: NO_PLAYER,
    spikeX: 0,
    spikeY: 0,
    spikeZ: 0,
    spikePlantedTick: -1,
    plantProgress: 0,
    planterIndex: NO_PLAYER,
    defuseProgress: 0,
    defuserIndex: NO_PLAYER,
    defuseCheckpointHit: 0,

    weaponPrimaryAtBuyStart: new Uint8Array(numPlayers).fill(WEAPON_NONE),
    weaponSecondaryAtBuyStart: new Uint8Array(numPlayers).fill(WEAPON_VIPER),
    armorAtBuyStart: new Uint8Array(numPlayers),
    primaryPurchasedItemId: new Uint8Array(numPlayers).fill(WEAPON_NONE),
    secondaryPurchasedItemId: new Uint8Array(numPlayers).fill(WEAPON_NONE),
    armorPurchasedItemId: new Uint8Array(numPlayers).fill(NO_PLAYER),

    agentId: new Uint8Array(numPlayers).fill(AGENT_NONE),
    ultPoints: new Uint8Array(numPlayers),
    abilityCharges: new Uint8Array(numPlayers * 4),
    signatureRechargeEndTick: new Int32Array(numPlayers).fill(-1),
    flashedUntilTick: new Int32Array(numPlayers),
    flashIntensity: new Uint8Array(numPlayers),
    dashKillCounter: new Uint8Array(numPlayers),
    magUlt: new Uint8Array(numPlayers),
    ultWindowEndTick: new Int32Array(numPlayers).fill(-1),
    prevAbilityButtons: new Uint8Array(numPlayers),

    pendingAbilityId: new Uint8Array(numPlayers).fill(255),
    pendingReadyTick: new Int32Array(numPlayers).fill(-1),
    pendingOriginX: new Float64Array(numPlayers),
    pendingOriginY: new Float64Array(numPlayers),
    pendingOriginZ: new Float64Array(numPlayers),
    pendingYaw: new Float64Array(numPlayers),
    pendingTargetIndex: new Uint8Array(numPlayers).fill(NO_PLAYER),

    entType: new Uint8Array(MAX_ABILITY_ENTITIES).fill(ENT_NONE),
    entOwner: new Uint8Array(MAX_ABILITY_ENTITIES).fill(NO_PLAYER),
    entAbilityId: new Uint8Array(MAX_ABILITY_ENTITIES),
    entX: new Float64Array(MAX_ABILITY_ENTITIES),
    entY: new Float64Array(MAX_ABILITY_ENTITIES),
    entZ: new Float64Array(MAX_ABILITY_ENTITIES),
    entVelX: new Float64Array(MAX_ABILITY_ENTITIES),
    entVelY: new Float64Array(MAX_ABILITY_ENTITIES),
    entVelZ: new Float64Array(MAX_ABILITY_ENTITIES),
    entSpawnTick: new Int32Array(MAX_ABILITY_ENTITIES),
    entEndTick: new Int32Array(MAX_ABILITY_ENTITIES),
    entParam: new Int32Array(MAX_ABILITY_ENTITIES),
  };
}

// Large enough that a freshly-created player is immediately "no recent fire"
// (sprayIndex stays 0) without special-casing tick 0 in weapons/logic.ts.
const SPRAY_RESET_FILL = 255;

/** Deep-clones a SimState (tick() never mutates its input in place). */
export function cloneState(state: SimState): SimState {
  return {
    tick: state.tick,
    prngState: state.prngState,
    seed: state.seed,
    numPlayers: state.numPlayers,
    posX: state.posX.slice(),
    posY: state.posY.slice(),
    posZ: state.posZ.slice(),
    velX: state.velX.slice(),
    velY: state.velY.slice(),
    velZ: state.velZ.slice(),
    yaw: state.yaw.slice(),
    pitch: state.pitch.slice(),
    crouching: state.crouching.slice(),
    grounded: state.grounded.slice(),

    health: state.health.slice(),
    armor: state.armor.slice(),
    alive: state.alive.slice(),
    respawnTick: state.respawnTick.slice(),
    weaponPrimary: state.weaponPrimary.slice(),
    weaponSecondary: state.weaponSecondary.slice(),
    activeSlot: state.activeSlot.slice(),
    magPrimary: state.magPrimary.slice(),
    reservePrimary: state.reservePrimary.slice(),
    magSecondary: state.magSecondary.slice(),
    reserveSecondary: state.reserveSecondary.slice(),
    shotCounter: state.shotCounter.slice(),
    sprayIndex: state.sprayIndex.slice(),
    ticksSinceFire: state.ticksSinceFire.slice(),
    nextFireTick: state.nextFireTick.slice(),
    reloadEndTick: state.reloadEndTick.slice(),
    equipEndTick: state.equipEndTick.slice(),
    adsStage: state.adsStage.slice(),
    tagTicksLeft: state.tagTicksLeft.slice(),
    landPenaltyTicksLeft: state.landPenaltyTicksLeft.slice(),
    credits: state.credits.slice(),
    prevButtons: state.prevButtons.slice(),

    mode: state.mode,
    config: state.config,
    team: state.team.slice(),
    matchPhase: state.matchPhase,
    phaseEndTick: state.phaseEndTick,
    roundNumber: state.roundNumber,
    scoreTeam0: state.scoreTeam0,
    scoreTeam1: state.scoreTeam1,
    lossStreakTeam0: state.lossStreakTeam0,
    lossStreakTeam1: state.lossStreakTeam1,
    halvesSwapped: state.halvesSwapped,
    lastRoundWinnerTeam: state.lastRoundWinnerTeam,
    lastRoundEndReason: state.lastRoundEndReason,

    spikeState: state.spikeState,
    spikeCarrier: state.spikeCarrier,
    spikeX: state.spikeX,
    spikeY: state.spikeY,
    spikeZ: state.spikeZ,
    spikePlantedTick: state.spikePlantedTick,
    plantProgress: state.plantProgress,
    planterIndex: state.planterIndex,
    defuseProgress: state.defuseProgress,
    defuserIndex: state.defuserIndex,
    defuseCheckpointHit: state.defuseCheckpointHit,

    weaponPrimaryAtBuyStart: state.weaponPrimaryAtBuyStart.slice(),
    weaponSecondaryAtBuyStart: state.weaponSecondaryAtBuyStart.slice(),
    armorAtBuyStart: state.armorAtBuyStart.slice(),
    primaryPurchasedItemId: state.primaryPurchasedItemId.slice(),
    secondaryPurchasedItemId: state.secondaryPurchasedItemId.slice(),
    armorPurchasedItemId: state.armorPurchasedItemId.slice(),

    agentId: state.agentId.slice(),
    ultPoints: state.ultPoints.slice(),
    abilityCharges: state.abilityCharges.slice(),
    signatureRechargeEndTick: state.signatureRechargeEndTick.slice(),
    flashedUntilTick: state.flashedUntilTick.slice(),
    flashIntensity: state.flashIntensity.slice(),
    dashKillCounter: state.dashKillCounter.slice(),
    magUlt: state.magUlt.slice(),
    ultWindowEndTick: state.ultWindowEndTick.slice(),
    prevAbilityButtons: state.prevAbilityButtons.slice(),

    pendingAbilityId: state.pendingAbilityId.slice(),
    pendingReadyTick: state.pendingReadyTick.slice(),
    pendingOriginX: state.pendingOriginX.slice(),
    pendingOriginY: state.pendingOriginY.slice(),
    pendingOriginZ: state.pendingOriginZ.slice(),
    pendingYaw: state.pendingYaw.slice(),
    pendingTargetIndex: state.pendingTargetIndex.slice(),

    entType: state.entType.slice(),
    entOwner: state.entOwner.slice(),
    entAbilityId: state.entAbilityId.slice(),
    entX: state.entX.slice(),
    entY: state.entY.slice(),
    entZ: state.entZ.slice(),
    entVelX: state.entVelX.slice(),
    entVelY: state.entVelY.slice(),
    entVelZ: state.entVelZ.slice(),
    entSpawnTick: state.entSpawnTick.slice(),
    entEndTick: state.entEndTick.slice(),
    entParam: state.entParam.slice(),
  };
}

/** Stable, deterministic serialization of a state's typed arrays for hashing/comparison in tests. */
export function serializeState(state: SimState): string {
  const parts = [
    `tick:${state.tick}`,
    `prng:${state.prngState}`,
    `seed:${state.seed}`,
    `n:${state.numPlayers}`,
    `posX:${Array.from(state.posX).join(",")}`,
    `posY:${Array.from(state.posY).join(",")}`,
    `posZ:${Array.from(state.posZ).join(",")}`,
    `velX:${Array.from(state.velX).join(",")}`,
    `velY:${Array.from(state.velY).join(",")}`,
    `velZ:${Array.from(state.velZ).join(",")}`,
    `yaw:${Array.from(state.yaw).join(",")}`,
    `pitch:${Array.from(state.pitch).join(",")}`,
    `crouch:${Array.from(state.crouching).join(",")}`,
    `grounded:${Array.from(state.grounded).join(",")}`,
    `health:${Array.from(state.health).join(",")}`,
    `armor:${Array.from(state.armor).join(",")}`,
    `alive:${Array.from(state.alive).join(",")}`,
    `respawnTick:${Array.from(state.respawnTick).join(",")}`,
    `weaponPrimary:${Array.from(state.weaponPrimary).join(",")}`,
    `weaponSecondary:${Array.from(state.weaponSecondary).join(",")}`,
    `activeSlot:${Array.from(state.activeSlot).join(",")}`,
    `magPrimary:${Array.from(state.magPrimary).join(",")}`,
    `reservePrimary:${Array.from(state.reservePrimary).join(",")}`,
    `magSecondary:${Array.from(state.magSecondary).join(",")}`,
    `reserveSecondary:${Array.from(state.reserveSecondary).join(",")}`,
    `shotCounter:${Array.from(state.shotCounter).join(",")}`,
    `sprayIndex:${Array.from(state.sprayIndex).join(",")}`,
    `ticksSinceFire:${Array.from(state.ticksSinceFire).join(",")}`,
    `nextFireTick:${Array.from(state.nextFireTick).join(",")}`,
    `reloadEndTick:${Array.from(state.reloadEndTick).join(",")}`,
    `equipEndTick:${Array.from(state.equipEndTick).join(",")}`,
    `adsStage:${Array.from(state.adsStage).join(",")}`,
    `tagTicksLeft:${Array.from(state.tagTicksLeft).join(",")}`,
    `landPenaltyTicksLeft:${Array.from(state.landPenaltyTicksLeft).join(",")}`,
    `credits:${Array.from(state.credits).join(",")}`,
    `prevButtons:${Array.from(state.prevButtons).join(",")}`,
    `mode:${state.mode}`,
    `team:${Array.from(state.team).join(",")}`,
    `matchPhase:${state.matchPhase}`,
    `phaseEndTick:${state.phaseEndTick}`,
    `roundNumber:${state.roundNumber}`,
    `scoreTeam0:${state.scoreTeam0}`,
    `scoreTeam1:${state.scoreTeam1}`,
    `lossStreakTeam0:${state.lossStreakTeam0}`,
    `lossStreakTeam1:${state.lossStreakTeam1}`,
    `halvesSwapped:${state.halvesSwapped}`,
    `lastRoundWinnerTeam:${state.lastRoundWinnerTeam}`,
    `lastRoundEndReason:${state.lastRoundEndReason}`,
    `spikeState:${state.spikeState}`,
    `spikeCarrier:${state.spikeCarrier}`,
    `spikeX:${state.spikeX}`,
    `spikeY:${state.spikeY}`,
    `spikeZ:${state.spikeZ}`,
    `spikePlantedTick:${state.spikePlantedTick}`,
    `plantProgress:${state.plantProgress}`,
    `planterIndex:${state.planterIndex}`,
    `defuseProgress:${state.defuseProgress}`,
    `defuserIndex:${state.defuserIndex}`,
    `defuseCheckpointHit:${state.defuseCheckpointHit}`,
    `weaponPrimaryAtBuyStart:${Array.from(state.weaponPrimaryAtBuyStart).join(",")}`,
    `weaponSecondaryAtBuyStart:${Array.from(state.weaponSecondaryAtBuyStart).join(",")}`,
    `armorAtBuyStart:${Array.from(state.armorAtBuyStart).join(",")}`,
    `primaryPurchasedItemId:${Array.from(state.primaryPurchasedItemId).join(",")}`,
    `secondaryPurchasedItemId:${Array.from(state.secondaryPurchasedItemId).join(",")}`,
    `armorPurchasedItemId:${Array.from(state.armorPurchasedItemId).join(",")}`,
    `agentId:${Array.from(state.agentId).join(",")}`,
    `ultPoints:${Array.from(state.ultPoints).join(",")}`,
    `abilityCharges:${Array.from(state.abilityCharges).join(",")}`,
    `signatureRechargeEndTick:${Array.from(state.signatureRechargeEndTick).join(",")}`,
    `flashedUntilTick:${Array.from(state.flashedUntilTick).join(",")}`,
    `flashIntensity:${Array.from(state.flashIntensity).join(",")}`,
    `dashKillCounter:${Array.from(state.dashKillCounter).join(",")}`,
    `magUlt:${Array.from(state.magUlt).join(",")}`,
    `ultWindowEndTick:${Array.from(state.ultWindowEndTick).join(",")}`,
    `prevAbilityButtons:${Array.from(state.prevAbilityButtons).join(",")}`,
    `pendingAbilityId:${Array.from(state.pendingAbilityId).join(",")}`,
    `pendingReadyTick:${Array.from(state.pendingReadyTick).join(",")}`,
    `pendingOriginX:${Array.from(state.pendingOriginX).join(",")}`,
    `pendingOriginY:${Array.from(state.pendingOriginY).join(",")}`,
    `pendingOriginZ:${Array.from(state.pendingOriginZ).join(",")}`,
    `pendingYaw:${Array.from(state.pendingYaw).join(",")}`,
    `pendingTargetIndex:${Array.from(state.pendingTargetIndex).join(",")}`,
    `entType:${Array.from(state.entType).join(",")}`,
    `entOwner:${Array.from(state.entOwner).join(",")}`,
    `entAbilityId:${Array.from(state.entAbilityId).join(",")}`,
    `entX:${Array.from(state.entX).join(",")}`,
    `entY:${Array.from(state.entY).join(",")}`,
    `entZ:${Array.from(state.entZ).join(",")}`,
    `entVelX:${Array.from(state.entVelX).join(",")}`,
    `entVelY:${Array.from(state.entVelY).join(",")}`,
    `entVelZ:${Array.from(state.entVelZ).join(",")}`,
    `entSpawnTick:${Array.from(state.entSpawnTick).join(",")}`,
    `entEndTick:${Array.from(state.entEndTick).join(",")}`,
    `entParam:${Array.from(state.entParam).join(",")}`,
  ];
  return parts.join("|");
}
