// M5 audio: the planted-spike's accelerating beep — rate derived purely from
// spikePlantedTicksLeft/spikeTicks (see @vg/protocol's MatchHud), so the
// curve is testable without any audio engine.
const MIN_INTERVAL_MS = 120; // near-solid tone right before detonation
const MAX_INTERVAL_MS = 1000; // ~1 Hz right after planting

/**
 * Interval (ms) between beeps for `ticksLeft` remaining out of `totalTicks`
 * since planting. Monotonically decreases as ticksLeft decreases (the beep
 * accelerates as the timer runs down), clamped to [MIN_INTERVAL_MS,
 * MAX_INTERVAL_MS].
 */
export function spikeBeepIntervalMs(ticksLeft: number, totalTicks: number): number {
  if (totalTicks <= 0) return MIN_INTERVAL_MS;
  const frac = Math.max(0, Math.min(1, ticksLeft / totalTicks));
  return MIN_INTERVAL_MS + (MAX_INTERVAL_MS - MIN_INTERVAL_MS) * frac;
}
