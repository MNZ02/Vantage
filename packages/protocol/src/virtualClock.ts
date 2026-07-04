import type { Scheduler } from "./latencysim.js";

/**
 * A deterministic virtual-time scheduler: implements the `Scheduler` shape
 * `withLatency` accepts, but instead of real timers, callbacks fire when the
 * test explicitly calls `advance(ms)`. This is what makes the netcode test
 * suites (jitter buffer, interpolation under jitter+loss, lag-comp, the
 * 10-client soak) run in milliseconds of real wall-clock time instead of
 * however many seconds of simulated match time they cover.
 */
export interface VirtualClock {
  scheduler: Scheduler;
  /** Fires any callbacks scheduled at or before `now + ms`, then advances `now` by ms. */
  advance(ms: number): void;
  now(): number;
}

export function createVirtualClock(): VirtualClock {
  const pending: Array<{ at: number; fn: () => void }> = [];
  let now = 0;

  const scheduler: Scheduler = (fn, delayMs) => {
    pending.push({ at: now + delayMs, fn });
  };

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      pending.sort((a, b) => a.at - b.at);
      const next = pending[0];
      if (!next || next.at > target) break;
      pending.shift();
      now = next.at;
      next.fn();
    }
    now = target;
  }

  return { scheduler, advance, now: () => now };
}
