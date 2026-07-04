// Client-side prediction + reconciliation for the local player. Pure logic,
// no DOM/rendering — net.ts wires this to the real WebSocket, tests wire it
// to a loopback @vg/server ServerHost directly.
import { createState, tick, type Box, type InputFrame, type SimState } from "@vg/sim";
import { quantizeInputSample } from "@vg/protocol";

/** Per-tick decay applied to the render-only correction offset (see reconcile()). */
const CORRECTION_DECAY_PER_TICK = 0.85;
/** Below this, a reconciliation diff is treated as noise and silently kept (no visible correction). */
const RECONCILE_EPSILON_M = 1e-3;

export interface AuthoritativePlayerState {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  yaw: number;
  pitch: number;
  crouching: boolean;
  grounded: boolean;
}

export interface AuthoritativeSnapshot {
  serverTick: number;
  lastProcessedSeq: number;
  players: readonly AuthoritativePlayerState[];
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Predicts the local player forward every tick and reconciles against
 * periodic authoritative snapshots. Remote players are *not* simulated here
 * (see interpolation.ts) — their slots in the predicted SimState are simply
 * left frozen at whatever the last snapshot said, since we never advance
 * them with real input.
 */
export class PredictedClient {
  private state: SimState;
  private readonly boxes: readonly Box[];
  private readonly localIndex: number;
  private readonly inputBuffer = new Map<number, InputFrame>();
  private nextSeq = 0;

  private correctionOffset: Vec3 = { x: 0, y: 0, z: 0 };
  /** Count of corrections whose diff exceeded the epsilon (for HUD "corrections/s"). */
  correctionsApplied = 0;

  constructor(seed: number, numPlayers: number, localIndex: number, boxes: readonly Box[]) {
    this.state = createState(seed, numPlayers);
    this.localIndex = localIndex;
    this.boxes = boxes;
  }

  getPredictedState(): SimState {
    return this.state;
  }

  /** Render-only position: the simulated position smoothed by any in-flight correction. */
  getRenderPosition(): Vec3 {
    return {
      x: this.state.posX[this.localIndex]! - this.correctionOffset.x,
      y: this.state.posY[this.localIndex]! - this.correctionOffset.y,
      z: this.state.posZ[this.localIndex]! - this.correctionOffset.z,
    };
  }

  getLocalIndex(): number {
    return this.localIndex;
  }

  private stepLocalOnly(state: SimState, input: InputFrame): SimState {
    const inputs: (InputFrame | undefined)[] = new Array(state.numPlayers);
    inputs[this.localIndex] = input;
    return tick(state, inputs as readonly InputFrame[], this.boxes);
  }

  /**
   * Call once per fixed tick with this tick's built input. Quantizes it to
   * exactly what the wire will carry (forward/right -> -1/0/1, yaw/pitch ->
   * f32) *before* predicting or buffering — reviewer finding F4: predicting
   * with the raw analog/f64 input while the server only ever applies the
   * post-wire-quantized version produces a small but systematic drift that
   * compounds over a long match. Returns the sequence number and the exact
   * (quantized) input the caller must send on the wire, so prediction,
   * replay, and the sent bytes all agree on one "true" value per tick.
   */
  queueAndPredict(input: InputFrame): { seq: number; quantizedInput: InputFrame } {
    const quantizedInput = quantizeInputSample(input);
    const seq = this.nextSeq++;
    this.inputBuffer.set(seq, quantizedInput);
    this.state = this.stepLocalOnly(this.state, quantizedInput);
    this.decayCorrection();
    return { seq, quantizedInput };
  }

  private decayCorrection(): void {
    this.correctionOffset.x *= CORRECTION_DECAY_PER_TICK;
    this.correctionOffset.y *= CORRECTION_DECAY_PER_TICK;
    this.correctionOffset.z *= CORRECTION_DECAY_PER_TICK;
  }

  /**
   * Adopts `snapshot` as the authoritative base, discards acked inputs
   * (seq <= lastProcessedSeq), and re-simulates the remaining buffered
   * inputs for the local player only. If the result differs from the
   * pre-reconciliation prediction by less than 1 mm, the old prediction is
   * kept as-is (no-op) to avoid visible micro-jitter; otherwise the new
   * state is adopted and the *difference* is folded into a decaying
   * render-only offset so the displayed position doesn't snap.
   */
  reconcile(snapshot: AuthoritativeSnapshot): number {
    for (const seq of Array.from(this.inputBuffer.keys())) {
      if (seq <= snapshot.lastProcessedSeq) this.inputBuffer.delete(seq);
    }

    const numPlayers = this.state.numPlayers;
    let base = createState(0, numPlayers);
    base.tick = snapshot.serverTick;
    for (let i = 0; i < numPlayers; i++) {
      const p = snapshot.players[i];
      if (!p) continue;
      base.posX[i] = p.posX;
      base.posY[i] = p.posY;
      base.posZ[i] = p.posZ;
      base.velX[i] = p.velX;
      base.velY[i] = p.velY;
      base.velZ[i] = p.velZ;
      base.yaw[i] = p.yaw;
      base.pitch[i] = p.pitch;
      base.crouching[i] = p.crouching ? 1 : 0;
      base.grounded[i] = p.grounded ? 1 : 0;
    }

    const remaining = Array.from(this.inputBuffer.entries()).sort((a, b) => a[0] - b[0]);
    let replayed = base;
    for (const [, input] of remaining) {
      replayed = this.stepLocalOnly(replayed, input);
    }

    const oldPos = this.getRenderPositionForState(this.state);
    const newPos = this.getRenderPositionForState(replayed);
    const diff = Math.hypot(newPos.x - oldPos.x, newPos.y - oldPos.y, newPos.z - oldPos.z);

    if (diff < RECONCILE_EPSILON_M) {
      return diff; // keep the old prediction untouched
    }

    this.correctionsApplied++;
    // Fold the jump into the render offset so getRenderPosition() is
    // continuous at this instant, then let it decay each subsequent tick.
    // Continuity requires renderAfter == renderBefore, i.e.
    // newPos - offsetNew == oldPos - offsetOld, so offsetNew must be
    // offsetOld + (newPos - oldPos) — *not* offsetOld + (oldPos - newPos).
    this.correctionOffset.x += newPos.x - oldPos.x;
    this.correctionOffset.y += newPos.y - oldPos.y;
    this.correctionOffset.z += newPos.z - oldPos.z;
    this.state = replayed;
    return diff;
  }

  private getRenderPositionForState(state: SimState): Vec3 {
    return { x: state.posX[this.localIndex]!, y: state.posY[this.localIndex]!, z: state.posZ[this.localIndex]! };
  }
}
