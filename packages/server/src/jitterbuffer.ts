// Per-client adaptive jitter buffer for inputs. Client redundantly resends
// each input frame up to 3x (see @vg/protocol InputBatch), so the buffer
// de-duplicates by sequence number and serves the smallest not-yet-served
// sequence each server tick — an implicit reordering tolerance (an
// out-of-order older frame can still overtake a newer one that arrived
// first, as long as it shows up before its slot is drained) without
// requiring strict per-tick seq alignment.
export interface JitterBufferStats {
  starvedRate: number; // fraction of consume() calls that had nothing buffered
  minDepth: number;
  maxDepth: number;
  targetDepth: number;
}

export class JitterBuffer<T> {
  private readonly minTargetDepth: number;
  private readonly maxTargetDepth: number;
  private targetDepth: number;

  private queue: Array<{ seq: number; value: T }> = [];
  private nextSeqToAdmit = 0;
  private lastValue: T | null = null;
  private started = false;
  private overfullStreak = 0;

  private tickCount = 0;
  private starvedCount = 0;
  private depthHistory: number[] = [];
  private starvedHistory: boolean[] = [];

  constructor(minTargetDepth = 1, maxTargetDepth = 3, initialTargetDepth = 2) {
    this.minTargetDepth = minTargetDepth;
    this.maxTargetDepth = maxTargetDepth;
    this.targetDepth = Math.min(maxTargetDepth, Math.max(minTargetDepth, initialTargetDepth));
  }

  /** Called whenever a (possibly redundant, possibly out-of-order) frame arrives. */
  arrive(seq: number, value: T): void {
    if (seq < this.nextSeqToAdmit) return; // already consumed or superseded
    if (this.queue.some((q) => q.seq === seq)) return; // duplicate (redundancy resend)
    // Sorted insert (arrays here are tiny — a handful of ticks of buffering).
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.seq > seq) i--;
    this.queue.splice(i, 0, { seq, value });
  }

  get depth(): number {
    return this.queue.length;
  }

  /** Highest sequence number actually consumed so far (-1 if none yet). */
  get lastConsumedSeq(): number {
    return this.nextSeqToAdmit - 1;
  }

  /** Called once per server tick to obtain this client's input for the tick. */
  consume(): { value: T | null; starved: boolean } {
    this.tickCount++;
    // Depth is sampled *before* this tick's pop: it's "how much was buffered
    // and available when we needed to serve", the quantity acceptance
    // criteria mean by "buffer depth" (ideally never 0, never unbounded).
    const preDepth = this.queue.length;
    this.depthHistory.push(preDepth);

    if (!this.started) {
      // Warm-up: don't start draining until we've buffered at least
      // targetDepth frames, so early jitter doesn't immediately starve us.
      if (this.queue.length < this.targetDepth) {
        this.starvedHistory.push(this.lastValue === null);
        return { value: this.lastValue, starved: this.lastValue === null };
      }
      this.started = true;
    }

    if (this.queue.length === 0) {
      this.starvedCount++;
      // Starving means targetDepth wasn't enough buffering for the observed
      // jitter; grow it (up to maxTargetDepth) so future ticks buffer more.
      this.targetDepth = Math.min(this.maxTargetDepth, this.targetDepth + 1);
      this.overfullStreak = 0;
      this.starvedHistory.push(true);
      return { value: this.lastValue, starved: true };
    }

    const next = this.queue.shift()!;
    this.nextSeqToAdmit = next.seq + 1;
    this.lastValue = next.value;

    // Consistently overfull (arrivals outrunning consumption) -> shrink the
    // target depth so a *future* re-sync buffers less before starting to
    // drain. This only lowers the warm-up gate; it must never additionally
    // discard/skip a second queued frame here to "catch up faster" — every
    // consumed seq must correspond to an input actually applied via tick(),
    // or lastConsumedSeq (which the client trusts to mean "the server has
    // applied everything through this seq") would lie, silently breaking
    // reconciliation (a real bug caught by the acceptance-criterion-3 test).
    if (this.queue.length > this.targetDepth) {
      this.overfullStreak++;
      if (this.overfullStreak >= 8) {
        this.targetDepth = Math.max(this.minTargetDepth, this.targetDepth - 1);
        this.overfullStreak = 0;
      }
    } else {
      this.overfullStreak = 0;
    }

    this.starvedHistory.push(false);
    return { value: this.lastValue, starved: false };
  }

  stats(sinceTick = 0): JitterBufferStats {
    const depths = this.depthHistory.slice(sinceTick);
    const starves = this.starvedHistory.slice(sinceTick);
    const starvedRate = starves.length === 0 ? 0 : starves.filter(Boolean).length / starves.length;
    return {
      starvedRate,
      minDepth: depths.length === 0 ? 0 : Math.min(...depths),
      maxDepth: depths.length === 0 ? 0 : Math.max(...depths),
      targetDepth: this.targetDepth,
    };
  }
}
