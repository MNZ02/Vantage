import { MAX_PLAYERS } from "./constants.js";
import { createPrngState } from "./prng.js";

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
  readonly jump: boolean;
  readonly crouch: boolean;
  readonly walk: boolean;
}

export function defaultInput(yaw = 0): InputFrame {
  return { forward: 0, right: 0, yaw, jump: false, crouch: false, walk: false };
}

/**
 * Simulation state for up to MAX_PLAYERS players, stored as flat typed arrays
 * (ECS-lite) so it stays cheap to snapshot/serialize/hash and, later, to
 * transmit over the wire.
 */
export interface SimState {
  tick: number;
  prngState: number;
  readonly numPlayers: number;

  readonly posX: Float64Array;
  readonly posY: Float64Array;
  readonly posZ: Float64Array;

  readonly velX: Float64Array;
  readonly velY: Float64Array;
  readonly velZ: Float64Array;

  readonly yaw: Float64Array;
  readonly crouching: Uint8Array;
  readonly grounded: Uint8Array;
}

export function createState(seed: number, numPlayers: number = MAX_PLAYERS): SimState {
  if (numPlayers < 1 || numPlayers > MAX_PLAYERS) {
    throw new Error(`numPlayers must be in [1, ${MAX_PLAYERS}]`);
  }
  return {
    tick: 0,
    prngState: createPrngState(seed),
    numPlayers,
    posX: new Float64Array(numPlayers),
    posY: new Float64Array(numPlayers),
    posZ: new Float64Array(numPlayers),
    velX: new Float64Array(numPlayers),
    velY: new Float64Array(numPlayers),
    velZ: new Float64Array(numPlayers),
    yaw: new Float64Array(numPlayers),
    crouching: new Uint8Array(numPlayers),
    grounded: new Uint8Array(numPlayers),
  };
}

/** Deep-clones a SimState (tick() never mutates its input in place). */
export function cloneState(state: SimState): SimState {
  return {
    tick: state.tick,
    prngState: state.prngState,
    numPlayers: state.numPlayers,
    posX: state.posX.slice(),
    posY: state.posY.slice(),
    posZ: state.posZ.slice(),
    velX: state.velX.slice(),
    velY: state.velY.slice(),
    velZ: state.velZ.slice(),
    yaw: state.yaw.slice(),
    crouching: state.crouching.slice(),
    grounded: state.grounded.slice(),
  };
}

/** Stable, deterministic serialization of a state's typed arrays for hashing/comparison in tests. */
export function serializeState(state: SimState): string {
  const parts = [
    `tick:${state.tick}`,
    `prng:${state.prngState}`,
    `n:${state.numPlayers}`,
    `posX:${Array.from(state.posX).join(",")}`,
    `posY:${Array.from(state.posY).join(",")}`,
    `posZ:${Array.from(state.posZ).join(",")}`,
    `velX:${Array.from(state.velX).join(",")}`,
    `velY:${Array.from(state.velY).join(",")}`,
    `velZ:${Array.from(state.velZ).join(",")}`,
    `yaw:${Array.from(state.yaw).join(",")}`,
    `crouch:${Array.from(state.crouching).join(",")}`,
    `grounded:${Array.from(state.grounded).join(",")}`,
  ];
  return parts.join("|");
}
