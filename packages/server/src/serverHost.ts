import {
  ASSIST_WINDOW_TICKS,
  DROP_DESPAWN_TICKS,
  FIXED_DT,
  KILL_REWARD,
  LEVEL_BOXES,
  MAX_CREDITS,
  MAX_DROPPED_WEAPONS,
  MAX_PLAYERS,
  PICKUP_RADIUS_M,
  WEAPON_NONE,
  applyBuy,
  applyDamage,
  applyTag,
  clamp,
  clearPrimaryWeapon,
  createState,
  damageForHit,
  eyePosition,
  getWeaponDef,
  pickupWeapon,
  raycastBoxes,
  raycastPlayers,
  shotDirection,
  spawnForIndex,
  tick,
  type Box,
  type InputFrame,
  type ShotEvent,
  type SimState,
} from "@vg/sim";
import {
  MessageType,
  PROTOCOL_VERSION,
  decodeMessageSafely,
  encodeMessage,
  type BuyCmdMessage,
  type DamageTakenMessage,
  type HitConfirmMessage,
  type InputSample,
  type KillEventMessage,
  type SnapshotDroppedWeapon,
  type SnapshotMessage,
  type SnapshotPlayer,
  type Transport,
} from "@vg/protocol";
import { JitterBuffer, type JitterBufferStats } from "./jitterbuffer.js";
import { StateRingBuffer } from "./ringbuffer.js";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

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
}

interface ClientRecord {
  transport: Transport;
  playerIndex: number;
  jitter: JitterBuffer<InputSample>;
  /** The client's most recently received InputBatch.viewTick, used to lag-comp rewind that client's own shots. */
  lastViewTick: number;
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

const FIRE_VIEW_TICK_MAX_AGE = 13; // ~200 ms at 64 Hz, per spec
const RING_BUFFER_CAPACITY = 64; // 1 s at 64 Hz

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
  private readonly hits: HitRecord[] = [];
  private readonly kills: KillRecord[] = [];
  private readonly allShots: ShotEvent[] = [];
  private readonly lastDamager = new Map<number, { attackerIndex: number; tick: number }>();
  private readonly drops: DroppedWeaponEntity[] = [];
  private nextDropId = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

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

    this.state = createState(this.seed, this.numPlayers);
    for (let i = 0; i < this.numPlayers; i++) {
      const spawn = spawnForIndex(i);
      this.state.posX[i] = spawn.x;
      this.state.posY[i] = spawn.y;
      this.state.posZ[i] = spawn.z;
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

  private findFreeSlot(): number {
    for (let i = 0; i < this.numPlayers; i++) {
      if (!this.clients.has(i)) return i;
    }
    return -1;
  }

  /** Assigns the lowest free player slot to `transport`, sends Welcome, wires up message handling. */
  connect(transport: Transport): number {
    const index = this.findFreeSlot();
    if (index === -1) throw new Error("ServerHost.connect: no free player slots");

    const spawn = spawnForIndex(index);
    this.state.posX[index] = spawn.x;
    this.state.posY[index] = spawn.y;
    this.state.posZ[index] = spawn.z;
    this.state.velX[index] = 0;
    this.state.velY[index] = 0;
    this.state.velZ[index] = 0;

    const record: ClientRecord = {
      transport,
      playerIndex: index,
      jitter: new JitterBuffer<InputSample>(1, 3, 2),
      lastViewTick: 0,
    };
    this.clients.set(index, record);

    transport.onMessage((data) => this.handleMessage(record, data));
    transport.onClose(() => this.disconnect(index));

    transport.send(
      encodeMessage({
        type: MessageType.Welcome,
        playerIndex: index,
        seed: this.seed,
        numPlayers: this.numPlayers,
        serverTick: this.state.tick,
      }),
    );

    return index;
  }

  /**
   * Deviation, stated plainly: disconnected slots free immediately rather
   * than "freeze [for a grace period] then free" — a timed reconnect window
   * is explicitly M3 scope (PLAN.md §2 "Refresh/crash reconnect"), out of
   * scope here. The slot still *freezes* in the sense that once removed it
   * receives no more input and tick() leaves its position untouched, right
   * up until a new client claims the slot.
   */
  disconnect(playerIndex: number): void {
    this.clients.delete(playerIndex);
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
    } else if (msg.type === MessageType.Hello) {
      // Welcome is already sent unconditionally at connect() (before any
      // Hello could arrive), so this can't prevent that — but an incompatible
      // client announcing itself is still a real signal we shouldn't ignore:
      // drop the connection outright rather than let a stale/future client
      // silently desync against messages it can't correctly decode.
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        record.transport.close();
      }
    }
    // Other message types: no-op server-side.
  }

  private handleBuy(playerIndex: number, msg: BuyCmdMessage): void {
    // applyBuy() itself no-ops (returns state unchanged) for a dead player,
    // insufficient credits, or an unknown itemId — this call is always safe.
    if (this.state.alive[playerIndex] === 0) return;
    this.state = applyBuy(this.state, playerIndex, msg.itemId);
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
        };
      }
    }

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

    if (this.state.tick % this.snapshotEvery === 0) {
      this.broadcastSnapshot();
    }

    this.stepDurationsMs.push(nowMs() - startedAt);
  }

  private resolveShot(shot: ShotEvent): void {
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

    const hit = raycastPlayers(targetState, shooterIndex, origin, dir, this.fireMaxRange);
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
    // Kill reward, capped.
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
      });
    }

    const droppedWeapons: SnapshotDroppedWeapon[] = this.drops.map((d) => ({ id: d.id, weaponId: d.weaponId, x: d.x, y: d.y, z: d.z, mag: d.mag }));

    for (const [, record] of this.clients) {
      const msg: SnapshotMessage = {
        type: MessageType.Snapshot,
        serverTick: this.state.tick,
        lastProcessedSeq: Math.max(0, record.jitter.lastConsumedSeq),
        players,
        droppedWeapons,
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
