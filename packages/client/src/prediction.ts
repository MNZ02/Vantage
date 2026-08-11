// Client-side prediction + reconciliation for the local player. Pure logic,
// no DOM/rendering — net.ts wires this to the real WebSocket, tests wire it
// to a loopback @vg/server ServerHost directly.
import {
  MODE_DM,
  MODE_MATCH,
  WEAPON_NONE,
  cloneState,
  createMatchState,
  createState,
  tick,
  type Box,
  type InputFrame,
  type ShotEvent,
  type SimState,
} from "@vg/sim";
import { quantizeInputSample } from "@vg/protocol";

/** Per-tick decay applied to the render-only correction offset (see reconcile()). */
const CORRECTION_DECAY_PER_TICK = 0.85;
/** Below this, a reconciliation diff is treated as noise and silently kept (no visible correction). */
const RECONCILE_EPSILON_M = 1e-3;
/** Three seconds of 64 Hz history: enough for severe jitter without retaining tens of thousands of typed-array objects. */
const HISTORY_RETENTION = 192;
const MAX_PENDING_INPUTS = 192;

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
  // M2 combat fields (mirror @vg/protocol SnapshotPlayer's confirmed subset).
  alive: boolean;
  activeSlot: number;
  adsStage: number;
  health: number;
  armor: number;
  weaponPrimary: number;
  weaponSecondary: number;
  magActive: number;
  reserveActive: number;
  tagTicksLeft: number;
  credits: number;
  respawnTicksLeft: number;
  /** M3: 0 attackers, 1 defenders, 255 unassigned (TEAM_NONE). */
  team: number;
  // ---- M4a ----
  agentId: number;
  ultPoints: number;
  flashedTicksLeft: number;
  flashIntensity: number;
  abilityCharges: readonly [number, number, number, number];
}

/** M4a: one live ability world-entity, mirroring @vg/protocol's SnapshotAbilityEntity. */
export interface AuthoritativeAbilityEntity {
  slot: number;
  entType: number;
  owner: number;
  abilityId: number;
  x: number;
  y: number;
  z: number;
  velX: number;
  velY: number;
  velZ: number;
  ageTicks: number;
  endTicksLeft: number;
  param: number;
}

/**
 * M3 match section (mirrors @vg/protocol SnapshotMessage's match fields).
 * Optional/undefined for a DM-mode server, in which case reconcile() leaves
 * the predicted state's match fields untouched (PredictedClient was
 * constructed with mode MODE_DM to begin with, so they're inert anyway).
 */
export interface AuthoritativeMatchSection {
  mode: number;
  matchPhase: number;
  phaseTicksLeft: number;
  roundNumber: number;
  scoreTeam0: number;
  scoreTeam1: number;
  spikeState: number;
  spikeCarrier: number;
  spikeX: number;
  spikeY: number;
  spikeZ: number;
  spikePlantedTicksLeft: number;
  activePlantProgress: number;
  planterIndex: number;
  activeDefuseProgress: number;
  defuserIndex: number;
}

export interface AuthoritativeSnapshot {
  serverTick: number;
  lastProcessedSeq: number;
  players: readonly AuthoritativePlayerState[];
  match?: AuthoritativeMatchSection;
  /** M4a: full ability world-entity list (projectiles/smokes/walls/zones/recon darts/orbs) — always authoritative-overwrite, same treatment as the match section (see reconcile()'s doc comment on why this is safe for the local player's own in-flight casts too: determinism means they should already match, mod f32 quantization). */
  abilityEntities?: readonly AuthoritativeAbilityEntity[];
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
 *
 * M2: weapon state (ammo, spray, ADS, reload, tag/land timers) rides along
 * for free — it's just more fields on SimState that tick() already advances
 * deterministically. The one wrinkle: Snapshot only confirms the *active*
 * slot's ammo (bandwidth), never the inactive slot's — see reconcile()'s
 * doc comment for how the inactive slot and shot-spray-only bookkeeping
 * (shotCounter/sprayIndex/timers, never sent over the wire at all) are
 * carried forward from the client's own prediction instead of being reset.
 */
export class PredictedClient {
  private state: SimState;
  private readonly boxes: readonly Box[];
  private readonly localIndex: number;
  private readonly inputScratch: (InputFrame | undefined)[];
  private readonly inputBuffer = new Map<number, InputFrame>();
  /**
   * The predicted state as it was right after each queueAndPredict() call,
   * keyed by that call's seq — reconcile()'s base for fields the snapshot
   * doesn't confirm (ammo, spray/fire timers) must come from THIS history at
   * `lastProcessedSeq`, not from the *current* `this.state`: by the time a
   * snapshot arrives, `this.state` already reflects having applied every
   * buffered-and-about-to-be-replayed input once already, so carrying it
   * forward as the replay base would double-apply them (double-firing shots,
   * double-decrementing ammo, etc.) — a real bug caught by
   * prediction-under-fire.test.ts.
   */
  private readonly stateHistory = new Map<number, SimState>();
  private nextSeq = 0;
  private lastShots: ShotEvent[] = [];

  private correctionOffset: Vec3 = { x: 0, y: 0, z: 0 };
  /** Count of corrections whose diff exceeded the epsilon (for HUD "corrections/s"). */
  correctionsApplied = 0;

  /**
   * `mode` (default MODE_DM) picks createState() vs createMatchState() —
   * match mode requires the full MatchConfig-shaped state for phase/spike
   * fields to exist at all. Known limitation, stated plainly: MatchConfig
   * itself isn't transmitted over the wire (only its effects are, via the
   * Snapshot match section), so this always uses the compiled-in
   * DEFAULT_MATCH_CONFIG — exact prediction of phase timers is only
   * guaranteed when the server ALSO runs the defaults (true in production;
   * tests that shrink timers server-side will see extra reconciliation
   * corrections on phase-boundary ticks, which is fine — reconcile() still
   * converges, just via a visible correction instead of an invisible one).
   */
  constructor(seed: number, numPlayers: number, localIndex: number, boxes: readonly Box[], mode: number = MODE_DM) {
    this.state = mode === MODE_MATCH ? createMatchState(seed, numPlayers) : createState(seed, numPlayers);
    this.localIndex = localIndex;
    this.boxes = boxes;
    this.inputScratch = new Array(numPlayers);
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

  /** ShotEvents fired by the local player on the most recent queueAndPredict() call (usually 0 or 1). */
  getLastShots(): readonly ShotEvent[] {
    return this.lastShots;
  }

  /** Recent unacknowledged input count, exposed for diagnostics/retention tests. */
  getPendingInputCount(): number {
    return this.inputBuffer.size;
  }

  /** Recent predicted-state checkpoint count, exposed for diagnostics/retention tests. */
  getRetainedStateCount(): number {
    return this.stateHistory.size;
  }

  private stepLocalOnly(state: SimState, input: InputFrame): { state: SimState; shots: ShotEvent[] } {
    this.inputScratch[this.localIndex] = input;
    const result = tick(state, this.inputScratch as readonly InputFrame[], this.boxes);
    this.inputScratch[this.localIndex] = undefined;
    return { state: result.state, shots: result.shots };
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
    if (this.inputBuffer.size > MAX_PENDING_INPUTS) {
      const oldestSeq = this.inputBuffer.keys().next().value as number | undefined;
      if (oldestSeq !== undefined) {
        this.inputBuffer.delete(oldestSeq);
        this.stateHistory.delete(oldestSeq);
      }
    }
    const result = this.stepLocalOnly(this.state, quantizedInput);
    this.state = result.state;
    this.lastShots = result.shots;
    this.stateHistory.set(seq, this.state); // tick() always returns a fresh object, safe to keep by reference
    this.pruneHistory();
    this.decayCorrection();
    return { seq, quantizedInput };
  }

  private pruneHistory(): void {
    const cutoff = this.nextSeq - HISTORY_RETENTION;
    if (cutoff <= 0) return;
    for (const seq of this.stateHistory.keys()) {
      if (seq < cutoff) this.stateHistory.delete(seq);
      else break; // Map preserves insertion order, which is ascending seq order here
    }
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
   *
   * base starts as a CLONE of this client's OWN predicted state as it was at
   * `snapshot.lastProcessedSeq` (see stateHistory) — not the current
   * `this.state` — and only the fields the snapshot actually confirms are
   * overwritten from it. This is what keeps reconciliation exact while
   * reloading/switching weapons: Snapshot only ever carries the *active*
   * slot's ammo and none of the shot-spray/fire-timer bookkeeping at all
   * (see @vg/protocol SnapshotPlayer) — those un-confirmed fields must
   * survive from the client's own prediction AT THAT POINT IN TIME, before
   * any of the about-to-be-replayed buffered inputs were applied — using the
   * *current* state instead would double-apply those inputs' weapon-state
   * effects (double-firing a shot, double-decrementing ammo, ...) since the
   * current state already reflects having applied them once, forward.
   */
  reconcile(snapshot: AuthoritativeSnapshot): number {
    for (const seq of Array.from(this.inputBuffer.keys())) {
      if (seq <= snapshot.lastProcessedSeq) this.inputBuffer.delete(seq);
    }

    const numPlayers = this.state.numPlayers;
    const historicalBase = this.stateHistory.get(snapshot.lastProcessedSeq);
    const sourceForBase = historicalBase ?? this.state;
    const base = cloneState(sourceForBase);
    // Rebasing base.tick to the server's absolute tick numbering (below) is
    // necessary (the server IS the authoritative clock), but every
    // ABSOLUTE-tick-referencing weapon-timer field carried forward from
    // sourceForBase (nextFireTick, reloadEndTick, equipEndTick — anything
    // compared against state.tick, as opposed to a ticks-*remaining* counter
    // like tagTicksLeft/landPenaltyTicksLeft, which need no adjustment) was
    // computed in sourceForBase's OWN tick numbering. Left un-shifted, a
    // rebase to a very different absolute tick (e.g. right after the
    // server's jitter-buffer warm-up, where its tick count is already well
    // ahead of the small number of local ticks this client has actually
    // simulated) makes those timers compare against the wrong reference
    // frame entirely — e.g. a fire-rate cooldown that should still be
    // active reads as already-expired, letting a shot fire far too early.
    // This was a real bug, caught by prediction-under-fire.test.ts.
    const tickOffset = snapshot.serverTick - sourceForBase.tick;
    base.tick = snapshot.serverTick;
    for (let i = 0; i < numPlayers; i++) {
      base.nextFireTick[i] = base.nextFireTick[i]! + tickOffset;
      if (base.reloadEndTick[i] !== -1) base.reloadEndTick[i] = base.reloadEndTick[i]! + tickOffset;
      if (base.equipEndTick[i] !== -1) base.equipEndTick[i] = base.equipEndTick[i]! + tickOffset;
      // respawnTick is set directly from the snapshot below (when present)
      // in the new tick frame already; no separate shift needed for it.

      // M4a: same absolute-tick rebasing rule applies to every unconfirmed
      // (never sent over the wire) ability timer compared against
      // state.tick — a pending cast's ready tick, a signature's in-progress
      // recharge deadline, and Rail's activation-window close time.
      if (base.pendingReadyTick[i] !== -1) base.pendingReadyTick[i] = base.pendingReadyTick[i]! + tickOffset;
      if (base.signatureRechargeEndTick[i] !== -1) base.signatureRechargeEndTick[i] = base.signatureRechargeEndTick[i]! + tickOffset;
      if (base.ultWindowEndTick[i] !== -1) base.ultWindowEndTick[i] = base.ultWindowEndTick[i]! + tickOffset;
    }

    // M4a: ability world-entities are global (not owned per-player in the
    // sense combat state is), so — like the match section — position/type/
    // param/lifetime are a straight authoritative overwrite rather than a
    // partial-confirmation merge. This also correctly seeds OTHER players'
    // in-flight casts (never predicted locally, since stepLocalOnly only
    // ever feeds real input to the local player — every other player's
    // tick() input is `undefined`, so their casts never spawn entities in
    // this client's own forward prediction) without disturbing the local
    // player's own cast entities, whose position should already match
    // bit-for-bit (mod f32 wire quantization) thanks to determinism.
    //
    // Protocol v5 carries stable slots plus velocity/orientation and age, so
    // sparse server entity arrays cannot remap onto unrelated client slots.
    if (snapshot.abilityEntities) {
      const n = base.entType.length;
      for (let e = 0; e < n; e++) {
        base.entType[e] = 0; // ENT_NONE
        base.entOwner[e] = 255;
        base.entAbilityId[e] = 0;
        base.entX[e] = 0;
        base.entY[e] = 0;
        base.entZ[e] = 0;
        base.entVelX[e] = 0;
        base.entVelY[e] = 0;
        base.entVelZ[e] = 0;
        base.entSpawnTick[e] = 0;
        base.entEndTick[e] = -1;
        base.entParam[e] = 0;
      }
      for (const ent of snapshot.abilityEntities) {
        const e = ent.slot;
        if (!Number.isInteger(e) || e < 0 || e >= n) continue;
        base.entType[e] = ent.entType;
        base.entOwner[e] = ent.owner;
        base.entAbilityId[e] = ent.abilityId;
        base.entX[e] = ent.x;
        base.entY[e] = ent.y;
        base.entZ[e] = ent.z;
        base.entVelX[e] = ent.velX;
        base.entVelY[e] = ent.velY;
        base.entVelZ[e] = ent.velZ;
        base.entSpawnTick[e] = snapshot.serverTick - ent.ageTicks;
        base.entEndTick[e] = ent.endTicksLeft > 0 ? snapshot.serverTick + ent.endTicksLeft : -1;
        base.entParam[e] = ent.param;
      }
    }
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

      base.alive[i] = p.alive ? 1 : 0;
      base.activeSlot[i] = p.activeSlot;
      base.adsStage[i] = p.adsStage;
      base.health[i] = p.health;
      base.armor[i] = p.armor;
      base.weaponPrimary[i] = p.weaponPrimary;
      base.weaponSecondary[i] = p.weaponSecondary;
      base.tagTicksLeft[i] = p.tagTicksLeft;
      base.credits[i] = p.credits;
      base.respawnTick[i] = p.alive ? -1 : snapshot.serverTick + p.respawnTicksLeft;
      base.team[i] = p.team;

      // M4a: agentId/ultPoints/flash/abilityCharges are ALL sent for every
      // player every snapshot (no "active slot only" partial-confirmation
      // rule like ammo has — see @vg/protocol's module doc comment), so
      // these are straight overwrites too.
      base.agentId[i] = p.agentId;
      base.ultPoints[i] = p.ultPoints;
      base.flashedUntilTick[i] = p.flashedTicksLeft > 0 ? snapshot.serverTick + p.flashedTicksLeft : 0;
      base.flashIntensity[i] = p.flashIntensity;
      base.abilityCharges[i * 4 + 0] = p.abilityCharges[0];
      base.abilityCharges[i * 4 + 1] = p.abilityCharges[1];
      base.abilityCharges[i * 4 + 2] = p.abilityCharges[2];
      base.abilityCharges[i * 4 + 3] = p.abilityCharges[3];

      // Only the confirmed *active* slot's ammo is authoritative; the other
      // slot(s) keep whatever this client already predicted (see doc comment).
      if (p.weaponPrimary === WEAPON_NONE) {
        base.magPrimary[i] = 0;
        base.reservePrimary[i] = 0;
      }
      if (p.activeSlot === 0) {
        base.magPrimary[i] = p.magActive;
        base.reservePrimary[i] = p.reserveActive;
      } else if (p.activeSlot === 1) {
        base.magSecondary[i] = p.magActive;
        base.reserveSecondary[i] = p.reserveActive;
      } else {
        // activeSlot 2 = ult weapon (Blades/Rail) — see @vg/sim weapons/logic.ts.
        base.magUlt[i] = p.magActive;
      }
    }

    // M3 match section: global (not per-player) fields, all directly
    // authoritative — unlike weapon-timer fields there's no "unconfirmed"
    // subset here, so this is a straight overwrite. See AuthoritativeMatchSection's
    // doc comment for the one caveat (MatchConfig itself isn't on the wire).
    const match = snapshot.match;
    if (match) {
      base.mode = match.mode;
      base.matchPhase = match.matchPhase;
      base.phaseEndTick = match.phaseTicksLeft > 0 ? snapshot.serverTick + match.phaseTicksLeft : -1;
      base.roundNumber = match.roundNumber;
      base.scoreTeam0 = match.scoreTeam0;
      base.scoreTeam1 = match.scoreTeam1;
      base.spikeState = match.spikeState;
      base.spikeCarrier = match.spikeCarrier;
      base.spikeX = match.spikeX;
      base.spikeY = match.spikeY;
      base.spikeZ = match.spikeZ;
      base.spikePlantedTick = match.spikePlantedTicksLeft > 0 ? snapshot.serverTick + match.spikePlantedTicksLeft - base.config.spikeTicks : -1;
      base.plantProgress = match.activePlantProgress;
      base.planterIndex = match.planterIndex;
      base.defuseProgress = match.activeDefuseProgress;
      base.defuserIndex = match.defuserIndex;
      // Not transmitted; approximated from progress vs. the compiled-in
      // checkpoint threshold (see the constructor's MatchConfig caveat).
      base.defuseCheckpointHit = match.activeDefuseProgress >= base.config.defuseCheckpointTicks ? 1 : 0;
    }

    let replayed = base;
    let replayedShots: ShotEvent[] = [];
    // Map insertion order is sequence order; avoid allocating and sorting an
    // entries array on every snapshot (normally 32 times per second).
    for (const [seq, input] of this.inputBuffer) {
      const result = this.stepLocalOnly(replayed, input);
      replayed = result.state;
      replayedShots = result.shots;
      // Refresh stateHistory for every replayed seq: a later reconcile()
      // call may look up one of these seqs as ITS base, and it must see
      // this corrected trajectory, not whatever the original (now possibly
      // superseded) forward-prediction pass had stored there.
      this.stateHistory.set(seq, replayed);
    }

    const oldPos = this.getRenderPositionForState(this.state);
    const newPos = this.getRenderPositionForState(replayed);
    const diff = Math.hypot(newPos.x - oldPos.x, newPos.y - oldPos.y, newPos.z - oldPos.z);

    // Below epsilon, skip the *visible* correction (fold nothing into the
    // render offset — a sub-mm nudge would be imperceptible noise) but still
    // ADOPT the replayed state. M2 correctness note: the position epsilon
    // gate predates weapon state; a replay can legitimately correct
    // ammo/spray/fire-timing fields (e.g. exactly which tick a shot's
    // gating landed on) with *zero* position difference (imagine a
    // corrected fire-rate timer while standing still) — discarding the
    // replay whenever position happened to match would silently keep a
    // stale/wrong weapon-state prediction forever. Position is what decides
    // whether to show a *visible* correction; it must not decide whether to
    // adopt the state at all.
    if (diff >= RECONCILE_EPSILON_M) {
      this.correctionsApplied++;
      // Fold the jump into the render offset so getRenderPosition() is
      // continuous at this instant, then let it decay each subsequent tick.
      // Continuity requires renderAfter == renderBefore, i.e.
      // newPos - offsetNew == oldPos - offsetOld, so offsetNew must be
      // offsetOld + (newPos - oldPos) — *not* offsetOld + (oldPos - newPos).
      this.correctionOffset.x += newPos.x - oldPos.x;
      this.correctionOffset.y += newPos.y - oldPos.y;
      this.correctionOffset.z += newPos.z - oldPos.z;
    }
    this.state = replayed;
    this.lastShots = replayedShots;
    return diff;
  }

  private getRenderPositionForState(state: SimState): Vec3 {
    return { x: state.posX[this.localIndex]!, y: state.posY[this.localIndex]!, z: state.posZ[this.localIndex]! };
  }
}
