import { describe, expect, it } from "vitest";
import { SERVER_TELEMETRY_RETENTION, ServerHost } from "../src/serverHost.js";

describe("server diagnostic retention", () => {
  it("keeps long-running step timing telemetry bounded", () => {
    const host = new ServerHost({ numPlayers: 1, snapshotEveryNTicks: 64 });
    for (let i = 0; i < SERVER_TELEMETRY_RETENTION + 1; i++) host.step();
    expect(host.stepDurationsMs.length).toBeGreaterThan(0);
    expect(host.stepDurationsMs.length).toBeLessThanOrEqual(SERVER_TELEMETRY_RETENTION);
  });
});
