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
// M3 changes (protocolVersion bumped 2 -> 3): buttons grow from u8 to u16
// (interact + ping). Hello gains an optional 16-byte reconnect token
// (all-zero = none); Welcome gains the (possibly newly-issued) token plus
// team + mode. Snapshot gains a whole match section (phase/round/score/spike/
// plant-defuse-progress) and a per-recipient visibleEnemyMask (team-shared
// fog-of-war — see @vg/server's visibility computation); SnapshotPlayer
// gains `team`. New messages: MapPing (C->S), TeamPing/MatchEvent (S->C),
// SellCmd (C->S, buy-phase refund).
//
// Deviation from the spec's field list, stated plainly: (1) Snapshot and
// InputBatch both carry an explicit array-length prefix (Snapshot's
// `numPlayers`, InputBatch's `count`) so a decoder never needs external
// context (the client's cached numPlayers, say) to know how many entries
// follow — self-describing messages are easier to round-trip/fuzz-test and
// slightly more robust to reconnect-time ordering. (2) the spec's "per-player
// flags gain a team bit" doesn't fit team's THREE-valued domain (attackers/
// defenders/unassigned-255) into one bit — team is instead its own u8 field
// per player, exact rather than lossy.
//
// M4a changes (protocolVersion bumped 3 -> 4): buttons grow from u16 (10
// bits used) to carry 4 more edge-triggered ability bits (ability1/ability2/
// signature/ult) — still fits in u16 (14 bits used). SnapshotPlayer gains
// agentId, ultPoints, flashedTicksLeft, flashIntensity (packed into flags'
// remaining bits), and abilityCharges (4 bytes, one per ABILITY_SLOT_* —
// spec's "own player only? simpler: all players" resolved to ALL players,
// same as every other combat field here, so teammates' HUD/ally-charge
// display and spectate both work without a special case). Snapshot gains an
// entity section (ability world-entities: projectiles/smokes/walls/zones/
// recon darts/orbs) with its own u8 count prefix, consistent with the
// droppedWeapons list. New messages: AgentSelectCmd (C->S), AbilityEvent
// (S->C, cast/detonate/pulse/expire cues for VFX/sound). BuyCmd's itemId
// space is extended (100 = ability1 charge, 101 = ability2 charge — see
// @vg/sim constants.ts BUY_ITEM_ABILITY1/2) but the wire shape is unchanged
// (itemId was already a plain u8).
//
// M5 integrity changes (protocolVersion bumped 4 -> 5): ability snapshot
// entities now carry their stable simulation slot, velocity/orientation
// vector, and age. The previous compact array silently remapped sparse entity
// slots on clients and could reuse stale velocity for a different entity.

export enum MessageType {
  Hello = 1,
  InputBatch = 2,
  BuyCmd = 3,
  Welcome = 4,
  Snapshot = 5,
  KillEvent = 6,
  HitConfirm = 7,
  DamageTaken = 8,
  MapPing = 9,
  TeamPing = 10,
  MatchEvent = 11,
  SellCmd = 12,
  AgentSelectCmd = 13,
  AbilityEvent = 14,
}

export const PROTOCOL_VERSION = 5;

/** Fixed length (bytes) of a reconnect session token. All-zero = "no token". */
export const TOKEN_LENGTH = 16;
export const NO_TOKEN: Uint8Array = new Uint8Array(TOKEN_LENGTH);
export const MAX_WIRE_MESSAGE_BYTES = 64 * 1024;

export interface HelloMessage {
  readonly type: MessageType.Hello;
  readonly protocolVersion: number; // u8
  /** 16 bytes; all-zero (NO_TOKEN) = fresh join, no reconnect attempted. */
  readonly reconnectToken: Uint8Array;
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
  readonly ads?: boolean;
  readonly reload?: boolean;
  readonly slot1?: boolean;
  readonly slot2?: boolean;
  readonly interact?: boolean;
  readonly ping?: boolean;
  /** M4a, edge-triggered: cast basic1/basic2/signature/ult. */
  readonly ability1?: boolean;
  readonly ability2?: boolean;
  readonly signature?: boolean;
  readonly ult?: boolean;
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

/** C->S (M3): sell back an item purchased THIS buy phase for a full refund (see @vg/sim damage.ts applySell). */
export interface SellCmdMessage {
  readonly type: MessageType.SellCmd;
  readonly itemId: number; // u8
}

/** C->S (M4a): pick an agent during the waiting phase (see @vg/sim abilities/effects.ts selectAgent). */
export interface AgentSelectCmdMessage {
  readonly type: MessageType.AgentSelectCmd;
  readonly agentId: number; // u8
}

export interface WelcomeMessage {
  readonly type: MessageType.Welcome;
  readonly playerIndex: number; // u8
  readonly seed: number; // u32
  readonly numPlayers: number; // u8
  readonly serverTick: number; // u32
  /** 16-byte session token for this slot (M3 reconnect) — resend the SAME token/playerIndex on a successful reattach. */
  readonly token: Uint8Array;
  readonly team: number; // u8: 0 attackers, 1 defenders, 255 unassigned
  readonly mode: number; // u8: 0 dm, 1 match
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
  /** 0 primary, 1 secondary, 2 = ult weapon (M4a: was 0|1). */
  readonly activeSlot: number;
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
  /** M3: 0 attackers, 1 defenders, 255 unassigned. */
  readonly team: number; // u8
  /** M4a: AGENT_NONE (255) if unpicked. */
  readonly agentId: number; // u8
  readonly ultPoints: number; // u8
  readonly flashedTicksLeft: number; // u16 (clamped)
  readonly flashIntensity: number; // 0/1/2 (FLASH_NONE/HALF/FULL) — packed into flags on the wire
  /** Charge counts for ABILITY_SLOT_BASIC1/BASIC2/SIGNATURE/ULT (ult slot always 0 — gated by ultPoints instead). */
  readonly abilityCharges: readonly [number, number, number, number];
}

export interface SnapshotDroppedWeapon {
  readonly id: number; // u8, entity id (stable while the drop exists)
  readonly weaponId: number; // u8
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly mag: number; // u16, ammo the drop was left with
}

/** M4a: one live ability world-entity (projectile/smoke/wall/zone/recon dart/orb — see @vg/sim constants.ts ENT_*). */
export interface SnapshotAbilityEntity {
  readonly slot: number; // u8, stable SimState entity slot
  readonly entType: number; // u8
  readonly owner: number; // u8, 255 = none (e.g. ult orbs)
  readonly abilityId: number; // u8
  readonly x: number; // f32
  readonly y: number; // f32
  readonly z: number; // f32
  readonly velX: number; // f32; wall orientation also rides in X/Z
  readonly velY: number; // f32
  readonly velZ: number; // f32
  readonly ageTicks: number; // u16, clamped ticks since spawn
  readonly endTicksLeft: number; // u16, ticks until expiry (0 if n/a, e.g. still-flying projectiles)
  /** Wall HP / recon-dart pulses-remaining / unused — see @vg/sim SimState.entParam. */
  readonly param: number; // u16
}

export interface SnapshotMessage {
  readonly type: MessageType.Snapshot;
  readonly serverTick: number; // u32
  readonly lastProcessedSeq: number; // u32, for the receiving client
  readonly players: readonly SnapshotPlayer[]; // numPlayers: u8, then that many entries
  readonly droppedWeapons: readonly SnapshotDroppedWeapon[]; // count: u8, then that many entries (server caps at 32 live drops)
  /** M4a: count u8 (0..64), then that many entries — see @vg/sim MAX_ABILITY_ENTITIES. */
  readonly abilityEntities: readonly SnapshotAbilityEntity[];

  // ---- M3 match section ----
  readonly mode: number; // u8: 0 dm, 1 match
  readonly matchPhase: number; // u8
  readonly phaseTicksLeft: number; // u32
  readonly roundNumber: number; // u8
  readonly scoreTeam0: number; // u8
  readonly scoreTeam1: number; // u8
  readonly spikeState: number; // u8
  readonly spikeCarrier: number; // u8, 255 = none
  readonly spikeX: number; // f32
  readonly spikeY: number; // f32
  readonly spikeZ: number; // f32
  readonly spikePlantedTicksLeft: number; // u32, 0 if not planted
  readonly activePlantProgress: number; // u16
  readonly planterIndex: number; // u8, 255 = none
  readonly activeDefuseProgress: number; // u16
  readonly defuserIndex: number; // u8, 255 = none
  /** Enemies of the RECEIVING client's own team currently visible to that team (bit i set = player i visible). Per-recipient — see @vg/server visibility computation. */
  readonly visibleEnemyMask: number; // u16
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

/** C->S (M3): cast a map ping at a raycast-hit world position. Rate-limited server-side (1/s per player). */
export interface MapPingMessage {
  readonly type: MessageType.MapPing;
  readonly x: number; // f32
  readonly z: number; // f32
}

/** S->C (M3): rebroadcast of a MapPing to the sender's teammates only (and the sender). */
export interface TeamPingMessage {
  readonly type: MessageType.TeamPing;
  readonly playerIndex: number; // u8, who pinged
  readonly x: number; // f32
  readonly z: number; // f32
}

/** S->C (M3): a round/match/spike phase transition. kind: 0 roundStart, 1 roundEnd, 2 matchEnd, 3 spikePlanted, 4 spikeDefused, 5 spikeDetonated. reason: 0 elim, 1 detonation, 2 defuse, 3 timeout, 255 n/a. */
export interface MatchEventMessage {
  readonly type: MessageType.MatchEvent;
  readonly kind: number; // u8
  readonly winnerTeam: number; // u8, 255 = n/a
  readonly reason: number; // u8
  readonly roundNumber: number; // u8
}

/** S->C (M4a): a VFX/sound cue for an ability world-event — cast/detonate/pulse/expire (see @vg/sim state.ts AbilityEvent). Purely cosmetic; damage/flash/heal/reveal/res are carried by existing messages (HitConfirm/DamageTaken/KillEvent/Snapshot). */
export interface AbilityEventMessage {
  readonly type: MessageType.AbilityEvent;
  readonly kind: number; // u8: 0 cast, 1 detonate, 2 pulse, 3 expire
  readonly owner: number; // u8
  readonly abilityId: number; // u8
  readonly x: number; // f32
  readonly y: number; // f32
  readonly z: number; // f32
  readonly targetIndex: number; // u8, 255 = n/a (e.g. Mend's healed teammate, Resurrect's revived teammate)
}

export type ProtocolMessage =
  | HelloMessage
  | InputBatchMessage
  | BuyCmdMessage
  | SellCmdMessage
  | WelcomeMessage
  | SnapshotMessage
  | KillEventMessage
  | HitConfirmMessage
  | DamageTakenMessage
  | MapPingMessage
  | TeamPingMessage
  | MatchEventMessage
  | AgentSelectCmdMessage
  | AbilityEventMessage;

const JUMP_BIT = 1 << 0;
const CROUCH_BIT = 1 << 1;
const WALK_BIT = 1 << 2;
const FIRE_BIT = 1 << 3;
const ADS_BIT = 1 << 4;
const RELOAD_BIT = 1 << 5;
const SLOT1_BIT = 1 << 6;
const SLOT2_BIT = 1 << 7;
const INTERACT_BIT = 1 << 8;
const PING_BIT = 1 << 9;
const ABILITY1_BIT = 1 << 10;
const ABILITY2_BIT = 1 << 11;
const SIGNATURE_BIT = 1 << 12;
const ULT_BIT = 1 << 13;

const CROUCHING_BIT = 1 << 0;
const GROUNDED_BIT = 1 << 1;
const CONNECTED_BIT = 1 << 2;
const ALIVE_BIT = 1 << 3;
const ACTIVE_SLOT_SHIFT = 4; // 2 bits: 4,5 (M4a: widened from 1 bit -- 0 primary, 1 secondary, 2 ult weapon)
const ACTIVE_SLOT_MASK = 0b11;
const ADS_STAGE_SHIFT = 6; // 2 bits: 6,7
const ADS_STAGE_MASK = 0b11;
const FLASH_INTENSITY_SHIFT = 8; // 2 bits: 8,9 -- flags widens to u16 for M4a (was u8)
const FLASH_INTENSITY_MASK = 0b11;

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

  writeBytes(arr: Uint8Array): void {
    this.ensure(arr.length);
    this.bytes.set(arr, this.offset);
    this.offset += arr.length;
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
  private buf: Uint8Array;
  private offset = 0;

  constructor(data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.buf = data;
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

  bytes(len: number): Uint8Array {
    this.ensureReadable(len);
    const out = this.buf.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  finish<T>(value: T): T {
    if (this.offset !== this.view.byteLength) {
      throw new MalformedMessageError(`message has ${this.view.byteLength - this.offset} trailing byte(s)`);
    }
    return value;
  }
}

function quantizeAxis(v: number): number {
  if (v > 0.5) return 1;
  if (v < -0.5) return -1;
  return 0;
}

function normalizeYaw(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("input yaw must be finite");
  const twoPi = Math.PI * 2;
  return ((v + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

function normalizePitch(v: number): number {
  if (!Number.isFinite(v)) throw new RangeError("input pitch must be finite");
  return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, v));
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
    yaw: quantizeF32(normalizeYaw(input.yaw)),
    pitch: quantizeF32(normalizePitch(input.pitch)),
  };
}

function encodeButtons(
  s: Pick<
    InputSample,
    "jump" | "crouch" | "walk" | "fire" | "ads" | "reload" | "slot1" | "slot2" | "interact" | "ping" | "ability1" | "ability2" | "signature" | "ult"
  >,
): number {
  return (
    (s.jump ? JUMP_BIT : 0) |
    (s.crouch ? CROUCH_BIT : 0) |
    (s.walk ? WALK_BIT : 0) |
    (s.fire ? FIRE_BIT : 0) |
    (s.ads ? ADS_BIT : 0) |
    (s.reload ? RELOAD_BIT : 0) |
    (s.slot1 ? SLOT1_BIT : 0) |
    (s.slot2 ? SLOT2_BIT : 0) |
    (s.interact ? INTERACT_BIT : 0) |
    (s.ping ? PING_BIT : 0) |
    (s.ability1 ? ABILITY1_BIT : 0) |
    (s.ability2 ? ABILITY2_BIT : 0) |
    (s.signature ? SIGNATURE_BIT : 0) |
    (s.ult ? ULT_BIT : 0)
  );
}

/**
 * Snapshot per-player flags layout (M4a: widened u8 -> u16 to fit activeSlot
 * 0..2 and flashIntensity): bit0 crouching, bit1 grounded, bit2 connected,
 * bit3 alive, bits4-5 activeSlot (0=primary,1=secondary,2=ult weapon),
 * bits6-7 adsStage (0..2), bits8-9 flashIntensity (0..2), bits10-15
 * reserved/unused. (`team`/`agentId`/etc. are their own fields, not packed
 * here — see the module doc comment's deviation note.)
 */
function encodeFlags(p: Pick<SnapshotPlayer, "crouching" | "grounded" | "connected" | "alive" | "activeSlot" | "adsStage" | "flashIntensity">): number {
  return (
    (p.crouching ? CROUCHING_BIT : 0) |
    (p.grounded ? GROUNDED_BIT : 0) |
    (p.connected ? CONNECTED_BIT : 0) |
    (p.alive ? ALIVE_BIT : 0) |
    ((p.activeSlot & ACTIVE_SLOT_MASK) << ACTIVE_SLOT_SHIFT) |
    ((p.adsStage & ADS_STAGE_MASK) << ADS_STAGE_SHIFT) |
    ((p.flashIntensity & FLASH_INTENSITY_MASK) << FLASH_INTENSITY_SHIFT)
  );
}

function decodeFlags(
  flags: number,
): Pick<SnapshotPlayer, "crouching" | "grounded" | "connected" | "alive" | "activeSlot" | "adsStage" | "flashIntensity"> {
  return {
    crouching: (flags & CROUCHING_BIT) !== 0,
    grounded: (flags & GROUNDED_BIT) !== 0,
    connected: (flags & CONNECTED_BIT) !== 0,
    alive: (flags & ALIVE_BIT) !== 0,
    activeSlot: (flags >> ACTIVE_SLOT_SHIFT) & ACTIVE_SLOT_MASK,
    adsStage: (flags >> ADS_STAGE_SHIFT) & ADS_STAGE_MASK,
    flashIntensity: (flags >> FLASH_INTENSITY_SHIFT) & FLASH_INTENSITY_MASK,
  };
}

const CREDITS_CLAMP = 9000;

function writeToken(w: Writer, token: Uint8Array | undefined): void {
  if (token && token.length === TOKEN_LENGTH) {
    w.writeBytes(token);
  } else {
    w.writeBytes(NO_TOKEN);
  }
}

export function encodeMessage(msg: ProtocolMessage): Uint8Array {
  const w = new Writer();
  w.u8(msg.type);
  switch (msg.type) {
    case MessageType.Hello: {
      w.u8(msg.protocolVersion);
      writeToken(w, msg.reconnectToken);
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
        w.u16(encodeButtons(f));
      }
      break;
    }
    case MessageType.BuyCmd: {
      w.u8(msg.itemId);
      break;
    }
    case MessageType.SellCmd: {
      w.u8(msg.itemId);
      break;
    }
    case MessageType.Welcome: {
      w.u8(msg.playerIndex);
      w.u32(msg.seed);
      w.u8(msg.numPlayers);
      w.u32(msg.serverTick);
      writeToken(w, msg.token);
      w.u8(msg.team);
      w.u8(msg.mode);
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
        w.u16(encodeFlags(p));
        w.u8(p.health);
        w.u8(p.armor);
        w.u8(p.weaponPrimary);
        w.u8(p.weaponSecondary);
        w.u16(p.magActive);
        w.u16(p.reserveActive);
        w.u8(Math.min(255, p.tagTicksLeft));
        w.u16(Math.min(CREDITS_CLAMP, p.credits));
        w.u8(Math.min(255, p.respawnTicksLeft));
        w.u8(p.team);
        w.u8(p.agentId);
        w.u8(p.ultPoints);
        w.u16(Math.min(65535, p.flashedTicksLeft));
        w.u8(p.abilityCharges[0]);
        w.u8(p.abilityCharges[1]);
        w.u8(p.abilityCharges[2]);
        w.u8(p.abilityCharges[3]);
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
      w.u8(msg.abilityEntities.length);
      for (const e of msg.abilityEntities) {
        w.u8(e.slot);
        w.u8(e.entType);
        w.u8(e.owner);
        w.u8(e.abilityId);
        w.f32(e.x);
        w.f32(e.y);
        w.f32(e.z);
        w.f32(e.velX);
        w.f32(e.velY);
        w.f32(e.velZ);
        w.u16(Math.min(65535, e.ageTicks));
        w.u16(Math.min(65535, e.endTicksLeft));
        w.u16(Math.min(65535, e.param));
      }
      w.u8(msg.mode);
      w.u8(msg.matchPhase);
      w.u32(msg.phaseTicksLeft);
      w.u8(msg.roundNumber);
      w.u8(msg.scoreTeam0);
      w.u8(msg.scoreTeam1);
      w.u8(msg.spikeState);
      w.u8(msg.spikeCarrier);
      w.f32(msg.spikeX);
      w.f32(msg.spikeY);
      w.f32(msg.spikeZ);
      w.u32(msg.spikePlantedTicksLeft);
      w.u16(msg.activePlantProgress);
      w.u8(msg.planterIndex);
      w.u16(msg.activeDefuseProgress);
      w.u8(msg.defuserIndex);
      w.u16(msg.visibleEnemyMask);
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
    case MessageType.MapPing: {
      w.f32(msg.x);
      w.f32(msg.z);
      break;
    }
    case MessageType.TeamPing: {
      w.u8(msg.playerIndex);
      w.f32(msg.x);
      w.f32(msg.z);
      break;
    }
    case MessageType.MatchEvent: {
      w.u8(msg.kind);
      w.u8(msg.winnerTeam);
      w.u8(msg.reason);
      w.u8(msg.roundNumber);
      break;
    }
    case MessageType.AgentSelectCmd: {
      w.u8(msg.agentId);
      break;
    }
    case MessageType.AbilityEvent: {
      w.u8(msg.kind);
      w.u8(msg.owner);
      w.u8(msg.abilityId);
      w.f32(msg.x);
      w.f32(msg.y);
      w.f32(msg.z);
      w.u8(msg.targetIndex);
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
      const reconnectToken = r.bytes(TOKEN_LENGTH);
      return r.finish({ type, protocolVersion, reconnectToken });
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
        const buttons = r.u16();
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
          interact: (buttons & INTERACT_BIT) !== 0,
          ping: (buttons & PING_BIT) !== 0,
          ability1: (buttons & ABILITY1_BIT) !== 0,
          ability2: (buttons & ABILITY2_BIT) !== 0,
          signature: (buttons & SIGNATURE_BIT) !== 0,
          ult: (buttons & ULT_BIT) !== 0,
        });
      }
      return r.finish({ type, firstSeq, viewTick, frames });
    }
    case MessageType.BuyCmd: {
      const itemId = r.u8();
      return r.finish({ type, itemId });
    }
    case MessageType.SellCmd: {
      const itemId = r.u8();
      return r.finish({ type, itemId });
    }
    case MessageType.Welcome: {
      const playerIndex = r.u8();
      const seed = r.u32();
      const numPlayers = r.u8();
      const serverTick = r.u32();
      const token = r.bytes(TOKEN_LENGTH);
      const team = r.u8();
      const mode = r.u8();
      return r.finish({ type, playerIndex, seed, numPlayers, serverTick, token, team, mode });
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
        const flags = r.u16();
        const health = r.u8();
        const armor = r.u8();
        const weaponPrimary = r.u8();
        const weaponSecondary = r.u8();
        const magActive = r.u16();
        const reserveActive = r.u16();
        const tagTicksLeft = r.u8();
        const credits = r.u16();
        const respawnTicksLeft = r.u8();
        const team = r.u8();
        const agentId = r.u8();
        const ultPoints = r.u8();
        const flashedTicksLeft = r.u16();
        const charge0 = r.u8();
        const charge1 = r.u8();
        const charge2 = r.u8();
        const charge3 = r.u8();
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
          team,
          agentId,
          ultPoints,
          flashedTicksLeft,
          abilityCharges: [charge0, charge1, charge2, charge3],
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
      const entityCount = r.u8();
      const abilityEntities: SnapshotAbilityEntity[] = [];
      for (let i = 0; i < entityCount; i++) {
        const slot = r.u8();
        const entType = r.u8();
        const owner = r.u8();
        const abilityId = r.u8();
        const x = r.f32();
        const y = r.f32();
        const z = r.f32();
        const velX = r.f32();
        const velY = r.f32();
        const velZ = r.f32();
        const ageTicks = r.u16();
        const endTicksLeft = r.u16();
        const param = r.u16();
        abilityEntities.push({ slot, entType, owner, abilityId, x, y, z, velX, velY, velZ, ageTicks, endTicksLeft, param });
      }
      const mode = r.u8();
      const matchPhase = r.u8();
      const phaseTicksLeft = r.u32();
      const roundNumber = r.u8();
      const scoreTeam0 = r.u8();
      const scoreTeam1 = r.u8();
      const spikeState = r.u8();
      const spikeCarrier = r.u8();
      const spikeX = r.f32();
      const spikeY = r.f32();
      const spikeZ = r.f32();
      const spikePlantedTicksLeft = r.u32();
      const activePlantProgress = r.u16();
      const planterIndex = r.u8();
      const activeDefuseProgress = r.u16();
      const defuserIndex = r.u8();
      const visibleEnemyMask = r.u16();
      return r.finish({
        type,
        serverTick,
        lastProcessedSeq,
        players,
        droppedWeapons,
        abilityEntities,
        mode,
        matchPhase,
        phaseTicksLeft,
        roundNumber,
        scoreTeam0,
        scoreTeam1,
        spikeState,
        spikeCarrier,
        spikeX,
        spikeY,
        spikeZ,
        spikePlantedTicksLeft,
        activePlantProgress,
        planterIndex,
        activeDefuseProgress,
        defuserIndex,
        visibleEnemyMask,
      });
    }
    case MessageType.KillEvent: {
      const killerIndex = r.u8();
      const victimIndex = r.u8();
      const weaponId = r.u8();
      const flags = r.u8();
      const assistIndex = r.u8();
      return r.finish({ type, killerIndex, victimIndex, weaponId, headshot: (flags & HEADSHOT_BIT) !== 0, assistIndex });
    }
    case MessageType.HitConfirm: {
      const shooterIndex = r.u8();
      const targetIndex = r.u8();
      const damage = r.u16();
      const region = r.u8();
      const targetHealthAfter = r.u8();
      return r.finish({ type, shooterIndex, targetIndex, damage, region, targetHealthAfter });
    }
    case MessageType.DamageTaken: {
      const victimIndex = r.u8();
      const attackerIndex = r.u8();
      const damage = r.u16();
      return r.finish({ type, victimIndex, attackerIndex, damage });
    }
    case MessageType.MapPing: {
      const x = r.f32();
      const z = r.f32();
      return r.finish({ type, x, z });
    }
    case MessageType.TeamPing: {
      const playerIndex = r.u8();
      const x = r.f32();
      const z = r.f32();
      return r.finish({ type, playerIndex, x, z });
    }
    case MessageType.MatchEvent: {
      const kind = r.u8();
      const winnerTeam = r.u8();
      const reason = r.u8();
      const roundNumber = r.u8();
      return r.finish({ type, kind, winnerTeam, reason, roundNumber });
    }
    case MessageType.AgentSelectCmd: {
      const agentId = r.u8();
      return r.finish({ type, agentId });
    }
    case MessageType.AbilityEvent: {
      const kind = r.u8();
      const owner = r.u8();
      const abilityId = r.u8();
      const x = r.f32();
      const y = r.f32();
      const z = r.f32();
      const targetIndex = r.u8();
      return r.finish({ type, kind, owner, abilityId, x, y, z, targetIndex });
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
  if (data.byteLength === 0 || data.byteLength > MAX_WIRE_MESSAGE_BYTES) return null;
  try {
    return decodeMessage(data);
  } catch (err) {
    if (err instanceof MalformedMessageError) return null;
    // Defensively treat any other decode-time exception the same way — a
    // bad frame must degrade to "ignored", never to a crash.
    return null;
  }
}
