// Stub net-pump worker (M0 skeleton only — no networking yet).
//
// PLAN.md's browser-reality section notes that hidden/backgrounded tabs throttle
// rAF and ordinary timers far more aggressively than worker timers, so the real
// network input/snapshot pump belongs in a Web Worker, not the render loop. This
// file just proves the plumbing: it posts a heartbeat message at 64 Hz so the
// main thread can be wired up to it now, ahead of M1's real transport code.
//
// Cast to a plain postMessage-capable interface instead of pulling in the
// "webworker" lib globally (which conflicts with the "dom" lib the rest of the
// client is compiled with in one tsconfig).
interface PostableGlobal {
  postMessage: (message: unknown) => void;
}
const worker = self as unknown as PostableGlobal;

const HEARTBEAT_HZ = 64;
const HEARTBEAT_INTERVAL_MS = 1000 / HEARTBEAT_HZ;

let sequence = 0;

setInterval(() => {
  worker.postMessage({ type: "heartbeat", sequence, timestamp: Date.now() });
  sequence++;
}, HEARTBEAT_INTERVAL_MS);
