import { createPrngState, nextRandom } from "@vg/sim";
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

export class Bot {
  private prngState: number;
  private seq = 0;
  private waypointIndex: number;
  private history: InputSample[] = [];
  private playerIndex: number | null = null;
  private lastKnownPos: { x: number; z: number } | null = null;

  constructor(
    private readonly transport: Transport,
    seed: number,
  ) {
    this.prngState = createPrngState(seed);
    this.waypointIndex = this.randInt(WAYPOINTS.length);
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
    } else if (msg.type === MessageType.Snapshot && this.playerIndex !== null) {
      const me = msg.players[this.playerIndex];
      if (me) this.lastKnownPos = { x: me.posX, z: me.posZ };
    }
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
    const yaw = Math.atan2(dx, dz);

    const sample: InputSample = {
      forward: 1,
      right: 0,
      yaw,
      pitch: 0,
      jump: this.rand() < 0.01,
      crouch: this.rand() < 0.03,
      walk: false,
      fire: this.rand() < 0.02,
    };

    this.history.push(sample);
    if (this.history.length > 3) this.history.shift();
    const firstSeq = this.seq - this.history.length + 1;

    this.transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, frames: this.history.slice() }));
    this.seq++;
  }
}
