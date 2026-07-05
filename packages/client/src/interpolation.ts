// Remote-player interpolation: buffers snapshots keyed by serverTick and
// renders remote players ~100 ms in the past (two snapshot intervals),
// lerping between the two bracketing snapshots. Pure logic, no rendering.
//
// Sampling is at *continuous* render time, not snapshot cadence: the target
// tick is `newestTick + renderAlpha - INTERP_DELAY_TICKS`, where renderAlpha
// is how many ticks' worth of wall-clock time have elapsed since the newest
// snapshot arrived (grows smoothly between arrivals, resets — mostly to a
// small residual, since arrivals are roughly periodic — when the next one
// lands). Calling sample() once per *rendered* frame (not once per fixed
// network tick) is what actually makes remote players glide instead of
// stepping at the 32 Hz snapshot rate; see net.ts / main.ts.
import { FIXED_DT } from "@vg/sim";

/** Render delay behind the newest received snapshot, in ticks (~94 ms @ 64 Hz, two 32 Hz snapshot intervals). */
export const INTERP_DELAY_TICKS = 6;

/** Snapshots older than this many ticks behind the newest are dropped. */
const RETENTION_TICKS = 32;

const FIXED_DT_MS = FIXED_DT * 1000;

export interface RemotePose {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  crouching: boolean;
  grounded: boolean;
  connected: boolean;
  alive: boolean;
  weaponPrimary: number;
  weaponSecondary: number;
  activeSlot: number;
  /**
   * Active-slot ammo as of this pose (from Snapshot.magActive) — used as a
   * "did they just fire?" heuristic for remote tracers (see main.ts): a
   * decrease between successive raw snapshots (not interpolated samples)
   * means a shot was fired (reloads only ever increase it). Deviation,
   * stated plainly: the spec describes gating remote tracers on a
   * `shotCounter` increment, but shotCounter is intentionally not on the
   * wire (see @vg/protocol messages.ts) — it's pure local-prediction
   * bookkeeping, never confirmed/broadcast. This magActive-delta heuristic
   * is the closest observable proxy and is exact except for the rare case
   * of a shot that doesn't consume ammo (there is none, currently).
   */
  magActive: number;
  /** M3: 0 attackers, 1 defenders, 255 unassigned (TEAM_NONE) — used by the minimap to color dots. */
  team: number;
}

export interface RemoteInterpolatorOptions {
  /** Clock in ms, defaults to performance.now. Tests inject a virtual clock for determinism. */
  now?: () => number;
}

function wrapAngleDiff(a: number, b: number): number {
  // Shortest signed difference b-a, wrapped into (-PI, PI], so lerping across
  // the +-PI seam doesn't spin the long way around.
  let d = b - a;
  const TWO_PI = Math.PI * 2;
  d = ((d + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return d;
}

function lerpPose(a: RemotePose, b: RemotePose, t: number): RemotePose {
  return {
    posX: a.posX + (b.posX - a.posX) * t,
    posY: a.posY + (b.posY - a.posY) * t,
    posZ: a.posZ + (b.posZ - a.posZ) * t,
    yaw: a.yaw + wrapAngleDiff(a.yaw, b.yaw) * t,
    pitch: a.pitch + wrapAngleDiff(a.pitch, b.pitch) * t,
    // Booleans/discrete fields don't lerp; use the later sample once we're at/past it.
    crouching: t < 1 ? a.crouching : b.crouching,
    grounded: t < 1 ? a.grounded : b.grounded,
    connected: t < 1 ? a.connected : b.connected,
    alive: t < 1 ? a.alive : b.alive,
    weaponPrimary: t < 1 ? a.weaponPrimary : b.weaponPrimary,
    weaponSecondary: t < 1 ? a.weaponSecondary : b.weaponSecondary,
    activeSlot: t < 1 ? a.activeSlot : b.activeSlot,
    magActive: t < 1 ? a.magActive : b.magActive,
    team: t < 1 ? a.team : b.team,
  };
}

export class RemoteInterpolator {
  private readonly snapshots = new Map<number, readonly RemotePose[]>();
  private readonly now: () => number;
  private newestTick = -1;
  private newestArrivalMs = 0;
  private starvedFrames = 0;
  private lastSample: readonly RemotePose[] | null = null;

  constructor(options: RemoteInterpolatorOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  ingest(serverTick: number, players: readonly RemotePose[]): void {
    if (serverTick <= this.newestTick && this.snapshots.has(serverTick)) return;
    this.snapshots.set(serverTick, players);
    if (serverTick > this.newestTick) {
      this.newestTick = serverTick;
      this.newestArrivalMs = this.now();
    }
    for (const t of this.snapshots.keys()) {
      if (t < this.newestTick - RETENTION_TICKS) this.snapshots.delete(t);
    }
  }

  getStarvedFrameCount(): number {
    return this.starvedFrames;
  }

  /** The newest serverTick actually received so far (-1 if none yet); an integer. */
  getNewestTick(): number {
    return this.newestTick;
  }

  /**
   * The continuous (fractional) tick this instant's render should target:
   * newestTick + renderAlpha - INTERP_DELAY_TICKS, where renderAlpha is the
   * wall-clock time elapsed since the newest snapshot arrived, expressed in
   * ticks. Grows smoothly frame to frame; not gated to snapshot cadence.
   */
  getCurrentTargetTick(): number {
    if (this.newestTick < 0) return Number.NEGATIVE_INFINITY;
    const renderAlpha = (this.now() - this.newestArrivalMs) / FIXED_DT_MS;
    return this.newestTick + renderAlpha - INTERP_DELAY_TICKS;
  }

  /** Interpolated poses for all players at the current continuous target tick, or the last good sample if starved. */
  sample(): readonly RemotePose[] | null {
    const targetTick = this.getCurrentTargetTick();
    if (!Number.isFinite(targetTick)) {
      this.starvedFrames++;
      return this.lastSample;
    }

    let lower = -Infinity;
    let upper = Infinity;
    for (const t of this.snapshots.keys()) {
      if (t <= targetTick && t > lower) lower = t;
      if (t >= targetTick && t < upper) upper = t;
    }

    if (lower === -Infinity && upper === Infinity) {
      this.starvedFrames++;
      return this.lastSample;
    }
    if (lower === -Infinity) lower = upper;
    if (upper === Infinity) upper = lower;

    const a = this.snapshots.get(lower)!;
    const b = this.snapshots.get(upper)!;
    const t = upper === lower ? 0 : (targetTick - lower) / (upper - lower);
    const clampedT = Math.max(0, Math.min(1, t));
    const result = a.map((pa, i) => lerpPose(pa, b[i] ?? pa, clampedT));
    this.lastSample = result;
    return result;
  }
}
