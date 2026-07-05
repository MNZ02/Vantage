import { MAX_PLAYERS, SPAWN_HEALTH, START_CREDITS, WEAPON_NONE } from "./constants.js";
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
  const credits = new Uint32Array(numPlayers).fill(START_CREDITS);

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
  ];
  return parts.join("|");
}
