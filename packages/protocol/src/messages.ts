// Binary wire format for all client<->server messages. Every message is a
// leading u8 type tag followed by fixed-size little-endian fields (DataView),
// so encode/decode never depend on platform endianness.
//
// Deviation from the spec's field list, stated plainly: Snapshot and
// InputBatch both carry an explicit array-length prefix (Snapshot's
// `numPlayers`, InputBatch's `count`) so a decoder never needs external
// context (the client's cached numPlayers, say) to know how many entries
// follow — self-describing messages are easier to round-trip/fuzz-test and
// slightly more robust to reconnect-time ordering. Both were already named as
// fields in the spec for InputBatch; Snapshot's `numPlayers` is the only
// addition, and it costs one byte.

export enum MessageType {
  Hello = 1,
  InputBatch = 2,
  FireCmd = 3,
  Welcome = 4,
  Snapshot = 5,
  HitEvent = 6,
}

export const PROTOCOL_VERSION = 1;

export interface HelloMessage {
  readonly type: MessageType.Hello;
  readonly protocolVersion: number; // u8
}

/** One tick's worth of input as carried on the wire (quantized from InputFrame). */
export interface InputSample {
  readonly forward: number; // i8, -1|0|1
  readonly right: number; // i8, -1|0|1
  readonly yaw: number; // f32
  readonly pitch: number; // f32
  readonly jump: boolean;
  readonly crouch: boolean;
  readonly walk: boolean;
  readonly fire: boolean;
}

export interface InputBatchMessage {
  readonly type: MessageType.InputBatch;
  readonly firstSeq: number; // u32, sequence number of frames[0]
  readonly frames: readonly InputSample[]; // count: u8, up to 255
}

export interface FireCmdMessage {
  readonly type: MessageType.FireCmd;
  readonly seq: number; // u32
  readonly viewTick: number; // u32
}

export interface WelcomeMessage {
  readonly type: MessageType.Welcome;
  readonly playerIndex: number; // u8
  readonly seed: number; // u32
  readonly numPlayers: number; // u8
  readonly serverTick: number; // u32
}

export interface SnapshotPlayer {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly velX: number;
  readonly velY: number;
  readonly velZ: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly grounded: boolean;
  readonly connected: boolean;
}

export interface SnapshotMessage {
  readonly type: MessageType.Snapshot;
  readonly serverTick: number; // u32
  readonly lastProcessedSeq: number; // u32, for the receiving client
  readonly players: readonly SnapshotPlayer[]; // numPlayers: u8, then that many entries
}

export interface HitEventMessage {
  readonly type: MessageType.HitEvent;
  readonly shooterIndex: number; // u8
  readonly targetIndex: number; // u8
  readonly serverTick: number; // u32
}

export type ProtocolMessage =
  | HelloMessage
  | InputBatchMessage
  | FireCmdMessage
  | WelcomeMessage
  | SnapshotMessage
  | HitEventMessage;

const JUMP_BIT = 1 << 0;
const CROUCH_BIT = 1 << 1;
const WALK_BIT = 1 << 2;
const FIRE_BIT = 1 << 3;

const CROUCHING_BIT = 1 << 0;
const GROUNDED_BIT = 1 << 1;
const CONNECTED_BIT = 1 << 2;

/** Small growable little-endian byte writer. */
class Writer {
  private view: DataView;
  private bytes: Uint8Array;
  private offset = 0;

  constructor(initialCapacity = 64) {
    this.bytes = new Uint8Array(initialCapacity);
    this.view = new DataView(this.bytes.buffer);
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.bytes.byteLength) return;
    let newCapacity = this.bytes.byteLength * 2;
    while (newCapacity < this.offset + extra) newCapacity *= 2;
    const grown = new Uint8Array(newCapacity);
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(this.bytes.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.offset, v & 0xff);
    this.offset += 1;
  }

  i8(v: number): void {
    this.ensure(1);
    this.view.setInt8(this.offset, v);
    this.offset += 1;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.offset);
  }
}

/** Little-endian byte reader with bounds-checked reads. */
class Reader {
  private view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
}

function quantizeAxis(v: number): number {
  if (v > 0.5) return 1;
  if (v < -0.5) return -1;
  return 0;
}

function encodeButtons(s: Pick<InputSample, "jump" | "crouch" | "walk" | "fire">): number {
  return (s.jump ? JUMP_BIT : 0) | (s.crouch ? CROUCH_BIT : 0) | (s.walk ? WALK_BIT : 0) | (s.fire ? FIRE_BIT : 0);
}

function encodeFlags(p: Pick<SnapshotPlayer, "crouching" | "grounded" | "connected">): number {
  return (p.crouching ? CROUCHING_BIT : 0) | (p.grounded ? GROUNDED_BIT : 0) | (p.connected ? CONNECTED_BIT : 0);
}

export function encodeMessage(msg: ProtocolMessage): Uint8Array {
  const w = new Writer();
  w.u8(msg.type);
  switch (msg.type) {
    case MessageType.Hello: {
      w.u8(msg.protocolVersion);
      break;
    }
    case MessageType.InputBatch: {
      w.u32(msg.firstSeq);
      w.u8(msg.frames.length);
      for (const f of msg.frames) {
        w.i8(quantizeAxis(f.forward));
        w.i8(quantizeAxis(f.right));
        w.f32(f.yaw);
        w.f32(f.pitch);
        w.u8(encodeButtons(f));
      }
      break;
    }
    case MessageType.FireCmd: {
      w.u32(msg.seq);
      w.u32(msg.viewTick);
      break;
    }
    case MessageType.Welcome: {
      w.u8(msg.playerIndex);
      w.u32(msg.seed);
      w.u8(msg.numPlayers);
      w.u32(msg.serverTick);
      break;
    }
    case MessageType.Snapshot: {
      w.u32(msg.serverTick);
      w.u32(msg.lastProcessedSeq);
      w.u8(msg.players.length);
      for (const p of msg.players) {
        w.f32(p.posX);
        w.f32(p.posY);
        w.f32(p.posZ);
        w.f32(p.velX);
        w.f32(p.velY);
        w.f32(p.velZ);
        w.f32(p.yaw);
        w.f32(p.pitch);
        w.u8(encodeFlags(p));
      }
      break;
    }
    case MessageType.HitEvent: {
      w.u8(msg.shooterIndex);
      w.u8(msg.targetIndex);
      w.u32(msg.serverTick);
      break;
    }
  }
  return w.finish();
}

export function decodeMessage(data: Uint8Array): ProtocolMessage {
  const r = new Reader(data);
  const type = r.u8() as MessageType;
  switch (type) {
    case MessageType.Hello: {
      const protocolVersion = r.u8();
      return { type, protocolVersion };
    }
    case MessageType.InputBatch: {
      const firstSeq = r.u32();
      const count = r.u8();
      const frames: InputSample[] = [];
      for (let i = 0; i < count; i++) {
        const forward = r.i8();
        const right = r.i8();
        const yaw = r.f32();
        const pitch = r.f32();
        const buttons = r.u8();
        frames.push({
          forward,
          right,
          yaw,
          pitch,
          jump: (buttons & JUMP_BIT) !== 0,
          crouch: (buttons & CROUCH_BIT) !== 0,
          walk: (buttons & WALK_BIT) !== 0,
          fire: (buttons & FIRE_BIT) !== 0,
        });
      }
      return { type, firstSeq, frames };
    }
    case MessageType.FireCmd: {
      const seq = r.u32();
      const viewTick = r.u32();
      return { type, seq, viewTick };
    }
    case MessageType.Welcome: {
      const playerIndex = r.u8();
      const seed = r.u32();
      const numPlayers = r.u8();
      const serverTick = r.u32();
      return { type, playerIndex, seed, numPlayers, serverTick };
    }
    case MessageType.Snapshot: {
      const serverTick = r.u32();
      const lastProcessedSeq = r.u32();
      const count = r.u8();
      const players: SnapshotPlayer[] = [];
      for (let i = 0; i < count; i++) {
        const posX = r.f32();
        const posY = r.f32();
        const posZ = r.f32();
        const velX = r.f32();
        const velY = r.f32();
        const velZ = r.f32();
        const yaw = r.f32();
        const pitch = r.f32();
        const flags = r.u8();
        players.push({
          posX,
          posY,
          posZ,
          velX,
          velY,
          velZ,
          yaw,
          pitch,
          crouching: (flags & CROUCHING_BIT) !== 0,
          grounded: (flags & GROUNDED_BIT) !== 0,
          connected: (flags & CONNECTED_BIT) !== 0,
        });
      }
      return { type, serverTick, lastProcessedSeq, players };
    }
    case MessageType.HitEvent: {
      const shooterIndex = r.u8();
      const targetIndex = r.u8();
      const serverTick = r.u32();
      return { type, shooterIndex, targetIndex, serverTick };
    }
    default: {
      const exhaustive: never = type;
      throw new Error(`unknown message type: ${exhaustive as number}`);
    }
  }
}
