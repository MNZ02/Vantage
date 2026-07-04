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
  let a = (state + 0x6d2b79f5) | 0;
  const nextState = a >>> 0;
  let t = a;
  t = imul32(t ^ (t >>> 15), t | 1);
  t = (t + imul32(t ^ (t >>> 7), t | 61)) | 0;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState };
}
