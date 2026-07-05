import { CROUCH_HEIGHT, EYE_HEIGHT_STAND, STAND_HEIGHT, WEAPONS, createPrngState, nextRandom } from "@vg/sim";
import { MessageType, decodeMessageSafely, encodeMessage, type InputSample, type ProtocolMessage, type Transport } from "@vg/protocol";

// Bot movement/action lives here (server-side), not sim/src, so it is not
// bound by the sim's purity guard — it's free to use ordinary Math.* — but it
// still drives the connection purely through the wire protocol like any
// other client, so the exact same class works in-process (loopback
// Transport, used by tests) and over a real WebSocket (used by the `bots`
// CLI, see botsCli.ts).
const WAYPOINTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 12, z: 12 },
  { x: -12, z: 12 },
  { x: -12, z: -12 },
  { x: 12, z: -12 },
  { x: 0, z: 0 },
];

const WAYPOINT_ARRIVE_RADIUS = 1.5;
const BURST_LEN_TICKS = 10;
const BURST_GAP_TICKS = 25;
const ENGAGE_RANGE_M = 40;
const AIM_ERROR_RAD = 0.06; // "small error", per spec

interface KnownOther {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
  alive: boolean;
  connected: boolean;
}

export class Bot {
  private prngState: number;
  private seq = 0;
  private waypointIndex: number;
  private history: InputSample[] = [];
  private playerIndex: number | null = null;
  private lastKnownPos: { x: number; z: number } | null = null;
  private lastKnownServerTick = 0;
  private credits = 0;
  private alive = true;
  private hasPrimary = false;
  private burstTicksLeft = 0;
  private ticksUntilNextBurst = 0;
  private boughtOnce = false;
  private others: KnownOther[] = [];

  constructor(
    private readonly transport: Transport,
    seed: number,
  ) {
    this.prngState = createPrngState(seed);
    this.waypointIndex = this.randInt(WAYPOINTS.length);
    this.ticksUntilNextBurst = this.randInt(60);
    transport.onMessage((data) => {
      const msg = decodeMessageSafely(data);
      if (msg !== null) this.handleMessage(msg);
    });
  }

  private rand(): number {
    const r = nextRandom(this.prngState);
    this.prngState = r.nextState;
    return r.value;
  }

  private randInt(maxExclusive: number): number {
    return Math.floor(this.rand() * maxExclusive);
  }

  private handleMessage(msg: ProtocolMessage): void {
    if (msg.type === MessageType.Welcome) {
      this.playerIndex = msg.playerIndex;
      this.lastKnownServerTick = msg.serverTick;
    } else if (msg.type === MessageType.Snapshot && this.playerIndex !== null) {
      this.lastKnownServerTick = msg.serverTick;
      const me = msg.players[this.playerIndex];
      if (me) {
        this.lastKnownPos = { x: me.posX, z: me.posZ };
        this.credits = me.credits;
        this.alive = me.alive;
        this.hasPrimary = me.weaponPrimary !== 255;
      }
      this.others = msg.players
        .filter((_, i) => i !== this.playerIndex)
        .map((p) => ({ x: p.posX, y: p.posY, z: p.posZ, crouching: p.crouching, alive: p.alive, connected: p.connected }));
    }
  }

  /** Nearest connected, alive other player within ENGAGE_RANGE_M of `pos`, or null. */
  private nearestEnemy(pos: { x: number; z: number }): KnownOther | null {
    let best: KnownOther | null = null;
    let bestDist = ENGAGE_RANGE_M;
    for (const other of this.others) {
      if (!other.alive || !other.connected) continue;
      const dist = Math.hypot(other.x - pos.x, other.z - pos.z);
      if (dist < bestDist) {
        best = other;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Occasionally buys a random affordable weapon (bot economy, so combat soaks exercise weapon variety). */
  private maybeBuy(): void {
    if (!this.alive) return;
    // Buy once early, then only rarely re-buy (e.g. after losing a primary on death).
    if (this.boughtOnce && this.hasPrimary) return;
    if (this.rand() > 0.02) return;

    const affordable = WEAPONS.filter((w) => w.price > 0 && w.price <= this.credits);
    if (affordable.length === 0) return;
    const pick = affordable[this.randInt(affordable.length)]!;
    this.transport.send(encodeMessage({ type: MessageType.BuyCmd, itemId: pick.id }));
    this.boughtOnce = true;
  }

  /** Produces and sends exactly one tick's worth of scripted input (call at 64 Hz). */
  tick(): void {
    const target = WAYPOINTS[this.waypointIndex]!;
    const pos = this.lastKnownPos ?? { x: 0, z: 0 };
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < WAYPOINT_ARRIVE_RADIUS) {
      this.waypointIndex = (this.waypointIndex + 1) % WAYPOINTS.length;
    }
    // Sim convention (see movement.ts wishDirection): yaw=0 faces +Z, and the
    // world-space forward direction is (sin(yaw), cos(yaw)) — so facing
    // (dx, dz) is yaw = atan2(dx, dz).
    const wanderYaw = Math.atan2(dx, dz);

    this.maybeBuy();

    // Bot aim: point at the nearest other player's last-known (interpolated,
    // from its perspective) position with small error, per spec — falls
    // back to the waypoint-wander heading when no enemy is in range.
    const enemy = this.nearestEnemy(pos);
    let yaw = wanderYaw;
    let pitch = 0;
    if (enemy) {
      const edx = enemy.x - pos.x;
      const edz = enemy.z - pos.z;
      const horizontalDist = Math.max(0.5, Math.hypot(edx, edz));
      const enemyHeight = enemy.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const enemyBodyY = enemy.y + enemyHeight * 0.5;
      const dy = enemyBodyY - EYE_HEIGHT_STAND;
      yaw = Math.atan2(edx, edz) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
      pitch = Math.atan2(dy, horizontalDist) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
    }

    // Burst-fire while wandering: alternate short firing bursts with gaps,
    // rather than a flat per-tick fire probability, so soaks exercise real
    // mag/reload/spray cycling instead of isolated single shots. Bots only
    // open fire when an enemy is actually in range.
    let fire = false;
    if (this.burstTicksLeft > 0) {
      fire = enemy !== null;
      this.burstTicksLeft--;
    } else if (this.ticksUntilNextBurst > 0) {
      this.ticksUntilNextBurst--;
    } else if (enemy && this.rand() < 0.6) {
      this.burstTicksLeft = BURST_LEN_TICKS;
      this.ticksUntilNextBurst = BURST_GAP_TICKS + this.randInt(40);
      fire = true;
      this.burstTicksLeft--;
    } else if (this.rand() < 0.15) {
      this.burstTicksLeft = BURST_LEN_TICKS;
      this.ticksUntilNextBurst = BURST_GAP_TICKS + this.randInt(40);
      fire = false; // no enemy in range: burst window still consumes, but stays silent
      this.burstTicksLeft--;
    } else {
      this.ticksUntilNextBurst = 5 + this.randInt(20);
    }

    const sample: InputSample = {
      forward: 1,
      right: 0,
      yaw,
      pitch,
      jump: this.rand() < 0.01,
      crouch: this.rand() < 0.03,
      walk: false,
      fire,
      ads: false,
      reload: this.rand() < 0.01,
      slot1: false,
      slot2: false,
    };

    this.history.push(sample);
    if (this.history.length > 3) this.history.shift();
    const firstSeq = this.seq - this.history.length + 1;

    this.transport.send(
      encodeMessage({
        type: MessageType.InputBatch,
        firstSeq,
        viewTick: this.lastKnownServerTick,
        frames: this.history.slice(),
      }),
    );
    this.seq++;
  }
}
