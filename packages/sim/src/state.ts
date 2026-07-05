import {
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
  };
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
  ];
  return parts.join("|");
}
