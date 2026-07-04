import type { SimState } from "@vg/sim";

/**
 * Fixed-size ring buffer of the last N post-tick authoritative states (spec:
 * 64 states = 1 s at 64 Hz), keyed by tick number, for lag-compensated
 * hitscan rewind.
 */
export class StateRingBuffer {
  private readonly capacity: number;
  private readonly slots: (SimState | undefined)[];

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.slots = new Array(capacity);
  }

  push(state: SimState): void {
    this.slots[((state.tick % this.capacity) + this.capacity) % this.capacity] = state;
  }

  /** Exact state at `tick`, or null if it's outside the retained window. */
  get(tick: number): SimState | null {
    if (tick < 0) return null;
    const slot = this.slots[((tick % this.capacity) + this.capacity) % this.capacity];
    if (!slot || slot.tick !== tick) return null;
    return slot;
  }
}
