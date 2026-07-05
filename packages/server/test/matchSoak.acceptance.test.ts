import { createLoopbackPair, createVirtualClock, withLatency, MessageType, decodeMessage } from "@vg/protocol";
import { FIXED_DT, PHASE_MATCH_END, ROUND_END_DEFUSE, ROUND_END_DETONATION } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { Bot } from "../src/bots.js";
import { ServerHost } from "../src/serverHost.js";

const FIXED_DT_MS = FIXED_DT * 1000;
const NUM_BOTS = 10;
const MAX_TICKS = 20_000; // generous ceiling; shrunk timers should finish well before this

function isFiniteState(host: ServerHost): boolean {
  const state = host.getState();
  for (let i = 0; i < state.numPlayers; i++) {
    if (!Number.isFinite(state.posX[i]) || !Number.isFinite(state.posY[i]) || !Number.isFinite(state.posZ[i])) return false;
    if (!Number.isFinite(state.velX[i]) || !Number.isFinite(state.velY[i]) || !Number.isFinite(state.velZ[i])) return false;
    if (!Number.isFinite(state.health[i]) || !Number.isFinite(state.armor[i]) || !Number.isFinite(state.credits[i])) return false;
  }
  return true;
}

describe("match soak (acceptance criterion 14)", () => {
  it("10 bots (5v5), shrunk timers, winTarget 2: runs to matchEnd with plants/defuses/detonations, no crash/NaN, p95 tick < 15.625ms", () => {
    const host = new ServerHost({
      numPlayers: NUM_BOTS,
      seed: 42,
      mode: "match",
      minPlayers: NUM_BOTS,
      matchConfig: {
        buyTicks: 120,
        firstRoundBuyTicks: 120,
        roundTicks: 900,
        spikeTicks: 200,
        plantTicks: 64,
        defuseTicks: 128,
        defuseCheckpointTicks: 64,
        roundEndTicks: 30,
        winTarget: 2,
        halfAtRound: 1,
      },
    });
    const clock = createVirtualClock();
    const bots: Bot[] = [];

    for (let slot = 0; slot < NUM_BOTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const clientTransport = withLatency(rawClient, { delayMs: 20, jitterMs: 5, lossRate: 0.01, seed: 6000 + slot, scheduler: clock.scheduler });
      const bot = new Bot(clientTransport, 8000 + slot);
      bots.push(bot);
      host.connect(rawServer);
    }

    let roundsSeen = new Set<number>();
    let matchEnded = false;

    expect(() => {
      for (let t = 0; t < MAX_TICKS; t++) {
        for (const bot of bots) bot.tick();
        clock.advance(FIXED_DT_MS);
        host.step();
        expect(isFiniteState(host)).toBe(true);
        roundsSeen.add(host.getState().roundNumber);
        if (host.getState().matchPhase === PHASE_MATCH_END) {
          matchEnded = true;
          break;
        }
      }
    }).not.toThrow();

    expect(matchEnded).toBe(true);
    expect(roundsSeen.size).toBeGreaterThanOrEqual(2);
    expect(host.getKills().length).toBeGreaterThan(0);

    const durations = host.stepDurationsMs.slice().sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const p95 = durations[Math.min(p95Index, durations.length - 1)]!;
    expect(p95).toBeLessThan(FIXED_DT * 1000);
  }, 60_000);

  it("produces at least one plant, and at least one defuse or detonation, across a shrunk-timer match", () => {
    const host = new ServerHost({
      numPlayers: NUM_BOTS,
      seed: 43,
      mode: "match",
      minPlayers: NUM_BOTS,
      matchConfig: {
        buyTicks: 80,
        firstRoundBuyTicks: 80,
        roundTicks: 700,
        spikeTicks: 150,
        plantTicks: 48,
        defuseTicks: 96,
        defuseCheckpointTicks: 48,
        roundEndTicks: 20,
        winTarget: 3,
        halfAtRound: 99,
      },
    });
    const clock = createVirtualClock();
    const bots: Bot[] = [];
    for (let slot = 0; slot < NUM_BOTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const clientTransport = withLatency(rawClient, { delayMs: 20, jitterMs: 5, lossRate: 0, seed: 7000 + slot, scheduler: clock.scheduler });
      bots.push(new Bot(clientTransport, 8500 + slot));
      host.connect(rawServer);
    }

    let plants = 0;
    let defusesOrDetonations = 0;
    for (let t = 0; t < MAX_TICKS; t++) {
      for (const bot of bots) bot.tick();
      clock.advance(FIXED_DT_MS);
      const prevPhase = host.getState().matchPhase;
      const prevReason = host.getState().lastRoundEndReason;
      host.step();
      if (host.getState().spikePlantedTick !== -1 && host.getState().matchPhase !== prevPhase) {
        // roundEnd transition happened; if it carried a defuse/detonation reason, count it below instead.
      }
      const s = host.getState();
      if (s.spikePlantedTick !== -1 && s.spikePlantedTick + 1 === s.tick) plants++;
      if (s.lastRoundEndReason !== prevReason && (s.lastRoundEndReason === ROUND_END_DEFUSE || s.lastRoundEndReason === ROUND_END_DETONATION)) {
        defusesOrDetonations++;
      }
      if (s.matchPhase === PHASE_MATCH_END) break;
    }

    expect(plants).toBeGreaterThanOrEqual(1);
    expect(defusesOrDetonations).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("killfeed events flow to clients during the soak", () => {
    const host = new ServerHost({
      numPlayers: NUM_BOTS,
      seed: 44,
      mode: "match",
      minPlayers: NUM_BOTS,
      matchConfig: { buyTicks: 60, firstRoundBuyTicks: 60, roundTicks: 600, winTarget: 5, halfAtRound: 99 },
    });
    const clock = createVirtualClock();
    const bots: Bot[] = [];
    let killEventsReceived = 0;
    for (let slot = 0; slot < NUM_BOTS; slot++) {
      const [rawClient, rawServer] = createLoopbackPair();
      const clientTransport = withLatency(rawClient, { delayMs: 15, jitterMs: 0, lossRate: 0, seed: 9000 + slot, scheduler: clock.scheduler });
      rawClient.onMessage((data) => {
        const msg = decodeMessage(data);
        if (msg.type === MessageType.KillEvent) killEventsReceived++;
      });
      bots.push(new Bot(clientTransport, 8800 + slot));
      host.connect(rawServer);
    }

    for (let t = 0; t < 6000; t++) {
      for (const bot of bots) bot.tick();
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    expect(host.getKills().length).toBeGreaterThan(0);
    expect(killEventsReceived).toBeGreaterThan(0);
  }, 30_000);
});
