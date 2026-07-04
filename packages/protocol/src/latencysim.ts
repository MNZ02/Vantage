// Seeded latency-simulation wrapper transport: delay/jitter/loss, deterministic
// given a seed, so netcode tests (and manual `?fakelag=` feel-testing) are
// reproducible. Works identically in Node and the browser since it only
// depends on @vg/sim's PRNG and an injectable scheduler.
import { createPrngState, nextRandom } from "@vg/sim";
import type { Transport } from "./transport.js";

export type Scheduler = (fn: () => void, delayMs: number) => void;

export interface LatencyOptions {
  /** One-way delay, in ms, applied independently to each direction. */
  delayMs: number;
  /** +/- jitter, in ms, uniformly distributed around delayMs. */
  jitterMs?: number;
  /** Fraction of messages (0..1) dropped, independently per direction. */
  lossRate?: number;
  /** Seeds the PRNG driving jitter/loss so runs are reproducible. */
  seed: number;
  /** Defaults to setTimeout; tests can inject a virtual-time scheduler. */
  scheduler?: Scheduler;
}

/**
 * Wraps a Transport so that both sending through it and receiving from it
 * incur independent random delay (delayMs +/- jitterMs) and independent random
 * loss (lossRate). Wrapping one endpoint of a pair this way simulates
 * `delayMs` one-way latency in both directions — i.e. an end-to-end round
 * trip of ~2*delayMs when jitter is 0 — which is "symmetric" latency as used
 * in the M1 spec's acceptance criteria (a stated 80 ms figure there means
 * delayMs = 40 for a 80 ms RTT test, unless noted otherwise).
 *
 * Reordering is not separately modeled: whatever reordering falls out of
 * per-message random jitter is left as-is (no additional resequencing logic).
 */
export function withLatency(inner: Transport, opts: LatencyOptions): Transport {
  let prngState = createPrngState(opts.seed);
  function rand(): number {
    const r = nextRandom(prngState);
    prngState = r.nextState;
    return r.value;
  }

  const scheduler: Scheduler = opts.scheduler ?? ((fn, ms) => setTimeout(fn, ms));
  const jitterMs = opts.jitterMs ?? 0;
  const lossRate = opts.lossRate ?? 0;

  function sampleDelay(): number {
    const jitter = jitterMs > 0 ? (rand() * 2 - 1) * jitterMs : 0;
    return Math.max(0, opts.delayMs + jitter);
  }

  function shouldDrop(): boolean {
    return lossRate > 0 && rand() < lossRate;
  }

  const messageCbs: Array<(data: Uint8Array) => void> = [];
  const closeCbs: Array<() => void> = [];
  let closed = false;

  inner.onMessage((data) => {
    if (closed || shouldDrop()) return;
    const delay = sampleDelay();
    scheduler(() => {
      if (closed) return;
      for (const cb of messageCbs) cb(data);
    }, delay);
  });

  inner.onClose(() => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  });

  return {
    send(data: Uint8Array) {
      if (closed || shouldDrop()) return;
      const delay = sampleDelay();
      scheduler(() => {
        if (!closed) inner.send(data);
      }, delay);
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      inner.close();
    },
  };
}
