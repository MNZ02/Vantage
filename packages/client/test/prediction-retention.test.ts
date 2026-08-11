import { LEVEL_BOXES, defaultInput } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { PredictedClient } from "../src/prediction.js";

describe("prediction retention", () => {
  it("bounds unacknowledged inputs and typed-array state checkpoints during a snapshot outage", () => {
    const predicted = new PredictedClient(1, 1, 0, LEVEL_BOXES);
    for (let i = 0; i < 1000; i++) predicted.queueAndPredict(defaultInput());
    expect(predicted.getPendingInputCount()).toBeLessThanOrEqual(192);
    expect(predicted.getRetainedStateCount()).toBeLessThanOrEqual(192);
  });
});
