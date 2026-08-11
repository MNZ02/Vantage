// Per-client adaptive jitter buffer for inputs. Client redundantly resends
// each input frame up to 3x (see @vg/protocol InputBatch), so the buffer
// de-duplicates by sequence number and serves the smallest not-yet-served
// sequence each server tick — an implicit reordering tolerance (an
// out-of-order older frame can still overtake a newer one that arrived
// first, as long as it shows up before its slot is drained) without
// requiring strict per-tick seq alignment.
//
// Design note (reviewer finding F5, deliberately left as-is): once
// `started`, consume() drains greedily whenever the queue is non-empty and
// never re-enters a "wait until targetDepth is rebuilt" pause after a
// starvation event. That means growing targetDepth on starvation doesn't
// actually restore a cushion for the *next* burst of jitter — it only
// raises the bar a brand-new client's initial warm-up gate has to clear.
// In steady state, the input redundancy (each frame resent up to 3x) is
// doing the real resilience work: a single dropped/delayed arrival is
// almost always still covered by an earlier copy already in the queue, or
// arrives in time via a later duplicate before its slot would be missed.
//
// The alternative — pausing consumption (re-starving on purpose) until the
// queue rebuilds to targetDepth after every starvation event — would trade
// a few extra ticks of added input latency for every player on the server
// each time *any* single tick starves, which felt like the wrong trade for
// a feel-sensitive path. Chose to document this clearly instead of change
// the behavior; revisit if the acceptance numbers (criterion 6) stop
// holding under harsher jitter profiles than tested here.
export interface JitterBufferStats {
  starvedRate: number; // fraction of consume() calls that had nothing buffered
  minDepth: number;
  maxDepth: number;
  targetDepth: number;
}

export class JitterBuffer<T> {
  private static readonly MAX_QUEUE_DEPTH = 64;
  private static readonly MAX_SEQUENCE_LEAD = 128;
  /** Two minutes of 64 Hz diagnostics without an ever-growing production allocation. */
  private static readonly HISTORY_CAPACITY = 64 * 120;

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
  private readonly depthHistory = new Uint8Array(JitterBuffer.HISTORY_CAPACITY);
  private readonly starvedHistory = new Uint8Array(JitterBuffer.HISTORY_CAPACITY);

  constructor(minTargetDepth = 1, maxTargetDepth = 3, initialTargetDepth = 2) {
    this.minTargetDepth = minTargetDepth;
    this.maxTargetDepth = maxTargetDepth;
    this.targetDepth = Math.min(maxTargetDepth, Math.max(minTargetDepth, initialTargetDepth));
  }

  /** Called whenever a (possibly redundant, possibly out-of-order) frame arrives. */
  arrive(seq: number, value: T): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0) return false;
    if (seq < this.nextSeqToAdmit) return true; // already consumed or superseded
    if (seq > this.nextSeqToAdmit + JitterBuffer.MAX_SEQUENCE_LEAD) return false;
    if (this.queue.some((q) => q.seq === seq)) return true; // duplicate (redundancy resend)
    if (this.queue.length >= JitterBuffer.MAX_QUEUE_DEPTH) return false;
    // Sorted insert (arrays here are tiny — a handful of ticks of buffering).
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1]!.seq > seq) i--;
    this.queue.splice(i, 0, { seq, value });
    return true;
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
    const historyIndex = (this.tickCount - 1) % JitterBuffer.HISTORY_CAPACITY;
    this.depthHistory[historyIndex] = Math.min(255, preDepth);

    if (!this.started) {
      // Warm-up: don't start draining until we've buffered at least
      // targetDepth frames, so early jitter doesn't immediately starve us.
      if (this.queue.length < this.targetDepth) {
        this.starvedHistory[historyIndex] = this.lastValue === null ? 1 : 0;
        return { value: this.lastValue, starved: this.lastValue === null };
      }
      this.started = true;
    }

    if (this.queue.length === 0) {
      this.starvedCount++;
      // Starving means targetDepth wasn't enough buffering for the observed
      // jitter; grow it (up to maxTargetDepth). Note this is a secondary,
      // best-effort signal, not the primary defense — see the file-level
      // comment (F5): it doesn't pause draining to rebuild a cushion right
      // now, it only raises the warm-up gate a *future* re-sync would have
      // to clear. Input redundancy is what actually absorbs this tick's loss.
      this.targetDepth = Math.min(this.maxTargetDepth, this.targetDepth + 1);
      this.overfullStreak = 0;
      this.starvedHistory[historyIndex] = 1;
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

    this.starvedHistory[historyIndex] = 0;
    return { value: this.lastValue, starved: false };
  }

  stats(sinceTick = 0): JitterBufferStats {
    const oldestRetainedTick = Math.max(0, this.tickCount - JitterBuffer.HISTORY_CAPACITY);
    const startTick = Math.max(oldestRetainedTick, Math.min(this.tickCount, Math.max(0, Math.floor(sinceTick))));
    let samples = 0;
    let starves = 0;
    let minDepth = Number.POSITIVE_INFINITY;
    let maxDepth = 0;
    for (let tick = startTick; tick < this.tickCount; tick++) {
      const index = tick % JitterBuffer.HISTORY_CAPACITY;
      const depth = this.depthHistory[index]!;
      samples++;
      starves += this.starvedHistory[index]!;
      minDepth = Math.min(minDepth, depth);
      maxDepth = Math.max(maxDepth, depth);
    }
    return {
      starvedRate: samples === 0 ? 0 : starves / samples,
      minDepth: samples === 0 ? 0 : minDepth,
      maxDepth: samples === 0 ? 0 : maxDepth,
      targetDepth: this.targetDepth,
    };
  }
}
