import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency } from "@vg/protocol";
import { FIXED_DT, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { INTERP_DELAY_TICKS, RemoteInterpolator, type RemotePose } from "../src/interpolation.js";
import { createScriptedInputSender } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;

// Reverses direction periodically (and hops) so the path has real
// acceleration/deceleration curvature at the turns/apexes, not just a
// straight line — a straight-line constant-velocity path would make any
// linear lerp between two snapshots exactly reconstruct every intermediate
// point, which would trivially always score ~0 error and not actually
// exercise the interpolator's reconstruction fidelity.
function strafeInput(t: number): InputFrame {
  const phase = Math.floor(t / 40) % 2;
  return { forward: 0, right: phase === 0 ? 1 : -1, yaw: 0, pitch: 0, jump: t % 40 === 20, crouch: false, walk: false, fire: false };
}

describe("interpolation under jitter+loss (acceptance criterion 5)", () => {
  it("remote interp buffer starves on < 1% of rendered frames; render error vs the true delayed path stays < 15cm for 99% of frames", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [rawObserver, rawObserverServer] = createLoopbackPair();
    const [rawStrafer, rawStraferServer] = createLoopbackPair();
    const clock = createVirtualClock();

    // Observer (client 0) watches remote player 1 (the strafer) under
    // 80ms +/-20ms jitter, 5% loss on its downlink; the strafer's own uplink
    // is clean so its *true* server-side path is unambiguous ground truth.
    const observerTransport = withLatency(rawObserver, {
      delayMs: 80,
      jitterMs: 20,
      lossRate: 0.05,
      seed: 777,
      scheduler: clock.scheduler,
    });

    const observerIndex = host.connect(rawObserverServer);
    const straferIndex = host.connect(rawStraferServer);
    expect(observerIndex).toBe(0);
    expect(straferIndex).toBe(1);

    const interpolator = new RemoteInterpolator();
    const trueServerPathByTick = new Map<number, RemotePose>();

    observerTransport.onMessage((data) => {
      const msg = decodeMessage(data);
      if (msg.type === MessageType.Snapshot) {
        interpolator.ingest(
          msg.serverTick,
          msg.players.map((p) => ({
            posX: p.posX,
            posY: p.posY,
            posZ: p.posZ,
            yaw: p.yaw,
            pitch: p.pitch,
            crouching: p.crouching,
            grounded: p.grounded,
            connected: p.connected,
          })),
        );
      }
    });

    const sendObserver = createScriptedInputSender(observerTransport);
    const sendStrafer = createScriptedInputSender(rawStrafer);

    const TICKS = 2000;
    let starvedFramesBefore = 0;
    const errors: number[] = [];

    for (let i = 0; i < TICKS; i++) {
      sendObserver(i, { forward: 0, right: 0, yaw: 0, pitch: 0, jump: false, crouch: false, walk: false, fire: false });
      sendStrafer(i, strafeInput(i));
      clock.advance(FIXED_DT_MS);
      host.step();

      const s = host.getState();
      trueServerPathByTick.set(s.tick, {
        posX: s.posX[straferIndex]!,
        posY: s.posY[straferIndex]!,
        posZ: s.posZ[straferIndex]!,
        yaw: s.yaw[straferIndex]!,
        pitch: s.pitch[straferIndex]!,
        crouching: s.crouching[straferIndex] === 1,
        grounded: s.grounded[straferIndex] === 1,
        connected: true,
      });

      const before = interpolator.getStarvedFrameCount();
      const sample = interpolator.sample();
      const starvedThisFrame = interpolator.getStarvedFrameCount() > before;
      if (starvedThisFrame) starvedFramesBefore++;

      if (sample) {
        const rendered = sample[straferIndex]!;
        // Ground truth: the true server position at the tick the
        // interpolator is *actually targeting* (its own newest-received tick
        // minus the render delay) — this measures the interpolator's
        // lerp/bracketing fidelity given whatever it has received, not "how
        // close to live" it is, which is fundamentally bounded by network
        // delay/jitter/loss and not a fair thing to grade the interpolator on.
        const trueTick = interpolator.getNewestTick() - INTERP_DELAY_TICKS;
        const truth = trueServerPathByTick.get(trueTick);
        if (truth) {
          const err = Math.hypot(rendered.posX - truth.posX, rendered.posY - truth.posY, rendered.posZ - truth.posZ);
          errors.push(err);
        }
      }
    }

    const starvedRate = starvedFramesBefore / TICKS;
    expect(starvedRate).toBeLessThan(0.01);

    errors.sort((a, b) => a - b);
    const p99Index = Math.floor(errors.length * 0.99);
    const p99 = errors[Math.min(p99Index, errors.length - 1)]!;
    expect(p99).toBeLessThan(0.15);
  });
});
