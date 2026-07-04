import {
  FIXED_DT,
  LEVEL_BOXES,
  MAX_PLAYERS,
  clamp,
  createState,
  eyePosition,
  raycastBoxes,
  raycastPlayers,
  spawnForIndex,
  tick,
  viewDirection,
  type Box,
  type InputFrame,
  type SimState,
} from "@vg/sim";
import {
  MessageType,
  decodeMessageSafely,
  encodeMessage,
  type FireCmdMessage,
  type InputSample,
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
  pendingFireCmds: FireCmdMessage[];
}

/** A hit registered this step, exposed for tests/telemetry in addition to the wire broadcast. */
export interface HitRecord {
  shooterIndex: number;
  targetIndex: number;
  serverTick: number;
}

const FIRE_VIEW_TICK_MAX_AGE = 13; // ~200 ms at 64 Hz, per spec
const RING_BUFFER_CAPACITY = 64; // 1 s at 64 Hz

/**
 * The authoritative 64 Hz server: owns the shared SimState, per-client jitter
 * buffers, a lag-comp ring buffer, and snapshot broadcast. Constructible
 * in-process against any `Transport` pair (no real socket required), so it
 * can be driven directly by tests and by in-process bots.
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
  private tickTimer: ReturnType<typeof setInterval> | null = null;

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

  /** Hits registered so far (for tests/telemetry); also broadcast on the wire as HitEvent. */
  getHits(): readonly HitRecord[] {
    return this.hits;
  }

  /** Count of frames dropped for failing to decode (unknown tag, truncated, empty, ...). */
  getMalformedFrameCount(): number {
    return this.malformedFrameCount;
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
      pendingFireCmds: [],
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
    } else if (msg.type === MessageType.FireCmd) {
      record.pendingFireCmds.push(msg);
    }
    // Hello / other message types: no-op server-side (Welcome already sent on connect).
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
        };
      }
    }

    // tick() tolerates missing entries for unconnected slots (see tick.ts's
    // `if (!input) continue`); the declared parameter type doesn't spell
    // that out, hence the cast.
    this.state = tick(this.state, inputs as readonly InputFrame[], this.boxes);
    this.ring.push(this.state);

    for (const [index, record] of this.clients) {
      if (record.pendingFireCmds.length === 0) continue;
      const fireCmds = record.pendingFireCmds.splice(0, record.pendingFireCmds.length);
      for (const cmd of fireCmds) {
        this.handleFire(index, cmd);
      }
    }

    if (this.state.tick % this.snapshotEvery === 0) {
      this.broadcastSnapshot();
    }

    this.stepDurationsMs.push(nowMs() - startedAt);
  }

  private handleFire(shooterIndex: number, cmd: FireCmdMessage): void {
    const currentTick = this.state.tick;
    const clampedViewTick = clamp(cmd.viewTick, Math.max(0, currentTick - FIRE_VIEW_TICK_MAX_AGE), currentTick);

    const origin = eyePosition(this.state, shooterIndex);
    const dir = viewDirection(this.state.yaw[shooterIndex]!, this.state.pitch[shooterIndex]!);

    const targetState = this.lagComp ? (this.ring.get(clampedViewTick) ?? this.state) : this.state;

    const hit = raycastPlayers(targetState, shooterIndex, origin, dir, this.fireMaxRange);
    if (!hit) return;

    const wallDist = raycastBoxes(this.boxes, origin, dir, hit.dist);
    if (wallDist !== null) return; // a wall blocks the shot before it reaches the target

    const record: HitRecord = { shooterIndex, targetIndex: hit.playerIndex, serverTick: currentTick };
    this.hits.push(record);

    const msg = encodeMessage({
      type: MessageType.HitEvent,
      shooterIndex,
      targetIndex: hit.playerIndex,
      serverTick: currentTick,
    });
    for (const [, client] of this.clients) {
      client.transport.send(msg);
    }
  }

  private broadcastSnapshot(): void {
    const players: SnapshotPlayer[] = [];
    for (let i = 0; i < this.numPlayers; i++) {
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
      });
    }

    for (const [, record] of this.clients) {
      const msg: SnapshotMessage = {
        type: MessageType.Snapshot,
        serverTick: this.state.tick,
        lastProcessedSeq: Math.max(0, record.jitter.lastConsumedSeq),
        players,
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
