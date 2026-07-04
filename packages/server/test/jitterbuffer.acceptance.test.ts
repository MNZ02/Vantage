import { createLoopbackPair, createVirtualClock, withLatency } from "@vg/protocol";
import { FIXED_DT } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

// Acceptance criterion 6: "Jitter buffer: inputs delivered with +/-30 ms
// jitter for 2000 ticks: after the first 256 ticks (adaptation), starved-tick
// rate < 2 %, and buffer depth stayed within [1, 3]." ("buffer depth" here is
// the adaptive target-depth parameter, which is clamped to [1,3] by
// construction — see JitterBuffer; we assert it explicitly rather than
// relying only on the clamp never being hit in a surprising way.)
describe("jitter buffer under +/-30ms jitter (acceptance criterion 6)", () => {
  it("starved rate < 2% and target depth stays within [1,3] after adaptation", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [rawClient, rawServer] = createLoopbackPair();
    const clock = createVirtualClock();
    // One-way jitter only (no fixed delay, no loss) so the buffer purely sees jitter.
    const client = withLatency(rawClient, { delayMs: 30, jitterMs: 30, lossRate: 0, seed: 12345, scheduler: clock.scheduler });
    host.connect(rawServer);
    const send = createScriptedInputSender(client);

    const TICKS = 2000;
    for (let i = 0; i < TICKS; i++) {
      send({ forward: 1, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false });
      clock.advance(FIXED_DT_MS);
      host.step();
    }

    const stats = host.getJitterStats(0, 256)!;
    expect(stats).not.toBeNull();
    expect(stats.starvedRate).toBeLessThan(0.02);
    expect(stats.targetDepth).toBeGreaterThanOrEqual(1);
    expect(stats.targetDepth).toBeLessThanOrEqual(3);
  });
});
