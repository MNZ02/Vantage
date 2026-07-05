// Hit-registration telemetry (M2 gate, see PLAN.md §3.7 "Telemetry from M2").
// Tracks agreement between the client's own cosmetic predicted-hit raycast
// (against currently-interpolated remote poses, fired the instant the local
// player's shot leaves the barrel) and the server's authoritative HitConfirm
// for that same shooter.
//
// Matching heuristic, stated plainly: HitConfirm does not carry a shotIndex
// (see @vg/protocol messages.ts) — a miss produces no message at all, so
// there is nothing to correlate a miss against. Matching is therefore FIFO
// per shooter: each predicted shot is queued in fire order; a predicted-hit
// entry is resolved by the next arriving HitConfirm (within `windowMs`) or
// times out as a disagreement if none arrives; a predicted-miss entry is
// resolved as an agreement once it *ages out* of the window with no
// intervening confirm consuming it first. This is exact for the gate
// scenario (one shooter, aimed shots, no overlapping ambiguous confirms) and
// a reasonable approximation otherwise.
export interface HitRegStats {
  agreeCount: number;
  totalResolved: number;
  /** 100 when nothing has resolved yet (no evidence of disagreement). */
  agreementPercent: number;
}

export class HitRegTracker {
  private readonly pending: Array<{ predictedHit: boolean; firedAtMs: number }> = [];
  private agreeCount = 0;
  private totalResolved = 0;

  constructor(
    private readonly windowMs = 250,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Call once per shot this client predicted for its own player, with whether the cosmetic raycast said it hit. */
  recordPredictedShot(predictedHit: boolean): void {
    this.pending.push({ predictedHit, firedAtMs: this.now() });
  }

  /** Call once per HitConfirm received for a shot this client fired (see net.ts). */
  recordConfirmedHit(): void {
    this.expire(); // drop anything that's already timed out before consuming a slot
    const entry = this.pending.shift();
    if (!entry) return; // stray/late confirm with nothing pending (e.g. after a burst of misses cleared the queue): ignore
    this.totalResolved++;
    if (entry.predictedHit) this.agreeCount++;
  }

  /** Call periodically (e.g. once per tick/frame) to resolve predicted shots that got no confirm within the window. */
  expire(): void {
    const now = this.now();
    while (this.pending.length > 0 && now - this.pending[0]!.firedAtMs > this.windowMs) {
      const entry = this.pending.shift()!;
      this.totalResolved++;
      if (!entry.predictedHit) this.agreeCount++; // predicted miss, no confirm ever arrived: agreement
      // predicted hit with no confirm in time: disagreement (already counted via totalResolved without bumping agreeCount)
    }
  }

  getStats(): HitRegStats {
    return {
      agreeCount: this.agreeCount,
      totalResolved: this.totalResolved,
      agreementPercent: this.totalResolved === 0 ? 100 : (100 * this.agreeCount) / this.totalResolved,
    };
  }
}
