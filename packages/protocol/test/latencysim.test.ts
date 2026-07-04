import { describe, expect, it } from "vitest";
import { withLatency } from "../src/latencysim.js";
import { createLoopbackPair } from "../src/transport.js";
import { createVirtualClock as createVirtualScheduler } from "../src/virtualClock.js";

describe("createLoopbackPair", () => {
  it("delivers messages instantly with no wrapping", () => {
    const [a, b] = createLoopbackPair();
    const received: Uint8Array[] = [];
    b.onMessage((d) => received.push(d));
    a.send(new Uint8Array([1, 2, 3]));
    expect(received.length).toBe(1);
    expect(Array.from(received[0]!)).toEqual([1, 2, 3]);
  });

  it("close() on one side fires onClose on both", () => {
    const [a, b] = createLoopbackPair();
    let aClosed = false;
    let bClosed = false;
    a.onClose(() => (aClosed = true));
    b.onClose(() => (bClosed = true));
    a.close();
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(true);
  });
});

describe("withLatency", () => {
  it("delays delivery by ~delayMs with zero jitter", () => {
    const [a, b] = createLoopbackPair();
    const { scheduler, advance } = createVirtualScheduler();
    const wrappedA = withLatency(a, { delayMs: 80, jitterMs: 0, lossRate: 0, seed: 1, scheduler });

    const received: number[] = [];
    b.onMessage(() => received.push(1));
    wrappedA.send(new Uint8Array([9]));

    advance(79);
    expect(received.length).toBe(0);
    advance(2);
    expect(received.length).toBe(1);
  });

  it("drops the configured fraction of messages over many sends", () => {
    const [a, b] = createLoopbackPair();
    const { scheduler, advance } = createVirtualScheduler();
    const wrappedA = withLatency(a, { delayMs: 10, jitterMs: 0, lossRate: 0.3, seed: 42, scheduler });

    let received = 0;
    b.onMessage(() => received++);
    const N = 5000;
    for (let i = 0; i < N; i++) wrappedA.send(new Uint8Array([1]));
    advance(1000);

    const rate = received / N;
    expect(rate).toBeGreaterThan(0.6);
    expect(rate).toBeLessThan(0.8);
  });

  it("is deterministic for a given seed", () => {
    function run(): number[] {
      const [a, b] = createLoopbackPair();
      const { scheduler, advance, now } = createVirtualScheduler();
      const wrappedA = withLatency(a, { delayMs: 50, jitterMs: 20, lossRate: 0.1, seed: 7, scheduler });
      const arrivals: number[] = [];
      b.onMessage(() => arrivals.push(now()));
      for (let i = 0; i < 50; i++) {
        wrappedA.send(new Uint8Array([i]));
        advance(5);
      }
      advance(200);
      return arrivals;
    }
    expect(run()).toEqual(run());
  });

  it("jitter spreads per-message transit delay around delayMs +/- jitterMs", () => {
    const [a, b] = createLoopbackPair();
    const { scheduler, advance, now } = createVirtualScheduler();
    const wrappedA = withLatency(a, { delayMs: 80, jitterMs: 20, lossRate: 0, seed: 3, scheduler });

    const N = 200;
    const sendTimes = new Array<number>(N);
    const transitDelays: number[] = [];
    b.onMessage((data) => {
      const id = data[0]!;
      transitDelays.push(now() - sendTimes[id]!);
    });
    for (let i = 0; i < N; i++) {
      sendTimes[i] = now();
      wrappedA.send(new Uint8Array([i]));
      advance(1);
    }
    advance(200);

    expect(transitDelays.length).toBe(N);
    for (const d of transitDelays) {
      expect(d).toBeGreaterThanOrEqual(80 - 20);
      expect(d).toBeLessThanOrEqual(80 + 20);
    }
    // not every transit delay identical (jitter is actually doing something)
    expect(new Set(transitDelays).size).toBeGreaterThan(1);
  });
});
