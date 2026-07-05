import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ASSIST_WINDOW_TICKS,
  DROP_DESPAWN_TICKS,
  FIXED_DT,
  KILL_REWARD,
  LEVEL_BOXES,
  MAX_CREDITS,
  MAX_DROPPED_WEAPONS,
  MAX_PLAYERS,
  NO_PLAYER,
  PHASE_BUY,
  PHASE_MATCH_END,
  PHASE_ROUND,
  PHASE_ROUND_END,
  PHASE_WAITING,
  PICKUP_RADIUS_M,
  SPIKE_DEFUSED,
  SPIKE_DETONATED,
  SPIKE_PLANTED,
  TEAM_ATTACKERS,
  TEAM_DEFENDERS,
  TEAM_NONE,
  WEAPON_NONE,
  applyBuy,
  applyDamage,
  applySell,
  applyTag,
  clamp,
  clearPrimaryWeapon,
  createMatchState,
  createState,
  damageForHit,
  eyePosition,
  getWeaponDef,
  pickupWeapon,
  raycastBoxes,
  raycastPlayers,
  shotDirection,
  spawnForIndex,
  startMatch,
  tick,
  type Box,
  type InputFrame,
  type MatchConfig,
  type ShotEvent,
  type SimState,
} from "@vg/sim";
import {
  MessageType,
  NO_TOKEN,
  PROTOCOL_VERSION,
  TOKEN_LENGTH,
  decodeMessageSafely,
  encodeMessage,
  type BuyCmdMessage,
  type DamageTakenMessage,
  type HitConfirmMessage,
  type InputSample,
  type KillEventMessage,
  type MapPingMessage,
  type MatchEventMessage,
  type SellCmdMessage,
  type SnapshotDroppedWeapon,
  type SnapshotMessage,
  type SnapshotPlayer,
  type TeamPingMessage,
  type Transport,
} from "@vg/protocol";
import { JitterBuffer, type JitterBufferStats } from "./jitterbuffer.js";
import { StateRingBuffer } from "./ringbuffer.js";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export type ServerMode = "dm" | "match";

export interface ServerHostOptions {
  seed?: number;
  /** Fixed match capacity (slots), not "currently connected". Defaults to MAX_PLAYERS. */
  numPlayers?: number;
  /** Defaults to `process.env.LAGCOMP !== "off"` (true unless explicitly disabled). */
  lagComp?: boolean;
  /** Broadcast a full snapshot every Nth tick. Defaults to 2 (32 Hz @ 64 Hz sim). */
  snapshotEveryNTicks?: number;
  /** Hitscan max range, world units. */
  fireMaxRange?: number;
  boxes?: readonly Box[];
  /** "dm" (M2 behavior, default — keeps existing tests/offline mode working) or "match" (M3 round structure). */
  mode?: ServerMode;
  /** Match mode only: number of connected players required before startMatch() fires. Defaults to 2. */
  minPlayers?: number;
  /** Match mode only: overrides for @vg/sim's MatchConfig (tests shrink timers/winTarget). */
  matchConfig?: Partial<MatchConfig>;
  /** Match mode only: wall-clock ms a disconnected slot is held before it frees for new joins. Defaults to 90_000. */
  reconnectHoldMs?: number;
}

interface ClientRecord {
  transport: Transport;
  playerIndex: number;
  jitter: JitterBuffer<InputSample>;
  /** The client's most recently received InputBatch.viewTick, used to lag-comp rewind that client's own shots. */
  lastViewTick: number;
  /** Rate limit state for MapPing (match mode only): tick of this player's last accepted ping. */
  lastPingTick: number;
}

/** A hit registered this step, exposed for tests/telemetry in addition to the wire broadcast. */
export interface HitRecord {
  shooterIndex: number;
  targetIndex: number;
  serverTick: number;
  damage: number;
  region: number;
  weaponId: number;
}

export interface KillRecord {
  killerIndex: number;
  victimIndex: number;
  weaponId: number;
  headshot: boolean;
  assistIndex: number;
  serverTick: number;
}

interface DroppedWeaponEntity {
  id: number;
  weaponId: number;
  x: number;
  y: number;
  z: number;
  mag: number;
  spawnTick: number;
}

interface HeldSlot {
  token: Uint8Array;
  /** Wall-clock ms (nowMs()) after which this slot is freed for new joins. */
  freeAt: number;
}

const FIRE_VIEW_TICK_MAX_AGE = 13; // ~200 ms at 64 Hz, per spec
const RING_BUFFER_CAPACITY = 64; // 1 s at 64 Hz
const VISIBILITY_EVERY_N_TICKS = 4;
const VISIBILITY_HALF_FOV_RAD = ((110 / 2) * Math.PI) / 180; // 110 deg total FOV cone
const MAP_PING_RATE_LIMIT_TICKS = 64; // 1/s @ 64Hz

function isZeroToken(token: Uint8Array): boolean {
  for (let i = 0; i < token.length; i++) if (token[i] !== 0) return false;
  return true;
}

/** Constant-time compare (optional hardening — session tokens shouldn't leak match-length via response timing). */
function tokensEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function generateToken(): Uint8Array {
  return new Uint8Array(randomBytes(TOKEN_LENGTH));
}

/**
 * The authoritative 64 Hz server: owns the shared SimState, per-client jitter
 * buffers, a lag-comp ring buffer, dropped-weapon world entities, and
 * snapshot broadcast. Constructible in-process against any `Transport` pair
 * (no real socket required), so it can be driven directly by tests and by
 * in-process bots.
 *
 * Combat mutation boundary (documented, see @vg/sim damage.ts): tick()
 * itself only decides WHETHER a shot happens (pure sim); this class resolves
 * each returned ShotEvent with lag-compensated raycasting and applies
 * damage/tag/buy/pickup between ticks via sim's pure applyDamage/applyTag/
 * applyBuy/clearPrimaryWeapon/pickupWeapon helpers. The client never applies
 * damage locally.
 *
 * M3: the ENTIRE round/spike/economy state machine lives in @vg/sim's tick()
 * (mode === MODE_MATCH) — this class stays a thin shell: it starts the match
 * once enough players connect, applies friendly-fire exclusion + buy-phase
 * gating, computes team visibility for the minimap, rate-limits/rebroadcasts
 * pings, diffs matchPhase/spikeState pre/post tick() to emit MatchEvents,
 * and holds a disconnected slot for reconnectHoldMs instead of freeing it.
 */
export class ServerHost {
  private state: SimState;
  private readonly boxes: readonly Box[];
  private readonly ring = new StateRingBuffer(RING_BUFFER_CAPACITY);
  private readonly clients = new Map<number, ClientRecord>();
  private readonly numPlayers: number;
  private readonly seed: number;
  private readonly lagComp: boolean;
  private readonly snapshotEvery: number;
  private readonly fireMaxRange: number;
  private readonly mode: ServerMode;
  private readonly minPlayers: number;
  private readonly reconnectHoldMs: number;
  private readonly hits: HitRecord[] = [];
  private readonly kills: KillRecord[] = [];
  private readonly allShots: ShotEvent[] = [];
  private readonly lastDamager = new Map<number, { attackerIndex: number; tick: number }>();
  private readonly drops: DroppedWeaponEntity[] = [];
  private nextDropId = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  // ---- M3 reconnect ----
  private readonly slotTokens = new Map<number, Uint8Array>(); // playerIndex -> current token (match mode only)
  private readonly heldSlots = new Map<number, HeldSlot>(); // playerIndex -> hold record while disconnected

  // ---- M3 visibility (team-shared fog of war for the minimap) ----
  /** visibilityMasks[team] = bitmask of ENEMY player indices currently visible to that team. */
  private visibilityMasks: [number, number] = [0, 0];

  // ---- M3 match events (diffed pre/post tick()) ----
  private readonly pendingMatchEvents: MatchEventMessage[] = [];

  /**
   * Per-player edge-gate for walk-over pickup: the id of the drop this
   * player was standing inside PICKUP_RADIUS_M of on the *previous*
   * updatePickups() call, or null if none. A drop's id survives a swap (only
   * its weaponId/mag/spawnTick change), so a player who just swapped stays
   * "on" the same id afterward and won't re-trigger — they must leave the
   * radius (any drop found there resets to null) and re-enter before that
   * id can fire again. Without this, standing still on a drop while holding
   * a different weapon oscillates the swap every single tick.
   */
  private readonly lastOverlappingDropId: (number | null)[];

  /** p95-friendly per-tick timing samples (wall-clock ms spent inside step()), for the soak test. */
  readonly stepDurationsMs: number[] = [];

  /** Count of frames dropped at the decode boundary (unknown tag, truncated, etc.) — see handleMessage(). */
  private malformedFrameCount = 0;

  constructor(opts: ServerHostOptions = {}) {
    this.numPlayers = opts.numPlayers ?? MAX_PLAYERS;
    this.seed = opts.seed ?? 1;
    this.boxes = opts.boxes ?? LEVEL_BOXES;
    this.lagComp = opts.lagComp ?? (typeof process !== "undefined" ? process.env["LAGCOMP"] !== "off" : true);
    this.snapshotEvery = opts.snapshotEveryNTicks ?? 2;
    this.fireMaxRange = opts.fireMaxRange ?? 100;
    this.mode = opts.mode ?? "dm";
    this.minPlayers = opts.minPlayers ?? 2;
    this.reconnectHoldMs = opts.reconnectHoldMs ?? 90_000;

    if (this.mode === "match") {
      this.state = createMatchState(this.seed, this.numPlayers, opts.matchConfig ?? {});
    } else {
      this.state = createState(this.seed, this.numPlayers);
      for (let i = 0; i < this.numPlayers; i++) {
        const spawn = spawnForIndex(i);
        this.state.posX[i] = spawn.x;
        this.state.posY[i] = spawn.y;
        this.state.posZ[i] = spawn.z;
      }
    }
    this.ring.push(this.state);
    this.lastOverlappingDropId = new Array(this.numPlayers).fill(null);
  }

  getState(): SimState {
    return this.state;
  }

  getSeed(): number {
    return this.seed;
  }

  getNumPlayers(): number {
    return this.numPlayers;
  }

  getMode(): ServerMode {
    return this.mode;
  }

  isConnected(playerIndex: number): boolean {
    return this.clients.has(playerIndex);
  }

  /** Exposed for tests/telemetry (acceptance criterion 6: jitter buffer behavior). */
  getJitterStats(playerIndex: number, sinceTick = 0): JitterBufferStats | null {
    const record = this.clients.get(playerIndex);
    return record ? record.jitter.stats(sinceTick) : null;
  }

  connectedCount(): number {
    return this.clients.size;
  }

  /** Hits registered so far (for tests/telemetry); also broadcast on the wire as HitConfirm/DamageTaken. */
  getHits(): readonly HitRecord[] {
    return this.hits;
  }

  /** Kills registered so far (for tests/telemetry); also broadcast on the wire as KillEvent. */
  getKills(): readonly KillRecord[] {
    return this.kills;
  }

  /** Live dropped-weapon world entities (for tests/telemetry); also mirrored into every Snapshot. */
  getDrops(): readonly DroppedWeaponEntity[] {
    return this.drops;
  }

  /** Count of frames dropped for failing to decode (unknown tag, truncated, empty, ...). */
  getMalformedFrameCount(): number {
    return this.malformedFrameCount;
  }

  /** All ShotEvents ever returned by tick() (for tests: matching a client-predicted shot to its authoritative counterpart by shotIndex). */
  getAllShots(): readonly ShotEvent[] {
    return this.allShots;
  }

  /** Current session token for a connected slot (match mode), or null. Exposed for reconnect tests. */
  getToken(playerIndex: number): Uint8Array | null {
    return this.slotTokens.get(playerIndex) ?? null;
  }

  /** Team-shared visibility mask (bit i = enemy player i visible) for `team` (0/1). Exposed for tests/telemetry. */
  getVisibilityMask(team: number): number {
    return team === 0 || team === 1 ? this.visibilityMasks[team]! : 0;
  }

  private expireHeldSlots(): void {
    if (this.heldSlots.size === 0) return;
    const now = nowMs();
    for (const [index, held] of Array.from(this.heldSlots.entries())) {
      if (now >= held.freeAt) {
        this.heldSlots.delete(index);
        this.slotTokens.delete(index);
      }
    }
  }

  private findFreeSlot(): number {
    for (let i = 0; i < this.numPlayers; i++) {
      if (this.clients.has(i)) continue;
      if (this.heldSlots.has(i)) continue; // reserved for a possible reconnect
      return i;
    }
    return -1;
  }

  /**
   * Assigns the lowest free player slot to `transport`, sends Welcome, wires
   * up message handling. Returns the assigned index.
   *
   * Match mode, no free slot: rather than throwing (a genuinely full match
   * would incorrectly reject a legitimate reconnect), the transport is
   * registered PENDING and this returns -1 — see awaitReconnectOrReject().
   * The caller learns the outcome from the Welcome message (success) or the
   * connection closing (rejected): a full match with no free slot only
   * ever accepts a NEW connection here if it turns out, once its first
   * Hello arrives, to be a valid reconnect for a currently-held slot.
   */
  connect(transport: Transport): number {
    this.expireHeldSlots();
    const index = this.findFreeSlot();
    if (index === -1) {
      if (this.mode === "match") {
        this.awaitReconnectOrReject(transport);
        return -1;
      }
      throw new Error("ServerHost.connect: no free player slots");
    }

    if (this.mode === "dm") {
      const spawn = spawnForIndex(index);
      this.state.posX[index] = spawn.x;
      this.state.posY[index] = spawn.y;
      this.state.posZ[index] = spawn.z;
      this.state.velX[index] = 0;
      this.state.velY[index] = 0;
      this.state.velZ[index] = 0;
    }

    const record: ClientRecord = {
      transport,
      playerIndex: index,
      jitter: new JitterBuffer<InputSample>(1, 3, 2),
      lastViewTick: 0,
      lastPingTick: -MAP_PING_RATE_LIMIT_TICKS,
    };
    this.clients.set(index, record);

    let token = NO_TOKEN;
    if (this.mode === "match") {
      token = generateToken();
      this.slotTokens.set(index, token);
    }

    transport.onMessage((data) => this.handleMessage(record, data));
    transport.onClose(() => this.disconnect(index));

    // Start the match (team assignment happens inside startMatch()) BEFORE
    // sending Welcome, so the player whose join tips connectedCount() over
    // minPlayers sees their own real team immediately rather than TEAM_NONE.
    // Every OTHER already-connected client had its Welcome sent before this
    // point (with team still TEAM_NONE, since teams weren't assigned yet) —
    // resend theirs now too, so no one is left waiting on the next Snapshot
    // to learn which side they're on.
    if (this.mode === "match" && this.state.matchPhase === PHASE_WAITING && this.connectedCount() >= this.minPlayers) {
      this.state = startMatch(this.state);
      this.ring.push(this.state);
      for (const [otherIndex, otherRecord] of this.clients) {
        if (otherIndex === index) continue;
        otherRecord.transport.send(
          encodeMessage({
            type: MessageType.Welcome,
            playerIndex: otherIndex,
            seed: this.seed,
            numPlayers: this.numPlayers,
            serverTick: this.state.tick,
            token: this.slotTokens.get(otherIndex) ?? NO_TOKEN,
            team: this.state.team[otherIndex] ?? TEAM_NONE,
            mode: this.state.mode,
          }),
        );
      }
    }

    transport.send(
      encodeMessage({
        type: MessageType.Welcome,
        playerIndex: index,
        seed: this.seed,
        numPlayers: this.numPlayers,
        serverTick: this.state.tick,
        token,
        team: this.state.team[index] ?? TEAM_NONE,
        mode: this.state.mode,
      }),
    );

    return index;
  }

  /**
   * DM mode: frees the slot immediately (M2 behavior — no reconnect grace).
   * Match mode: holds the slot (marks it un-joinable by new clients, but
   * doesn't touch its row in SimState — the player just sits frozen,
   * matching a disconnected-but-still-alive-in-the-round player) for
   * `reconnectHoldMs` of wall-clock time, then frees it. A matching Hello
   * token arriving within that window reattaches via handleMessage's Hello
   * branch (see tryReattach()) rather than through connect().
   */
  disconnect(playerIndex: number): void {
    if (this.mode === "match") {
      const token = this.slotTokens.get(playerIndex);
      this.clients.delete(playerIndex);
      if (token) {
        this.heldSlots.set(playerIndex, { token, freeAt: nowMs() + this.reconnectHoldMs });
      }
    } else {
      this.clients.delete(playerIndex);
    }
  }

  /**
   * Reattaches `record`'s transport to a held slot matching `token`, if any.
   * The transport had already been given a FRESH slot by connect() (the
   * simplest way to keep connect()'s synchronous return-an-index contract
   * intact) — on a successful reattach, that fresh slot is released back to
   * the pool and a second Welcome is sent for the correct (held) slot/token.
   * No-op if no held slot matches (client keeps its freshly-assigned slot).
   */
  private tryReattach(record: ClientRecord, token: Uint8Array): void {
    this.expireHeldSlots();
    let matchedIndex = -1;
    for (const [index, held] of this.heldSlots) {
      if (tokensEqual(held.token, token)) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex === -1 || matchedIndex === record.playerIndex) return;

    const staleIndex = record.playerIndex;
    this.clients.delete(staleIndex);
    this.slotTokens.delete(staleIndex);

    this.heldSlots.delete(matchedIndex);
    record.playerIndex = matchedIndex;
    record.jitter = new JitterBuffer<InputSample>(1, 3, 2);
    record.lastViewTick = this.state.tick;
    this.clients.set(matchedIndex, record);
    this.slotTokens.set(matchedIndex, token);

    record.transport.send(
      encodeMessage({
        type: MessageType.Welcome,
        playerIndex: matchedIndex,
        seed: this.seed,
        numPlayers: this.numPlayers,
        serverTick: this.state.tick,
        token,
        team: this.state.team[matchedIndex] ?? TEAM_NONE,
        mode: this.state.mode,
      }),
    );
  }

  /**
   * Match mode, no free slot at connect() time: waits for this transport's
   * first Hello to decide the outcome, without ever occupying a slot.
   * A Hello carrying a token that matches a currently-held slot reattaches
   * to it directly (no throwaway slot ever created — this is what makes
   * reconnect work on a genuinely full match). Anything else (no token, a
   * wrong/expired token, a version mismatch, or the connection being closed
   * before any Hello arrives) rejects the connection — a full match can't
   * admit a brand-new player. Any non-Hello message that arrives first is
   * ignored (a well-behaved client always sends Hello first); malformed
   * frames are dropped as usual.
   */
  private awaitReconnectOrReject(transport: Transport): void {
    let settled = false;
    transport.onMessage((data) => {
      if (settled) return;
      const msg = decodeMessageSafely(data);
      if (msg === null) return;
      if (msg.type !== MessageType.Hello) return;
      settled = true;

      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        transport.close();
        return;
      }
      if (isZeroToken(msg.reconnectToken)) {
        transport.close(); // full, and this is a fresh join attempt: reject
        return;
      }
      this.expireHeldSlots();
      let matchedIndex = -1;
      for (const [index, held] of this.heldSlots) {
        if (tokensEqual(held.token, msg.reconnectToken)) {
          matchedIndex = index;
          break;
        }
      }
      if (matchedIndex === -1) {
        transport.close(); // wrong/expired token, and full: reject
        return;
      }

      this.heldSlots.delete(matchedIndex);
      const token = msg.reconnectToken;
      const record: ClientRecord = {
        transport,
        playerIndex: matchedIndex,
        jitter: new JitterBuffer<InputSample>(1, 3, 2),
        lastViewTick: this.state.tick,
        lastPingTick: -MAP_PING_RATE_LIMIT_TICKS,
      };
      this.clients.set(matchedIndex, record);
      this.slotTokens.set(matchedIndex, token);
      transport.onMessage((data2) => this.handleMessage(record, data2));
      transport.onClose(() => this.disconnect(matchedIndex));
      transport.send(
        encodeMessage({
          type: MessageType.Welcome,
          playerIndex: matchedIndex,
          seed: this.seed,
          numPlayers: this.numPlayers,
          serverTick: this.state.tick,
          token,
          team: this.state.team[matchedIndex] ?? TEAM_NONE,
          mode: this.state.mode,
        }),
      );
    });
  }

  private handleMessage(record: ClientRecord, data: Uint8Array): void {
    // A single malformed/truncated/unknown-tag frame from one client must
    // never take down the whole process (or even just that client's
    // connection) — decodeMessageSafely() never throws, it returns null.
    const msg = decodeMessageSafely(data);
    if (msg === null) {
      this.malformedFrameCount++;
      return;
    }
    if (msg.type === MessageType.InputBatch) {
      for (let i = 0; i < msg.frames.length; i++) {
        record.jitter.arrive(msg.firstSeq + i, msg.frames[i]!);
      }
      record.lastViewTick = msg.viewTick;
    } else if (msg.type === MessageType.BuyCmd) {
      this.handleBuy(record.playerIndex, msg);
    } else if (msg.type === MessageType.SellCmd) {
      this.handleSell(record.playerIndex, msg);
    } else if (msg.type === MessageType.MapPing) {
      this.handleMapPing(record.playerIndex, msg);
    } else if (msg.type === MessageType.Hello) {
      // Welcome is already sent unconditionally at connect() (before any
      // Hello could arrive), so this can't prevent that — but an incompatible
      // client announcing itself is still a real signal we shouldn't ignore:
      // drop the connection outright rather than let a stale/future client
      // silently desync against messages it can't correctly decode.
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        record.transport.close();
        return;
      }
      if (this.mode === "match" && !isZeroToken(msg.reconnectToken)) {
        this.tryReattach(record, msg.reconnectToken);
      }
    }
    // Other message types: no-op server-side.
  }

  private handleBuy(playerIndex: number, msg: BuyCmdMessage): void {
    if (!this.canBuyOrSellNow()) return;
    // applyBuy() itself no-ops (returns state unchanged) for a dead player,
    // insufficient credits, or an unknown itemId — this call is always safe.
    if (this.state.alive[playerIndex] === 0) return;
    this.state = applyBuy(this.state, playerIndex, msg.itemId);
  }

  private handleSell(playerIndex: number, msg: SellCmdMessage): void {
    if (!this.canBuyOrSellNow()) return;
    if (this.state.alive[playerIndex] === 0) return;
    this.state = applySell(this.state, playerIndex, msg.itemId);
  }

  /** DM: buy/sell allowed anytime (M2 behavior). Match: only during the buy phase. */
  private canBuyOrSellNow(): boolean {
    if (this.mode === "dm") return true;
    return this.state.matchPhase === PHASE_BUY;
  }

  private handleMapPing(playerIndex: number, msg: MapPingMessage): void {
    if (this.mode !== "match") return;
    const record = this.clients.get(playerIndex);
    if (!record) return;
    if (this.state.tick - record.lastPingTick < MAP_PING_RATE_LIMIT_TICKS) return; // rate-limited
    record.lastPingTick = this.state.tick;

    const team = this.state.team[playerIndex];
    const teamPing: TeamPingMessage = { type: MessageType.TeamPing, playerIndex, x: msg.x, z: msg.z };
    const encoded = encodeMessage(teamPing);
    for (const [otherIndex, otherRecord] of this.clients) {
      if (this.state.team[otherIndex] === team) otherRecord.transport.send(encoded);
    }
  }

  /** Advances the authoritative sim by exactly one 15.625 ms tick. */
  step(): void {
    const startedAt = nowMs();

    const inputs: (InputFrame | undefined)[] = new Array(this.numPlayers);
    for (const [index, record] of this.clients) {
      const { value } = record.jitter.consume();
      if (value) {
        inputs[index] = {
          forward: value.forward,
          right: value.right,
          yaw: value.yaw,
          pitch: value.pitch,
          jump: value.jump,
          crouch: value.crouch,
          walk: value.walk,
          fire: value.fire,
          ads: value.ads,
          reload: value.reload,
          slot1: value.slot1,
          slot2: value.slot2,
          interact: value.interact,
          ping: value.ping,
        };
      }
    }

    const prevPhase = this.state.matchPhase;
    const prevSpike = this.state.spikeState;
    const prevRound = this.state.roundNumber;

    // tick() tolerates missing entries for unconnected slots (see tick.ts's
    // `if (!input) continue`); the declared parameter type doesn't spell
    // that out, hence the cast.
    const result = tick(this.state, inputs as readonly InputFrame[], this.boxes);
    this.state = result.state;
    this.ring.push(this.state);

    for (const shot of result.shots) {
      this.allShots.push(shot);
      this.resolveShot(shot);
    }

    this.updatePickups();
    this.despawnOldDrops();

    if (this.mode === "match") {
      this.diffMatchEvents(prevPhase, prevSpike, prevRound);
      if (prevPhase !== PHASE_BUY && this.state.matchPhase === PHASE_BUY) {
        this.drops.length = 0; // drops cleared at round reset (spec)
      }
      if (this.state.tick % VISIBILITY_EVERY_N_TICKS === 0) {
        this.updateVisibility();
      }
    }

    if (this.state.tick % this.snapshotEvery === 0) {
      this.broadcastSnapshot();
    }
    this.broadcastPendingMatchEvents();

    this.stepDurationsMs.push(nowMs() - startedAt);
  }

  private diffMatchEvents(prevPhase: number, prevSpike: number, prevRound: number): void {
    const s = this.state;
    if (prevPhase !== PHASE_ROUND && s.matchPhase === PHASE_ROUND) {
      this.pendingMatchEvents.push({ type: MessageType.MatchEvent, kind: 0, winnerTeam: NO_PLAYER, reason: NO_PLAYER, roundNumber: s.roundNumber });
    }
    if (prevPhase !== PHASE_ROUND_END && s.matchPhase === PHASE_ROUND_END) {
      this.pendingMatchEvents.push({
        type: MessageType.MatchEvent,
        kind: 1,
        winnerTeam: s.lastRoundWinnerTeam,
        reason: s.lastRoundEndReason,
        roundNumber: prevRound,
      });
    }
    if (prevPhase !== PHASE_MATCH_END && s.matchPhase === PHASE_MATCH_END) {
      this.pendingMatchEvents.push({
        type: MessageType.MatchEvent,
        kind: 2,
        winnerTeam: s.lastRoundWinnerTeam,
        reason: s.lastRoundEndReason,
        roundNumber: prevRound,
      });
    }
    if (prevSpike !== SPIKE_PLANTED && s.spikeState === SPIKE_PLANTED) {
      this.pendingMatchEvents.push({ type: MessageType.MatchEvent, kind: 3, winnerTeam: NO_PLAYER, reason: NO_PLAYER, roundNumber: s.roundNumber });
    }
    if (prevSpike !== SPIKE_DEFUSED && s.spikeState === SPIKE_DEFUSED) {
      this.pendingMatchEvents.push({ type: MessageType.MatchEvent, kind: 4, winnerTeam: NO_PLAYER, reason: NO_PLAYER, roundNumber: s.roundNumber });
    }
    if (prevSpike !== SPIKE_DETONATED && s.spikeState === SPIKE_DETONATED) {
      this.pendingMatchEvents.push({ type: MessageType.MatchEvent, kind: 5, winnerTeam: NO_PLAYER, reason: NO_PLAYER, roundNumber: s.roundNumber });
    }
  }

  private broadcastPendingMatchEvents(): void {
    if (this.pendingMatchEvents.length === 0) return;
    for (const evt of this.pendingMatchEvents) {
      const encoded = encodeMessage(evt);
      for (const [, client] of this.clients) client.transport.send(encoded);
    }
    this.pendingMatchEvents.length = 0;
  }

  /**
   * Team-shared visibility (minimap fog of war): for each team, an enemy is
   * visible if ANY living member of that team has an unobstructed raycast
   * to the enemy's eye position AND the enemy falls within a 110-degree cone
   * centered on that member's yaw. Deliberately amortized (every 4 ticks,
   * not every tick) and O(numPlayers^2) — fine at MAX_PLAYERS=16. Full
   * snapshot interest-culling/anti-wallhack is explicitly DEFERRED (see
   * PLAN.md §3.2) — this only feeds the minimap, not what raw combat state
   * a client's own SimState mirror actually contains.
   */
  private updateVisibility(): void {
    const s = this.state;
    let team0Mask = 0; // attackers' view of defenders
    let team1Mask = 0; // defenders' view of attackers

    for (let e = 0; e < this.numPlayers; e++) {
      if (s.alive[e] === 0) continue;
      const enemyTeam = s.team[e];
      if (enemyTeam !== TEAM_ATTACKERS && enemyTeam !== TEAM_DEFENDERS) continue;
      const viewerTeam = enemyTeam === TEAM_ATTACKERS ? TEAM_DEFENDERS : TEAM_ATTACKERS;

      let visible = false;
      for (let m = 0; m < this.numPlayers; m++) {
        if (s.alive[m] === 0 || s.team[m] !== viewerTeam) continue;
        const eyeM = eyePosition(s, m);
        const eyeE = eyePosition(s, e);
        const dx = eyeE.x - eyeM.x;
        const dy = eyeE.y - eyeM.y;
        const dz = eyeE.z - eyeM.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1e-6) {
          visible = true;
          break;
        }
        const dirX = dx / dist;
        const dirZ = dz / dist;
        const toEnemyYaw = Math.atan2(dirX, dirZ); // matches movement.ts's yaw convention (0 = +Z)
        let diff = toEnemyYaw - s.yaw[m]!;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) > VISIBILITY_HALF_FOV_RAD) continue;

        const blocked = raycastBoxes(this.boxes, eyeM, { x: dx / dist, y: dy / dist, z: dz / dist }, dist);
        if (blocked === null) {
          visible = true;
          break;
        }
      }

      if (visible) {
        if (viewerTeam === TEAM_ATTACKERS) team0Mask |= 1 << e;
        else team1Mask |= 1 << e;
      }
    }

    this.visibilityMasks = [team0Mask, team1Mask];
  }

  private resolveShot(shot: ShotEvent): void {
    // Belt-and-braces (reviewer fix, M3 follow-up): sim's stepWeaponLogic
    // already refuses to emit a ShotEvent at all outside PHASE_ROUND in
    // match mode (see @vg/sim weapons/logic.ts canFireThisPhase), so this
    // should never actually trigger — kept as a cheap, redundant guard so a
    // future sim regression can't reintroduce buy/roundEnd kills here too.
    if (this.mode === "match" && this.state.matchPhase !== PHASE_ROUND) return;

    const weapon = getWeaponDef(shot.weaponId);
    if (!weapon) return;

    const shooterIndex = shot.playerIndex;
    const currentTick = this.state.tick;
    const record = this.clients.get(shooterIndex);
    const rawViewTick = record?.lastViewTick ?? currentTick;
    const clampedViewTick = clamp(rawViewTick, Math.max(0, currentTick - FIRE_VIEW_TICK_MAX_AGE), currentTick);

    // Current-state shooter eye/view (spec): the shooter's own position is
    // never rewound, only the targets are (lag comp rewinds what the
    // *shooter* would have seen of *everyone else* at their view tick).
    const origin = eyePosition(this.state, shooterIndex);
    const dir = shotDirection(this.state, shooterIndex, weapon, shot.shotIndex, shot.sprayIndex);

    const targetState = this.lagComp ? (this.ring.get(clampedViewTick) ?? this.state) : this.state;

    // M3: friendly fire is off in match mode — raycastPlayers skips
    // teammates entirely (never a hit, never a blocker) so a teammate
    // standing in the shot's path doesn't even absorb it.
    const hit = raycastPlayers(targetState, shooterIndex, origin, dir, this.fireMaxRange, this.mode === "match");
    if (!hit) return;

    const wallDist = raycastBoxes(this.boxes, origin, dir, hit.dist);
    if (wallDist !== null) return; // a wall blocks the shot before it reaches the target

    const damage = damageForHit(weapon, hit.dist, hit.region);
    const targetIndex = hit.playerIndex;
    const wasAlive = this.state.alive[targetIndex] === 1;

    this.state = applyDamage(this.state, targetIndex, damage);
    this.state = applyTag(this.state, targetIndex);

    const healthAfter = this.state.health[targetIndex]!;
    const regionCode = hit.region === "head" ? 0 : hit.region === "body" ? 1 : 2;

    this.hits.push({ shooterIndex, targetIndex, serverTick: currentTick, damage, region: regionCode, weaponId: shot.weaponId });

    const hitConfirm: HitConfirmMessage = {
      type: MessageType.HitConfirm,
      shooterIndex,
      targetIndex,
      damage,
      region: regionCode,
      targetHealthAfter: healthAfter,
    };
    this.clients.get(shooterIndex)?.transport.send(encodeMessage(hitConfirm));

    const damageTaken: DamageTakenMessage = { type: MessageType.DamageTaken, victimIndex: targetIndex, attackerIndex: shooterIndex, damage };
    this.clients.get(targetIndex)?.transport.send(encodeMessage(damageTaken));

    const nowDead = wasAlive && this.state.alive[targetIndex] === 0;
    const priorDamager = this.lastDamager.get(targetIndex);
    let assistIndex = 255;
    if (priorDamager && priorDamager.attackerIndex !== shooterIndex && currentTick - priorDamager.tick <= ASSIST_WINDOW_TICKS) {
      assistIndex = priorDamager.attackerIndex;
    }
    this.lastDamager.set(targetIndex, { attackerIndex: shooterIndex, tick: currentTick });

    if (nowDead) {
      this.handleKill(shooterIndex, targetIndex, shot.weaponId, hit.region === "head", assistIndex, currentTick);
    }
  }

  private handleKill(killerIndex: number, victimIndex: number, weaponId: number, headshot: boolean, assistIndex: number, currentTick: number): void {
    // Kill reward, capped. Match mode: kill credits still apply (spec: "Kill
    // credits ... work in match mode"); no-respawn is handled entirely
    // inside sim's scheduleDeath (see @vg/sim weapons/logic.ts).
    this.state.credits[killerIndex] = Math.min(MAX_CREDITS, this.state.credits[killerIndex]! + KILL_REWARD);

    // Drop the victim's primary weapon (if any) at the death spot, then clear it from their loadout.
    const primaryId = this.state.weaponPrimary[victimIndex]!;
    if (primaryId !== WEAPON_NONE) {
      this.spawnDrop(
        primaryId,
        this.state.posX[victimIndex]!,
        this.state.posY[victimIndex]!,
        this.state.posZ[victimIndex]!,
        this.state.magPrimary[victimIndex]!,
        currentTick,
      );
      this.state = clearPrimaryWeapon(this.state, victimIndex);
    }

    const record: KillRecord = { killerIndex, victimIndex, weaponId, headshot, assistIndex, serverTick: currentTick };
    this.kills.push(record);

    const msg: KillEventMessage = { type: MessageType.KillEvent, killerIndex, victimIndex, weaponId, headshot, assistIndex };
    const encoded = encodeMessage(msg);
    for (const [, client] of this.clients) client.transport.send(encoded);
  }

  private spawnDrop(weaponId: number, x: number, y: number, z: number, mag: number, currentTick: number): void {
    if (this.drops.length >= MAX_DROPPED_WEAPONS) {
      // Oldest despawns to make room.
      this.drops.sort((a, b) => a.spawnTick - b.spawnTick);
      this.drops.shift();
    }
    this.drops.push({ id: this.nextDropId, weaponId, x, y, z, mag, spawnTick: currentTick });
    this.nextDropId = (this.nextDropId + 1) & 0xff;
  }

  private despawnOldDrops(): void {
    const currentTick = this.state.tick;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      if (currentTick - this.drops[i]!.spawnTick >= DROP_DESPAWN_TICKS) {
        this.drops.splice(i, 1);
      }
    }
  }

  /**
   * Walk-over pickup: alive players within PICKUP_RADIUS_M of a drop swap it
   * for their current primary (if any). Edge-gated per player via
   * lastOverlappingDropId (see its doc comment) so standing still on a drop
   * swaps exactly once, not every tick.
   */
  private updatePickups(): void {
    for (let i = 0; i < this.numPlayers; i++) {
      if (this.state.alive[i] === 0) {
        this.lastOverlappingDropId[i] = null;
        continue;
      }

      let overlapping: DroppedWeaponEntity | null = null;
      for (const drop of this.drops) {
        const dx = this.state.posX[i]! - drop.x;
        const dz = this.state.posZ[i]! - drop.z;
        if (Math.hypot(dx, dz) <= PICKUP_RADIUS_M) {
          overlapping = drop;
          break;
        }
      }

      if (!overlapping) {
        this.lastOverlappingDropId[i] = null;
        continue;
      }
      if (this.lastOverlappingDropId[i] === overlapping.id) {
        continue; // still on the same drop id since the last time it fired — must leave and re-enter
      }

      const currentPrimary = this.state.weaponPrimary[i]!;
      const currentMag = this.state.magPrimary[i]!;
      this.state = pickupWeapon(this.state, i, overlapping.weaponId, overlapping.mag);

      if (currentPrimary !== WEAPON_NONE) {
        // The drop entity now holds the player's previously-equipped weapon,
        // keeping the same id — the gate above stops this player from
        // re-triggering on it again until they leave and re-enter.
        overlapping.weaponId = currentPrimary;
        overlapping.mag = currentMag;
        overlapping.spawnTick = this.state.tick;
        this.lastOverlappingDropId[i] = overlapping.id;
      } else {
        const idx = this.drops.indexOf(overlapping);
        if (idx !== -1) this.drops.splice(idx, 1);
        this.lastOverlappingDropId[i] = null;
      }
    }
  }

  private broadcastSnapshot(): void {
    const isMatch = this.mode === "match";
    const players: SnapshotPlayer[] = [];
    for (let i = 0; i < this.numPlayers; i++) {
      const activeSlot = this.state.activeSlot[i]!;
      const magActive = activeSlot === 0 ? this.state.magPrimary[i]! : this.state.magSecondary[i]!;
      const reserveActive = activeSlot === 0 ? this.state.reservePrimary[i]! : this.state.reserveSecondary[i]!;
      const respawnTicksLeft = this.state.alive[i] === 1 ? 0 : Math.max(0, this.state.respawnTick[i]! - this.state.tick);
      players.push({
        posX: this.state.posX[i]!,
        posY: this.state.posY[i]!,
        posZ: this.state.posZ[i]!,
        velX: this.state.velX[i]!,
        velY: this.state.velY[i]!,
        velZ: this.state.velZ[i]!,
        yaw: this.state.yaw[i]!,
        pitch: this.state.pitch[i]!,
        crouching: this.state.crouching[i] === 1,
        grounded: this.state.grounded[i] === 1,
        connected: this.clients.has(i),
        alive: this.state.alive[i] === 1,
        activeSlot,
        adsStage: this.state.adsStage[i]!,
        health: this.state.health[i]!,
        armor: this.state.armor[i]!,
        weaponPrimary: this.state.weaponPrimary[i]!,
        weaponSecondary: this.state.weaponSecondary[i]!,
        magActive,
        reserveActive,
        tagTicksLeft: this.state.tagTicksLeft[i]!,
        credits: this.state.credits[i]!,
        respawnTicksLeft,
        team: this.state.team[i]!,
      });
    }

    const droppedWeapons: SnapshotDroppedWeapon[] = this.drops.map((d) => ({ id: d.id, weaponId: d.weaponId, x: d.x, y: d.y, z: d.z, mag: d.mag }));

    const phaseTicksLeft = isMatch && this.state.phaseEndTick >= 0 ? Math.max(0, this.state.phaseEndTick - this.state.tick) : 0;
    const spikePlantedTicksLeft =
      isMatch && this.state.spikeState === SPIKE_PLANTED
        ? Math.max(0, this.state.spikePlantedTick + this.state.config.spikeTicks - this.state.tick)
        : 0;

    for (const [, record] of this.clients) {
      const recipientTeam = this.state.team[record.playerIndex]!;
      const visibleEnemyMask = isMatch ? this.getVisibilityMask(recipientTeam) : 0;
      const msg: SnapshotMessage = {
        type: MessageType.Snapshot,
        serverTick: this.state.tick,
        lastProcessedSeq: Math.max(0, record.jitter.lastConsumedSeq),
        players,
        droppedWeapons,
        mode: this.state.mode,
        matchPhase: isMatch ? this.state.matchPhase : 0,
        phaseTicksLeft,
        roundNumber: isMatch ? this.state.roundNumber : 0,
        scoreTeam0: isMatch ? this.state.scoreTeam0 : 0,
        scoreTeam1: isMatch ? this.state.scoreTeam1 : 0,
        spikeState: isMatch ? this.state.spikeState : 0,
        spikeCarrier: isMatch ? this.state.spikeCarrier : NO_PLAYER,
        spikeX: isMatch ? this.state.spikeX : 0,
        spikeY: isMatch ? this.state.spikeY : 0,
        spikeZ: isMatch ? this.state.spikeZ : 0,
        spikePlantedTicksLeft,
        activePlantProgress: isMatch ? this.state.plantProgress : 0,
        planterIndex: isMatch ? this.state.planterIndex : NO_PLAYER,
        activeDefuseProgress: isMatch ? this.state.defuseProgress : 0,
        defuserIndex: isMatch ? this.state.defuserIndex : NO_PLAYER,
        visibleEnemyMask,
      };
      record.transport.send(encodeMessage(msg));
    }
  }

  /** Starts the real-time drift-corrected 64 Hz loop (production use; tests call step() directly). */
  start(): void {
    if (this.tickTimer) return;
    const dtMs = FIXED_DT * 1000;
    let last = nowMs();
    let accumulator = 0;
    const MAX_ACCUMULATED_MS = 250; // clamp spiral-of-death after a stall
    this.tickTimer = setInterval(() => {
      const current = nowMs();
      let elapsed = current - last;
      last = current;
      if (elapsed > MAX_ACCUMULATED_MS) elapsed = MAX_ACCUMULATED_MS;
      accumulator += elapsed;
      while (accumulator >= dtMs) {
        this.step();
        accumulator -= dtMs;
      }
    }, dtMs / 2);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
