// Client netcode glue: connects over WebSocket, drives PredictedClient +
// RemoteInterpolator, and falls back to the M0 offline single-player mode if
// the connection fails or doesn't complete within 2s of load.
import {
  MessageType,
  WebSocketTransport,
  decodeMessageSafely,
  encodeMessage,
  withLatency,
  type DamageTakenMessage,
  type KillEventMessage,
  type HitConfirmMessage,
  type SnapshotMessage,
  type Transport,
} from "@vg/protocol";
import { LEVEL_BOXES, createState, eyePosition, getWeaponDef, raycastPlayers, shotDirection, type InputFrame, type ShotEvent, type SimState } from "@vg/sim";
import { HitRegTracker, type HitRegStats } from "./hitreg.js";
import { RemoteInterpolator, type RemotePose } from "./interpolation.js";
import { PredictedClient, type AuthoritativeSnapshot } from "./prediction.js";

const CONNECT_TIMEOUT_MS = 2000;
const INPUT_REDUNDANCY = 3; // newest + previous 2, see @vg/protocol InputBatch docs
const FIRE_MAX_RANGE = 100; // mirrors the server's default (see ServerHostOptions.fireMaxRange)

export interface NetHud {
  connected: boolean;
  rttMs: number | null;
  snapshotAgeMs: number;
  correctionsPerSecond: number;
  starvedFrames: number;
}

export interface PredictedHitEvent {
  targetIndex: number;
}

export interface ConfirmedHitEvent {
  targetIndex: number;
  damage: number;
  region: number; // 0=head,1=body,2=legs
  targetHealthAfter: number;
}

export interface DamageTakenEvent {
  attackerIndex: number;
  damage: number;
}

export interface KillFeedEvent {
  killerIndex: number;
  victimIndex: number;
  weaponId: number;
  headshot: boolean;
  assistIndex: number;
}

export interface NetClient {
  isOnline(): boolean;
  /** Call once per fixed tick with this tick's built input. No-ops if offline. */
  sendInput(input: InputFrame): void;
  /** Call once per fixed tick after sendInput to let prediction/interp advance bookkeeping. */
  getLocalRenderPosition(): { x: number; y: number; z: number } | null;
  isLocalCrouching(): boolean;
  getLocalIndex(): number | null;
  /** Full predicted SimState — HUD/weapon/ADS/credits all read from here for the local player. */
  getPredictedState(): SimState | null;
  getRemotePoses(): readonly RemotePose[] | null;
  /** The server tick remote players are currently being rendered at (carried in every InputBatch's viewTick header). */
  getViewTick(): number;
  /** Shots the local player fired on the most recent sendInput() call (for tracer/hitmarker rendering). */
  getLastLocalShots(): readonly ShotEvent[];
  buy(itemId: number): void;
  onPredictedHit(cb: (e: PredictedHitEvent) => void): void;
  onConfirmedHit(cb: (e: ConfirmedHitEvent) => void): void;
  onDamageTaken(cb: (e: DamageTakenEvent) => void): void;
  onKillEvent(cb: (e: KillFeedEvent) => void): void;
  getHud(): NetHud;
  getHitRegStats(): HitRegStats;
  close(): void;
}

function parseServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("server");
  if (override) return override;
  const host = window.location.hostname || "localhost";
  return `ws://${host}:8787`;
}

function maybeWrapWithFakeLag(transport: Transport): Transport {
  const params = new URLSearchParams(window.location.search);
  const fakelag = params.get("fakelag");
  if (!fakelag) return transport;
  const delayMs = Number(fakelag) || 0;
  const jitterMs = Number(params.get("jitter") ?? 0) || 0;
  const lossRate = Number(params.get("loss") ?? 0) || 0;
  return withLatency(transport, { delayMs, jitterMs, lossRate, seed: Date.now() >>> 0 });
}

/**
 * Builds a scratch SimState populated only with the position/crouching/alive
 * fields a cosmetic raycast needs, from currently-interpolated remote poses
 * — used solely for the client's own predicted-hit feedback (see PLAN.md
 * §3.2 hit feedback policy: predicted hitmarkers are cosmetic only, never
 * authoritative). The local player's own row is left at rest (irrelevant:
 * raycastPlayers always excludes the shooter index).
 */
function buildCosmeticState(poses: readonly RemotePose[], numPlayers: number): SimState {
  const scratch = createState(0, numPlayers);
  for (let i = 0; i < numPlayers; i++) {
    const p = poses[i];
    if (!p) {
      scratch.alive[i] = 0;
      continue;
    }
    scratch.posX[i] = p.posX;
    scratch.posY[i] = p.posY;
    scratch.posZ[i] = p.posZ;
    scratch.crouching[i] = p.crouching ? 1 : 0;
    scratch.alive[i] = p.connected && p.alive ? 1 : 0;
  }
  return scratch;
}

/**
 * Attempts to connect within CONNECT_TIMEOUT_MS. Resolves with a live
 * NetClient on success, or null if the connection failed/timed out (caller
 * should fall back to offline single-player mode, preserving M0 behavior).
 */
export function connectNetClient(): Promise<NetClient | null> {
  return new Promise((resolve) => {
    let settled = false;
    const url = parseServerUrl();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }

    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, CONNECT_TIMEOUT_MS);

    const rawTransport = new WebSocketTransport(socket);
    const transport = maybeWrapWithFakeLag(rawTransport);

    let predicted: PredictedClient | null = null;
    let localIndex: number | null = null;
    let numPlayers = 0;
    const interpolator = new RemoteInterpolator();
    const hitreg = new HitRegTracker();

    const inputHistory: InputFrame[] = [];
    let lastSnapshotAt = performance.now();
    let lastSendAt = 0;
    let rttEstimateMs: number | null = null;
    let correctionsWindowStart = performance.now();
    let correctionsAtWindowStart = 0;
    let correctionsPerSecond = 0;

    const predictedHitCbs: Array<(e: PredictedHitEvent) => void> = [];
    const confirmedHitCbs: Array<(e: ConfirmedHitEvent) => void> = [];
    const damageTakenCbs: Array<(e: DamageTakenEvent) => void> = [];
    const killEventCbs: Array<(e: KillFeedEvent) => void> = [];

    function onSnapshot(msg: SnapshotMessage): void {
      lastSnapshotAt = performance.now();
      hitreg.expire();
      if (lastSendAt > 0) {
        // Coarse RTT estimate: time since we last sent an input to now, when
        // a snapshot arrives acknowledging recent input. Not exact (snapshots
        // aren't a direct reply to a specific input) but good enough for a
        // debug HUD figure.
        rttEstimateMs = performance.now() - lastSendAt;
      }
      interpolator.ingest(
        msg.serverTick,
        msg.players.map(
          (p): RemotePose => ({
            posX: p.posX,
            posY: p.posY,
            posZ: p.posZ,
            yaw: p.yaw,
            pitch: p.pitch,
            crouching: p.crouching,
            grounded: p.grounded,
            connected: p.connected,
            alive: p.alive,
            weaponPrimary: p.weaponPrimary,
            weaponSecondary: p.weaponSecondary,
            activeSlot: p.activeSlot,
            magActive: p.magActive,
          }),
        ),
      );
      if (predicted) {
        const authoritative: AuthoritativeSnapshot = {
          serverTick: msg.serverTick,
          lastProcessedSeq: msg.lastProcessedSeq,
          players: msg.players.map((p) => ({
            posX: p.posX,
            posY: p.posY,
            posZ: p.posZ,
            velX: p.velX,
            velY: p.velY,
            velZ: p.velZ,
            yaw: p.yaw,
            pitch: p.pitch,
            crouching: p.crouching,
            grounded: p.grounded,
            alive: p.alive,
            activeSlot: p.activeSlot,
            adsStage: p.adsStage,
            health: p.health,
            armor: p.armor,
            weaponPrimary: p.weaponPrimary,
            weaponSecondary: p.weaponSecondary,
            magActive: p.magActive,
            reserveActive: p.reserveActive,
            tagTicksLeft: p.tagTicksLeft,
            credits: p.credits,
            respawnTicksLeft: p.respawnTicksLeft,
          })),
        };
        predicted.reconcile(authoritative);
      }
    }

    function onHitConfirm(msg: HitConfirmMessage): void {
      if (localIndex === null || msg.shooterIndex !== localIndex) return;
      hitreg.recordConfirmedHit();
      for (const cb of confirmedHitCbs) {
        cb({ targetIndex: msg.targetIndex, damage: msg.damage, region: msg.region, targetHealthAfter: msg.targetHealthAfter });
      }
    }

    function onDamageTaken(msg: DamageTakenMessage): void {
      if (localIndex === null || msg.victimIndex !== localIndex) return;
      for (const cb of damageTakenCbs) cb({ attackerIndex: msg.attackerIndex, damage: msg.damage });
    }

    function onKillEvent(msg: KillEventMessage): void {
      for (const cb of killEventCbs) {
        cb({ killerIndex: msg.killerIndex, victimIndex: msg.victimIndex, weaponId: msg.weaponId, headshot: msg.headshot, assistIndex: msg.assistIndex });
      }
    }

    transport.onMessage((data) => {
      // A malformed/truncated frame (corrupt packet, a stray non-protocol
      // byte, etc.) must be dropped, not thrown from inside a WebSocket
      // message handler — decodeMessageSafely() never throws.
      const msg = decodeMessageSafely(data);
      if (msg === null) return;
      if (msg.type === MessageType.Welcome) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        localIndex = msg.playerIndex;
        numPlayers = msg.numPlayers;
        predicted = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES);

        const client: NetClient = {
          isOnline: () => true,
          sendInput(input: InputFrame) {
            if (!predicted || localIndex === null) return;
            // Send exactly the quantized input PredictedClient predicted
            // with (F4 fix) — not the raw one — so the wire bytes agree
            // bit-for-bit with what local prediction/replay assumed.
            const { seq: thisSeq, quantizedInput } = predicted.queueAndPredict(input);
            inputHistory.push(quantizedInput);
            if (inputHistory.length > INPUT_REDUNDANCY) inputHistory.shift();
            const firstSeq = thisSeq - inputHistory.length + 1;
            const viewTick = Math.max(0, Math.round(interpolator.getCurrentTargetTick()));
            transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, viewTick, frames: inputHistory.slice() }));
            lastSendAt = performance.now();

            // Cosmetic predicted-hit feedback + hit-reg telemetry for any
            // shots the local player just fired (never applies damage — see
            // PLAN.md §3.2). Uses the same shotDirection() helper the server
            // uses, so the *direction* is byte-identical; the *hit test*
            // itself is intentionally approximate (against interpolated
            // remote poses, not the server's lag-comp-rewound truth).
            const shots = predicted.getLastShots();
            if (shots.length > 0) {
              const state = predicted.getPredictedState();
              const poses = interpolator.sample() ?? [];
              const cosmeticState = buildCosmeticState(poses, numPlayers);
              const origin = eyePosition(state, localIndex);
              for (const shot of shots) {
                const weapon = getWeaponDef(shot.weaponId);
                if (!weapon) continue;
                const dir = shotDirection(state, localIndex, weapon, shot.shotIndex, shot.sprayIndex);
                const hit = raycastPlayers(cosmeticState, localIndex, origin, dir, FIRE_MAX_RANGE);
                hitreg.recordPredictedShot(hit !== null);
                if (hit) {
                  for (const cb of predictedHitCbs) cb({ targetIndex: hit.playerIndex });
                }
              }
            }
          },
          getLocalRenderPosition() {
            return predicted ? predicted.getRenderPosition() : null;
          },
          isLocalCrouching() {
            if (!predicted || localIndex === null) return false;
            return predicted.getPredictedState().crouching[localIndex] === 1;
          },
          getLocalIndex: () => localIndex,
          getPredictedState: () => (predicted ? predicted.getPredictedState() : null),
          getRemotePoses: () => interpolator.sample(),
          getViewTick: () => Math.round(interpolator.getCurrentTargetTick()),
          getLastLocalShots: () => (predicted ? predicted.getLastShots() : []),
          buy(itemId: number) {
            transport.send(encodeMessage({ type: MessageType.BuyCmd, itemId }));
          },
          onPredictedHit(cb) {
            predictedHitCbs.push(cb);
          },
          onConfirmedHit(cb) {
            confirmedHitCbs.push(cb);
          },
          onDamageTaken(cb) {
            damageTakenCbs.push(cb);
          },
          onKillEvent(cb) {
            killEventCbs.push(cb);
          },
          getHud(): NetHud {
            const now = performance.now();
            if (now - correctionsWindowStart > 1000) {
              const correctionsNow = predicted ? predicted.correctionsApplied : 0;
              correctionsPerSecond = ((correctionsNow - correctionsAtWindowStart) * 1000) / (now - correctionsWindowStart);
              correctionsAtWindowStart = correctionsNow;
              correctionsWindowStart = now;
            }
            return {
              connected: true,
              rttMs: rttEstimateMs,
              snapshotAgeMs: now - lastSnapshotAt,
              correctionsPerSecond,
              starvedFrames: interpolator.getStarvedFrameCount(),
            };
          },
          getHitRegStats: () => hitreg.getStats(),
          close() {
            transport.close();
          },
        };
        resolve(client);
      } else if (msg.type === MessageType.Snapshot) {
        onSnapshot(msg);
      } else if (msg.type === MessageType.HitConfirm) {
        onHitConfirm(msg);
      } else if (msg.type === MessageType.DamageTaken) {
        onDamageTaken(msg);
      } else if (msg.type === MessageType.KillEvent) {
        onKillEvent(msg);
      }
    });

    transport.onClose(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(null);
    });
  });
}
