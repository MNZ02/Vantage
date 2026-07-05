import { createLoopbackPair, withLatency, createVirtualClock } from "@vg/protocol";
import { FIXED_DT } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { Bot } from "../src/bots.js";
import { ServerHost } from "../src/serverHost.js";

const FIXED_DT_MS = FIXED_DT * 1000;
const NUM_BOTS = 10;
const TICKS = 1920; // 30s @ 64Hz

// Mixed latency profiles, matching the client package's 10-client soak test.
const PROFILES: ReadonlyArray<{ delayMs: number; jitterMs: number; lossRate: number }> = [
  { delayMs: 15, jitterMs: 0, lossRate: 0 },
  { delayMs: 40, jitterMs: 0, lossRate: 0 },
  { delayMs: 75, jitterMs: 0, lossRate: 0 },
  { delayMs: 15, jitterMs: 10, lossRate: 0.02 },
  { delayMs: 40, jitterMs: 20, lossRate: 0.03 },
  { delayMs: 75, jitterMs: 30, lossRate: 0.05 },
  { delayMs: 15, jitterMs: 5, lossRate: 0 },
  { delayMs: 40, jitterMs: 15, lossRate: 0.02 },
  { delayMs: 75, jitterMs: 10, lossRate: 0.01 },
  { delayMs: 40, jitterMs: 10, lossRate: 0.01 },
];

function isFiniteState(host: ServerHost): boolean {
  const state = host.getState();
  for (let i = 0; i < state.numPlayers; i++) {
    if (!Number.isFinite(state.posX[i]) || !Number.isFinite(state.posY[i]) || !Number.isFinite(state.posZ[i])) return false;
    if (!Number.isFinite(state.velX[i]) || !Number.isFinite(state.velY[i]) || !Number.isFinite(state.velZ[i])) return false;
    if (!Number.isFinite(state.health[i]) || !Number.isFinite(state.armor[i]) || !Number.isFinite(state.credits[i])) return false;
  }
  return true;
}

describe("combat soak (acceptance criterion 13)", () => {
  it("10 bots buying/fighting/dying/respawning for 1920 ticks: no crash, no NaN, >=20 kills, server p95 tick < 15.625ms", () => {
    const host = new ServerHost({ numPlayers: NUM_BOTS, seed: 777 });
    const clock = createVirtualClock();
    const bots: Bot[] = [];

    for (let slot = 0; slot < NUM_BOTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const profile = PROFILES[slot]!;
      const clientTransport = withLatency(rawClient, { ...profile, seed: 5000 + slot, scheduler: clock.scheduler });
      const bot = new Bot(clientTransport, 9000 + slot);
      bots.push(bot);
      host.connect(rawServer);
    }

    expect(() => {
      for (let t = 0; t < TICKS; t++) {
        for (const bot of bots) bot.tick();
        clock.advance(FIXED_DT_MS);
        host.step();
        expect(isFiniteState(host)).toBe(true);
      }
    }).not.toThrow();

    expect(host.getKills().length).toBeGreaterThanOrEqual(20);

    const durations = host.stepDurationsMs.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[Math.min(p95Index, durations.length - 1)]!;
    expect(p95).toBeLessThan(FIXED_DT * 1000);
  }, 30000);
});
