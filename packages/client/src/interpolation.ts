// Remote-player interpolation: buffers snapshots keyed by serverTick and
// renders remote players ~100 ms in the past (two snapshot intervals),
// lerping between the two bracketing snapshots. Pure logic, no rendering.

/** Render delay behind the newest received snapshot, in ticks (~94 ms @ 64 Hz, two 32 Hz snapshot intervals). */
export const INTERP_DELAY_TICKS = 6;

/** Snapshots older than this many ticks behind the newest are dropped. */
const RETENTION_TICKS = 32;

export interface RemotePose {
  posX: number;
  posY: number;
  posZ: number;
  yaw: number;
  pitch: number;
  crouching: boolean;
  grounded: boolean;
  connected: boolean;
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
    // Booleans don't lerp; use the later sample once we're at/past it.
    crouching: t < 1 ? a.crouching : b.crouching,
    grounded: t < 1 ? a.grounded : b.grounded,
    connected: t < 1 ? a.connected : b.connected,
  };
}

export class RemoteInterpolator {
  private readonly snapshots = new Map<number, readonly RemotePose[]>();
  private newestTick = -1;
  private starvedFrames = 0;
  private lastSample: readonly RemotePose[] | null = null;

  ingest(serverTick: number, players: readonly RemotePose[]): void {
    if (serverTick <= this.newestTick && this.snapshots.has(serverTick)) return;
    this.snapshots.set(serverTick, players);
    if (serverTick > this.newestTick) this.newestTick = serverTick;
    for (const t of this.snapshots.keys()) {
      if (t < this.newestTick - RETENTION_TICKS) this.snapshots.delete(t);
    }
  }

  getStarvedFrameCount(): number {
    return this.starvedFrames;
  }

  /** The newest serverTick actually received so far (-1 if none yet). */
  getNewestTick(): number {
    return this.newestTick;
  }

  /** Interpolated poses for all players at (newestTick - INTERP_DELAY_TICKS), or the last good sample if starved. */
  sample(): readonly RemotePose[] | null {
    if (this.newestTick < 0) {
      this.starvedFrames++;
      return this.lastSample;
    }

    const targetTick = this.newestTick - INTERP_DELAY_TICKS;
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
    const result = a.map((pa, i) => lerpPose(pa, b[i] ?? pa, t));
    this.lastSample = result;
    return result;
  }
}
