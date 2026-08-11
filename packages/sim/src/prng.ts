// Seeded PRNG (mulberry32). Pure function of its 32-bit state word; the state
// word lives inside SimState so the whole sim stays a pure function of
// (state, inputs) with no module-level mutable state.
import { imul32 } from "./math.js";

export interface PrngResult {
  value: number; // [0, 1)
  nextState: number; // next 32-bit state word
}

export function createPrngState(seed: number): number {
  return seed >>> 0;
}

export function nextRandom(state: number): PrngResult {
  const a = (state + 0x6d2b79f5) | 0;
  const nextState = a >>> 0;
  let t = a;
  t = imul32(t ^ (t >>> 15), t | 1);
  t = (t + imul32(t ^ (t >>> 7), t | 61)) | 0;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
}

/**
 * Stateless hash of (seed, a, b) into a mulberry32 state word, for anything
 * that needs a deterministic-but-independent-of-tick-order random value
 * derived from a few integers (shot spread cones, DM respawn point
 * selection) *without* consuming/advancing the shared `state.prngState` —
 * consuming the shared stream for one player's shot would desync every other
 * client's prediction of that shot (they don't replay other players'
 * inputs, so they'd never advance the shared stream the same number of
 * times). Reuses nextRandom's mixing function as a hash: same inputs always
 * produce the same output, on client and server alike.
 */
export function hashSeed3(seed: number, a: number, b: number): number {
  const mixed = (imul32(seed | 0, 0x9e3779b1) ^ imul32((a + 1) | 0, 0x85ebca6b) ^ imul32((b + 1) | 0, 0xc2b2ae35)) >>> 0;
  return createPrngState(mixed);
}

/** Two independent [0,1) draws from a stateless (seed, a, b) hash. Pure. */
export function hashRandom2(seed: number, a: number, b: number): { r1: number; r2: number } {
  const h0 = hashSeed3(seed, a, b);
  const first = nextRandom(h0);
  const second = nextRandom(first.nextState);
  return { r1: first.value, r2: second.value };
}
