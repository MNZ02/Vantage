// Binary wire format for all client<->server messages. Every message is a
// leading u8 type tag followed by fixed-size little-endian fields (DataView),
// so encode/decode never depend on platform endianness.
//
// M2 changes (protocolVersion bumped 1 -> 2): FireCmd is removed entirely —
// shots are now derived deterministically inside sim's tick() from the
// `fire` input bit (see @vg/sim tick.ts/weapons/logic.ts), so there is
// nothing left for a discrete "I fired" message to carry. InputBatch's
// header gains `viewTick` (replacing FireCmd's per-shot viewTick — the
// server now just keeps the latest per client for lag-comp rewind). The
// buttons byte grows from 4 to 8 bits (ads/reload/slot1/slot2). Snapshot
// gains combat fields per player plus a droppedWeapons entity list. New
// messages: BuyCmd (C->S), KillEvent/HitConfirm/DamageTaken (S->C).
//
// Deviation from the spec's field list, stated plainly: Snapshot and
// InputBatch both carry an explicit array-length prefix (Snapshot's
// `numPlayers`, InputBatch's `count`) so a decoder never needs external
// context (the client's cached numPlayers, say) to know how many entries
// follow — self-describing messages are easier to round-trip/fuzz-test and
// slightly more robust to reconnect-time ordering.

export enum MessageType {
  Hello = 1,
  InputBatch = 2,
  BuyCmd = 3,
  Welcome = 4,
  Snapshot = 5,
  KillEvent = 6,
  HitConfirm = 7,
  DamageTaken = 8,
}

export const PROTOCOL_VERSION = 2;

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
  readonly ads: boolean;
  readonly reload: boolean;
  readonly slot1: boolean;
  readonly slot2: boolean;
}

export interface InputBatchMessage {
  readonly type: MessageType.InputBatch;
  readonly firstSeq: number; // u32, sequence number of frames[0]
  /** The client's current interpolation target tick (for server-side lag-comp rewind of this batch's shots). */
  readonly viewTick: number; // u32
  readonly frames: readonly InputSample[]; // count: u8, up to 255
}

/** C->S: buy a weapon (itemId = weapon id) or armor (itemId = BUY_ITEM_LIGHT_ARMOR/BUY_ITEM_HEAVY_ARMOR, see @vg/sim constants). */
export interface BuyCmdMessage {
  readonly type: MessageType.BuyCmd;
  readonly itemId: number; // u8
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
  readonly alive: boolean;
  readonly activeSlot: number; // 0 | 1
  readonly adsStage: number; // 0..2
  readonly health: number; // u8
  readonly armor: number; // u8
  readonly weaponPrimary: number; // u8, 255 = none
  readonly weaponSecondary: number; // u8
  readonly magActive: number; // u16
  readonly reserveActive: number; // u16
  readonly tagTicksLeft: number; // u8 (clamped)
  readonly credits: number; // u16 (clamped to 9000)
  readonly respawnTicksLeft: number; // u8 (clamped)
}

export interface SnapshotDroppedWeapon {
  readonly id: number; // u8, entity id (stable while the drop exists)
  readonly weaponId: number; // u8
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly mag: number; // u16, ammo the drop was left with
}

export interface SnapshotMessage {
  readonly type: MessageType.Snapshot;
  readonly serverTick: number; // u32
  readonly lastProcessedSeq: number; // u32, for the receiving client
  readonly players: readonly SnapshotPlayer[]; // numPlayers: u8, then that many entries
  readonly droppedWeapons: readonly SnapshotDroppedWeapon[]; // count: u8, then that many entries (server caps at 32 live drops)
}

/** S->C: a player died. */
export interface KillEventMessage {
  readonly type: MessageType.KillEvent;
  readonly killerIndex: number; // u8
  readonly victimIndex: number; // u8
  readonly weaponId: number; // u8
  readonly headshot: boolean; // flags bit 0
  readonly assistIndex: number; // u8, 255 = none
}

/** S->C: sent to the shooter only, confirming a hit it just landed. */
export interface HitConfirmMessage {
  readonly type: MessageType.HitConfirm;
  readonly shooterIndex: number; // u8
  readonly targetIndex: number; // u8
  readonly damage: number; // u16
  readonly region: number; // u8: 0 = head, 1 = body, 2 = legs
  readonly targetHealthAfter: number; // u8
}

/** S->C: sent to the victim only, for a damage-direction indicator. */
export interface DamageTakenMessage {
  readonly type: MessageType.DamageTaken;
  readonly victimIndex: number; // u8
  readonly attackerIndex: number; // u8
  readonly damage: number; // u16
}

export type ProtocolMessage =
  | HelloMessage
  | InputBatchMessage
  | BuyCmdMessage
  | WelcomeMessage
  | SnapshotMessage
  | KillEventMessage
  | HitConfirmMessage
  | DamageTakenMessage;

const JUMP_BIT = 1 << 0;
const CROUCH_BIT = 1 << 1;
const WALK_BIT = 1 << 2;
const FIRE_BIT = 1 << 3;
const ADS_BIT = 1 << 4;
const RELOAD_BIT = 1 << 5;
const SLOT1_BIT = 1 << 6;
const SLOT2_BIT = 1 << 7;

const CROUCHING_BIT = 1 << 0;
const GROUNDED_BIT = 1 << 1;
const CONNECTED_BIT = 1 << 2;
const ALIVE_BIT = 1 << 3;
const ACTIVE_SLOT_BIT = 1 << 4;
const ADS_STAGE_SHIFT = 5; // 2 bits: 5,6
const ADS_STAGE_MASK = 0b11;

const HEADSHOT_BIT = 1 << 0;

/** Regions in a stable wire order, matching @vg/sim's HitRegion union. */
export const HIT_REGIONS = ["head", "body", "legs"] as const;
export type WireHitRegion = (typeof HIT_REGIONS)[number];

export function encodeRegion(region: WireHitRegion): number {
  return HIT_REGIONS.indexOf(region);
}

export function decodeRegion(code: number): WireHitRegion {
  return HIT_REGIONS[code] ?? "body";
}

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

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.offset, v & 0xffff, true);
    this.offset += 2;
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

/** Thrown for any malformed/truncated/oversized message; callers must catch this at the decode boundary. */
export class MalformedMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMessageError";
  }
}

/**
 * Little-endian byte reader, genuinely bounds-checked: every read verifies
 * enough bytes remain *before* touching the DataView, rather than relying on
 * DataView's own out-of-bounds RangeError. A single malformed/truncated
 * frame must never crash the process it's decoded in — see
 * decodeMessageSafely() below, which is what callers should actually use.
 */
class Reader {
  private view: DataView;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  private ensureReadable(size: number): void {
    if (this.offset + size > this.view.byteLength) {
      throw new MalformedMessageError(
        `truncated message: need ${size} more byte(s) at offset ${this.offset}, have ${this.view.byteLength - this.offset}`,
      );
    }
  }

  u8(): number {
    this.ensureReadable(1);
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    this.ensureReadable(1);
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    this.ensureReadable(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    this.ensureReadable(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    this.ensureReadable(4);
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

const f32RoundScratch = new Float32Array(1);
function quantizeF32(v: number): number {
  f32RoundScratch[0] = v;
  return f32RoundScratch[0]!;
}

/**
 * Quantizes an input sample's numeric fields to exactly what the wire format
 * will carry: forward/right collapse to -1/0/1 (i8), yaw/pitch round to f32
 * precision. Reviewer finding F4: the client was predicting/replaying with
 * raw f64/analog values while the server only ever sees this quantized
 * form (having decoded it off the wire) — an unquantized client prediction
 * disagrees with the server by a tiny but *systematic* (not random) amount
 * every tick, which compounds over a long match. Call this once, at input
 * time, and use the result for prediction, replay, *and* the wire send, so
 * there is exactly one "true" value per tick and it round-trips exactly.
 */
export function quantizeInputSample<T extends { forward: number; right: number; yaw: number; pitch: number }>(input: T): T {
  return {
    ...input,
    forward: quantizeAxis(input.forward),
    right: quantizeAxis(input.right),
    yaw: quantizeF32(input.yaw),
    pitch: quantizeF32(input.pitch),
  };
}

function encodeButtons(
  s: Pick<InputSample, "jump" | "crouch" | "walk" | "fire" | "ads" | "reload" | "slot1" | "slot2">,
): number {
  return (
    (s.jump ? JUMP_BIT : 0) |
    (s.crouch ? CROUCH_BIT : 0) |
    (s.walk ? WALK_BIT : 0) |
    (s.fire ? FIRE_BIT : 0) |
    (s.ads ? ADS_BIT : 0) |
    (s.reload ? RELOAD_BIT : 0) |
    (s.slot1 ? SLOT1_BIT : 0) |
    (s.slot2 ? SLOT2_BIT : 0)
  );
}

/**
 * Snapshot per-player flags byte layout: bit0 crouching, bit1 grounded,
 * bit2 connected, bit3 alive, bit4 activeSlot (0=primary,1=secondary),
 * bits5-6 adsStage (0..2), bit7 reserved/unused.
 */
function encodeFlags(p: Pick<SnapshotPlayer, "crouching" | "grounded" | "connected" | "alive" | "activeSlot" | "adsStage">): number {
  return (
    (p.crouching ? CROUCHING_BIT : 0) |
    (p.grounded ? GROUNDED_BIT : 0) |
    (p.connected ? CONNECTED_BIT : 0) |
    (p.alive ? ALIVE_BIT : 0) |
    (p.activeSlot ? ACTIVE_SLOT_BIT : 0) |
    ((p.adsStage & ADS_STAGE_MASK) << ADS_STAGE_SHIFT)
  );
}

function decodeFlags(flags: number): Pick<SnapshotPlayer, "crouching" | "grounded" | "connected" | "alive" | "activeSlot" | "adsStage"> {
  return {
    crouching: (flags & CROUCHING_BIT) !== 0,
    grounded: (flags & GROUNDED_BIT) !== 0,
    connected: (flags & CONNECTED_BIT) !== 0,
    alive: (flags & ALIVE_BIT) !== 0,
    activeSlot: (flags & ACTIVE_SLOT_BIT) !== 0 ? 1 : 0,
    adsStage: (flags >> ADS_STAGE_SHIFT) & ADS_STAGE_MASK,
  };
}

const CREDITS_CLAMP = 9000;

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
      w.u32(msg.viewTick);
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
    case MessageType.BuyCmd: {
      w.u8(msg.itemId);
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
        w.u8(p.health);
        w.u8(p.armor);
        w.u8(p.weaponPrimary);
        w.u8(p.weaponSecondary);
        w.u16(p.magActive);
        w.u16(p.reserveActive);
        w.u8(Math.min(255, p.tagTicksLeft));
        w.u16(Math.min(CREDITS_CLAMP, p.credits));
        w.u8(Math.min(255, p.respawnTicksLeft));
      }
      w.u8(msg.droppedWeapons.length);
      for (const d of msg.droppedWeapons) {
        w.u8(d.id);
        w.u8(d.weaponId);
        w.f32(d.x);
        w.f32(d.y);
        w.f32(d.z);
        w.u16(d.mag);
      }
      break;
    }
    case MessageType.KillEvent: {
      w.u8(msg.killerIndex);
      w.u8(msg.victimIndex);
      w.u8(msg.weaponId);
      w.u8(msg.headshot ? HEADSHOT_BIT : 0);
      w.u8(msg.assistIndex);
      break;
    }
    case MessageType.HitConfirm: {
      w.u8(msg.shooterIndex);
      w.u8(msg.targetIndex);
      w.u16(msg.damage);
      w.u8(msg.region);
      w.u8(msg.targetHealthAfter);
      break;
    }
    case MessageType.DamageTaken: {
      w.u8(msg.victimIndex);
      w.u8(msg.attackerIndex);
      w.u16(msg.damage);
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
      const viewTick = r.u32();
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
          ads: (buttons & ADS_BIT) !== 0,
          reload: (buttons & RELOAD_BIT) !== 0,
          slot1: (buttons & SLOT1_BIT) !== 0,
          slot2: (buttons & SLOT2_BIT) !== 0,
        });
      }
      return { type, firstSeq, viewTick, frames };
    }
    case MessageType.BuyCmd: {
      const itemId = r.u8();
      return { type, itemId };
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
        const health = r.u8();
        const armor = r.u8();
        const weaponPrimary = r.u8();
        const weaponSecondary = r.u8();
        const magActive = r.u16();
        const reserveActive = r.u16();
        const tagTicksLeft = r.u8();
        const credits = r.u16();
        const respawnTicksLeft = r.u8();
        players.push({
          posX,
          posY,
          posZ,
          velX,
          velY,
          velZ,
          yaw,
          pitch,
          ...decodeFlags(flags),
          health,
          armor,
          weaponPrimary,
          weaponSecondary,
          magActive,
          reserveActive,
          tagTicksLeft,
          credits,
          respawnTicksLeft,
        });
      }
      const dropCount = r.u8();
      const droppedWeapons: SnapshotDroppedWeapon[] = [];
      for (let i = 0; i < dropCount; i++) {
        const id = r.u8();
        const weaponId = r.u8();
        const x = r.f32();
        const y = r.f32();
        const z = r.f32();
        const mag = r.u16();
        droppedWeapons.push({ id, weaponId, x, y, z, mag });
      }
      return { type, serverTick, lastProcessedSeq, players, droppedWeapons };
    }
    case MessageType.KillEvent: {
      const killerIndex = r.u8();
      const victimIndex = r.u8();
      const weaponId = r.u8();
      const flags = r.u8();
      const assistIndex = r.u8();
      return { type, killerIndex, victimIndex, weaponId, headshot: (flags & HEADSHOT_BIT) !== 0, assistIndex };
    }
    case MessageType.HitConfirm: {
      const shooterIndex = r.u8();
      const targetIndex = r.u8();
      const damage = r.u16();
      const region = r.u8();
      const targetHealthAfter = r.u8();
      return { type, shooterIndex, targetIndex, damage, region, targetHealthAfter };
    }
    case MessageType.DamageTaken: {
      const victimIndex = r.u8();
      const attackerIndex = r.u8();
      const damage = r.u16();
      return { type, victimIndex, attackerIndex, damage };
    }
    default: {
      const exhaustive: never = type;
      throw new MalformedMessageError(`unknown message type tag: ${exhaustive as number}`);
    }
  }
}

/**
 * Safe decode boundary: every socket message handler (server and client)
 * must go through this, not decodeMessage() directly. A single malformed,
 * truncated, empty, or oversized frame from one client/peer must never take
 * down the process or the connection for anyone else — it's just dropped.
 * Returns null for anything that fails to decode.
 */
export function decodeMessageSafely(data: Uint8Array): ProtocolMessage | null {
  try {
    return decodeMessage(data);
  } catch (err) {
    if (err instanceof MalformedMessageError) return null;
    // Defensively treat any other decode-time exception the same way — a
    // bad frame must degrade to "ignored", never to a crash.
    return null;
  }
}
