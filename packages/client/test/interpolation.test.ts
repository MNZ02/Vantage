import { createLoopbackPair, createVirtualClock, decodeMessage, MessageType, withLatency } from "@vg/protocol";
import { FIXED_DT, type InputFrame } from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { RemoteInterpolator, type RemotePose } from "../src/interpolation.js";
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
  return {
    forward: 0,
    right: phase === 0 ? 1 : -1,
    yaw: 0,
    pitch: 0,
    jump: t % 40 === 20,
    crouch: false,
    walk: false,
    fire: false,
    ads: false,
    reload: false,
    slot1: false,
    slot2: false,
  };
}

/** Linearly interpolates the recorded ground-truth path to a fractional tick. */
function groundTruthAt(path: Map<number, RemotePose>, targetTick: number): RemotePose | null {
  const lo = Math.floor(targetTick);
  const hi = Math.ceil(targetTick);
  const a = path.get(lo);
  const b = path.get(hi);
  if (!a || !b) return null;
  const t = hi === lo ? 0 : targetTick - lo;
  return {
    posX: a.posX + (b.posX - a.posX) * t,
    posY: a.posY + (b.posY - a.posY) * t,
    posZ: a.posZ + (b.posZ - a.posZ) * t,
    yaw: a.yaw,
    pitch: a.pitch,
    crouching: a.crouching,
    grounded: a.grounded,
    connected: true,
    alive: true,
    weaponPrimary: 255,
    weaponSecondary: 0,
    activeSlot: 0,
    magActive: 0,
  };
}

describe("interpolation under jitter+loss (acceptance criterion 5)", () => {
  it("remote interp buffer starves on < 1% of rendered frames; render error vs the true delayed path (at the interpolator's own continuous target time) stays < 15cm for 99% of frames", () => {
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

    // The interpolator's clock is the same virtual clock driving the
    // network, so "render frames" (sampled far more often than network
    // ticks, below) advance in lockstep with it deterministically.
    const interpolator = new RemoteInterpolator({ now: clock.now });
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
            alive: p.alive,
            weaponPrimary: p.weaponPrimary,
            weaponSecondary: p.weaponSecondary,
            activeSlot: p.activeSlot,
            magActive: p.magActive,
          })),
        );
      }
    });

    const sendObserver = createScriptedInputSender(observerTransport);
    const sendStrafer = createScriptedInputSender(rawStrafer);

    const TICKS = 2000; // network/server ticks, per the acceptance criterion
    const RENDER_SUBSTEPS_PER_TICK = 4; // simulate rendering ~4x the 64Hz network tick rate
    const subStepMs = FIXED_DT_MS / RENDER_SUBSTEPS_PER_TICK;

    let starvedFrames = 0;
    let renderedFrames = 0;
    const errors: number[] = [];

    for (let i = 0; i < TICKS; i++) {
      for (let sub = 0; sub < RENDER_SUBSTEPS_PER_TICK; sub++) {
        clock.advance(subStepMs);

        if (sub === RENDER_SUBSTEPS_PER_TICK - 1) {
          // One full network tick's worth of time has now elapsed.
          sendObserver(
            i,
            {
              forward: 0,
              right: 0,
              yaw: 0,
              pitch: 0,
              jump: false,
              crouch: false,
              walk: false,
              fire: false,
              ads: false,
              reload: false,
              slot1: false,
              slot2: false,
            },
          );
          sendStrafer(i, strafeInput(i));
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
            alive: s.alive[straferIndex] === 1,
            weaponPrimary: s.weaponPrimary[straferIndex]!,
            weaponSecondary: s.weaponSecondary[straferIndex]!,
            activeSlot: s.activeSlot[straferIndex]!,
            magActive: s.activeSlot[straferIndex] === 0 ? s.magPrimary[straferIndex]! : s.magSecondary[straferIndex]!,
          });
        }

        // Render substep: sample at continuous fractional render time, every substep.
        renderedFrames++;
        const targetTick = interpolator.getCurrentTargetTick();
        const before = interpolator.getStarvedFrameCount();
        const sample = interpolator.sample();
        if (interpolator.getStarvedFrameCount() > before) {
          starvedFrames++;
          continue;
        }
        if (!sample || !Number.isFinite(targetTick)) continue;

        const truth = groundTruthAt(trueServerPathByTick, targetTick);
        if (!truth) continue;

        const rendered = sample[straferIndex]!;
        const err = Math.hypot(rendered.posX - truth.posX, rendered.posY - truth.posY, rendered.posZ - truth.posZ);
        errors.push(err);
      }
    }

    const starvedRate = starvedFrames / renderedFrames;
    expect(starvedRate).toBeLessThan(0.01);

    expect(errors.length).toBeGreaterThan(1000); // sanity: we actually measured something
    errors.sort((a, b) => a - b);
    const p99Index = Math.floor(errors.length * 0.99);
    const p99 = errors[Math.min(p99Index, errors.length - 1)]!;
    expect(p99).toBeLessThan(0.15);
  });
});
