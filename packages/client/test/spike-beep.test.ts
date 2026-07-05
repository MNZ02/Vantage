import { describe, expect, it } from "vitest";
import { spikeBeepIntervalMs } from "../src/audio/spikeBeep.js";

const TOTAL_TICKS = 2880; // DEFAULT_SPIKE_TICKS, see @vg/sim constants.ts

describe("spike beep acceleration curve (M5 acceptance criterion 3)", () => {
  it("the beep interval decreases monotonically as ticksLeft decreases (accelerates toward detonation)", () => {
    let previousInterval = Infinity;
    for (let ticksLeft = TOTAL_TICKS; ticksLeft >= 0; ticksLeft -= 64) {
      const interval = spikeBeepIntervalMs(ticksLeft, TOTAL_TICKS);
      expect(interval).toBeLessThanOrEqual(previousInterval);
      previousInterval = interval;
    }
  });

  it("is at its slowest right after planting and fastest at zero ticks left", () => {
    const justPlanted = spikeBeepIntervalMs(TOTAL_TICKS, TOTAL_TICKS);
    const aboutToDetonate = spikeBeepIntervalMs(0, TOTAL_TICKS);
    expect(justPlanted).toBeGreaterThan(aboutToDetonate);
  });

  it("clamps to a sane interval even for out-of-range inputs", () => {
    expect(spikeBeepIntervalMs(-100, TOTAL_TICKS)).toBe(spikeBeepIntervalMs(0, TOTAL_TICKS));
    expect(spikeBeepIntervalMs(TOTAL_TICKS + 500, TOTAL_TICKS)).toBe(spikeBeepIntervalMs(TOTAL_TICKS, TOTAL_TICKS));
    expect(spikeBeepIntervalMs(100, 0)).toBeGreaterThan(0);
  });
});
