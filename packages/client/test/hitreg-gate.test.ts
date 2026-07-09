import { MessageType, createLoopbackPair, createVirtualClock, decodeMessage, encodeMessage, withLatency } from "@vg/protocol";
import {
  FIXED_DT,
  LEVEL_BOXES,
  STAND_HEIGHT,
  WEAPONS,
  createState,
  eyePosition,
  getWeaponDef,
  raycastPlayers,
  shotDirection,
  type InputFrame,
  type SimState,
} from "@vg/sim";
import { ServerHost } from "@vg/server";
import { describe, expect, it } from "vitest";
import { HitRegTracker } from "../src/hitreg.js";
import { RemoteInterpolator, type RemotePose } from "../src/interpolation.js";
import { PredictedClient, type AuthoritativeSnapshot } from "../src/prediction.js";
import { toAuthoritative } from "./testUtils.js";

const FIXED_DT_MS = FIXED_DT * 1000;
const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;
const SHOT_TARGET_COUNT = 500;
const FIRE_MAX_RANGE = 100;

function idleSample(): InputFrame {
  return {
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
  };
}

/** Scratch SimState for the shooter's cosmetic predicted-hit raycast against the currently-interpolated target pose — mirrors net.ts's buildCosmeticState(). */
function buildCosmeticState(poses: readonly RemotePose[], numPlayers: number): SimState {
  const scratch = createState(0, numPlayers);
  for (let i = 0; i < numPlayers; i++) {
    const p = poses[i];
    if (!p) {
      scratch.alive[i] = 0;
      continue;
    }
    scratch.posX[i] = p.posX;
    scratch.posY[i] = p.posY;
    scratch.posZ[i] = p.posZ;
    scratch.crouching[i] = p.crouching ? 1 : 0;
    scratch.alive[i] = p.connected && p.alive ? 1 : 0;
  }
  return scratch;
}

interface RunResult {
  agreementPercent: number;
  totalResolved: number;
  shotsFired: number;
}

function runScenario(shooterLatency: { delayMs: number; jitterMs: number; lossRate: number }): RunResult {
  const host = new ServerHost({ numPlayers: 2, seed: 42 });
  const [rawShooterClient, rawShooterServer] = createLoopbackPair();
  const [rawTargetClient, rawTargetServer] = createLoopbackPair();
  const clock = createVirtualClock();

  const shooterTransport = withLatency(rawShooterClient, { ...shooterLatency, seed: 11, scheduler: clock.scheduler });
  // Target's own uplink/downlink stay clean+fast so its true server position is simple ground truth.
  const targetTransport = withLatency(rawTargetClient, { delayMs: 5, jitterMs: 0, lossRate: 0, seed: 12, scheduler: clock.scheduler });

  const shooterIndex = host.connect(rawShooterServer);
  const targetIndex = host.connect(rawTargetServer);
  expect(shooterIndex).toBe(0);
  expect(targetIndex).toBe(1);

  // Standing 10m apart along Z, well clear of the graybox's ramp/interior wall.
  const state = host.getState();
  state.posX[shooterIndex] = 0;
  state.posY[shooterIndex] = 0;
  state.posZ[shooterIndex] = 0;
  state.posX[targetIndex] = 0;
  state.posY[targetIndex] = 0;
  state.posZ[targetIndex] = 10;
  state.weaponPrimary[shooterIndex] = FALCON.id;
  state.activeSlot[shooterIndex] = 0;
  state.magPrimary[shooterIndex] = 1_000_000; // effectively unlimited ammo: isolates hit-reg from reload cycling
  state.reservePrimary[shooterIndex] = 0;

  const shooterInterpolator = new RemoteInterpolator({ now: clock.now });
  const hitreg = new HitRegTracker(250, clock.now);

  const shooterPredicted = new PredictedClient(host.getSeed(), host.getNumPlayers(), shooterIndex, LEVEL_BOXES);
  const ss = shooterPredicted.getPredictedState();
  ss.weaponPrimary[shooterIndex] = FALCON.id;
  ss.activeSlot[shooterIndex] = 0;
  ss.magPrimary[shooterIndex] = 1_000_000;

  shooterTransport.onMessage((data) => {
    const msg = decodeMessage(data);
    if (msg.type === MessageType.Snapshot) {
      shooterInterpolator.ingest(
        msg.serverTick,
        msg.players.map(
          (p): RemotePose => ({
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
            team: p.team,
            agentId: p.agentId,
          }),
        ),
      );
      const authoritative: AuthoritativeSnapshot = toAuthoritative(msg);
      shooterPredicted.reconcile(authoritative);
    } else if (msg.type === MessageType.HitConfirm && msg.shooterIndex === shooterIndex) {
      hitreg.recordConfirmedHit();
    }
  });

  const shooterInputHistory: InputFrame[] = [];
  const targetInputHistory: InputFrame[] = [];
  let shotsFired = 0;
  let tick = 0;
  const MAX_TICKS = 6000; // generous headroom over the ~3300 ticks 500 shots @ 9.75rps needs

  while (shotsFired < SHOT_TARGET_COUNT && tick < MAX_TICKS) {
    // Aim exactly at the target's currently-interpolated pose (what a real
    // client would render/aim at), body height, standing still (spread-minimal).
    const poses = shooterInterpolator.sample();
    const targetPose = poses?.[targetIndex];
    let input: InputFrame;
    if (targetPose) {
      const eye = eyePosition(shooterPredicted.getPredictedState(), shooterIndex);
      const dx = targetPose.posX - eye.x;
      const dz = targetPose.posZ - eye.z;
      const targetBodyY = targetPose.posY + STAND_HEIGHT * 0.5;
      const dy = targetBodyY - eye.y;
      const horizontalDist = Math.max(0.5, Math.hypot(dx, dz));
      const yaw = Math.atan2(dx, dz);
      const pitch = Math.atan2(dy, horizontalDist);
      input = { ...idleSample(), yaw, pitch, fire: true };
    } else {
      input = { ...idleSample(), fire: true };
    }

    const { seq, quantizedInput } = shooterPredicted.queueAndPredict(input);
    shooterInputHistory.push(quantizedInput);
    if (shooterInputHistory.length > 3) shooterInputHistory.shift();
    const firstSeq = seq - shooterInputHistory.length + 1;
    const viewTick = Math.max(0, Math.round(shooterInterpolator.getCurrentTargetTick()));
    shooterTransport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, viewTick, frames: shooterInputHistory.slice() }));

    // Cosmetic predicted-hit check for any shot(s) fired this tick, against
    // the currently-interpolated target pose — exactly what net.ts does.
    const shots = shooterPredicted.getLastShots();
    if (shots.length > 0) {
      shotsFired += shots.length;
      const cosmeticPoses = poses ?? [];
      const cosmeticState = buildCosmeticState(cosmeticPoses, host.getNumPlayers());
      const shooterState = shooterPredicted.getPredictedState();
      const origin = eyePosition(shooterState, shooterIndex);
      for (const shot of shots) {
        const weapon = getWeaponDef(shot.weaponId);
        if (!weapon) continue;
        const dir = shotDirection(shooterState, shooterIndex, weapon, shot.shotIndex, shot.sprayIndex);
        const hit = raycastPlayers(cosmeticState, shooterIndex, origin, dir, FIRE_MAX_RANGE);
        hitreg.recordPredictedShot(hit !== null);
      }
    }

    // Target: idle, standing still.
    const targetInput = idleSample();
    targetInputHistory.push(targetInput);
    if (targetInputHistory.length > 3) targetInputHistory.shift();
    const targetFirstSeq = tick - targetInputHistory.length + 1;
    targetTransport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq: targetFirstSeq, viewTick: 0, frames: targetInputHistory.slice() }));

    tick++;
    clock.advance(FIXED_DT_MS);
    host.step();
    hitreg.expire();
  }

  // Drain any messages still in flight so late HitConfirms get counted.
  for (let i = 0; i < 40; i++) {
    clock.advance(FIXED_DT_MS);
    host.step();
    hitreg.expire();
  }

  const stats = hitreg.getStats();
  return { agreementPercent: stats.agreementPercent, totalResolved: stats.totalResolved, shotsFired };
}

describe("hit-reg gate (acceptance criterion 12, M2 go/no-go)", () => {
  it("clean 80ms RTT (0 jitter/loss): predicted-hit vs server-confirmed agreement >= 98%", () => {
    const result = runScenario({ delayMs: 40, jitterMs: 0, lossRate: 0 });
    // eslint-disable-next-line no-console
    console.log(
      `[hitreg gate] clean 80ms: ${result.shotsFired} shots fired, ${result.totalResolved} resolved, agreement ${result.agreementPercent.toFixed(2)}%`,
    );
    expect(result.shotsFired).toBeGreaterThanOrEqual(SHOT_TARGET_COUNT);
    expect(result.totalResolved).toBeGreaterThan(0);
    expect(result.agreementPercent).toBeGreaterThanOrEqual(98);
  });

  it("(informational, no hard bound) 80ms +/-20ms jitter, 2% loss", () => {
    const result = runScenario({ delayMs: 40, jitterMs: 20, lossRate: 0.02 });
    // eslint-disable-next-line no-console
    console.log(
      `[hitreg gate] jittery 80ms+/-20ms, 2% loss: ${result.shotsFired} shots fired, ${result.totalResolved} resolved, agreement ${result.agreementPercent.toFixed(2)}%`,
    );
    expect(result.shotsFired).toBeGreaterThanOrEqual(SHOT_TARGET_COUNT);
    // No hard bound per spec — this is informational only.
  });
});
