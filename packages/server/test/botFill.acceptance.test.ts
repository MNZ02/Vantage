import { PHASE_WAITING, PHASE_BUY, PHASE_ROUND, PHASE_MATCH_END } from "@vg/sim";
import { createLoopbackPair } from "@vg/protocol";
import { describe, expect, it } from "vitest";
import { spawnBotFill } from "../src/botFill.js";
import { ServerHost } from "../src/serverHost.js";

describe("solo bot fill (in-process)", () => {
  it("spawns N bots into free slots and leaves room for a human", () => {
    const host = new ServerHost({ mode: "match", numPlayers: 10, minPlayers: 10, seed: 1 });
    const fill = spawnBotFill(host, 9, 50_000);
    expect(fill.count).toBe(9);
    expect(host.connectedCount()).toBe(9);
    expect(host.getState().matchPhase).toBe(PHASE_WAITING); // not enough yet (minPlayers=10)

    // Human joins → minPlayers met → match starts.
    const [, humanServer] = createLoopbackPair();
    const humanIndex = host.connect(humanServer);
    expect(humanIndex).toBeGreaterThanOrEqual(0);
    expect(host.connectedCount()).toBe(10);
    expect(host.getState().matchPhase).not.toBe(PHASE_WAITING);
    expect([PHASE_BUY, PHASE_ROUND, PHASE_MATCH_END]).toContain(host.getState().matchPhase);

    fill.stop();
  });

  it("bots produce InputBatches that move the sim (no throw over a short soak)", () => {
    const host = new ServerHost({ mode: "match", numPlayers: 4, minPlayers: 4, seed: 2 });
    const fill = spawnBotFill(host, 4, 51_000);
    expect(fill.count).toBe(4);
    // Match already started (4 bots, minPlayers 4). Drive a few ticks via bot.tick + host.step.
    for (let t = 0; t < 32; t++) {
      for (const bot of fill.bots) bot.tick();
      host.step();
    }
    expect(host.getState().tick).toBeGreaterThan(0);
    fill.stop();
  });
});
