// Client netcode glue: connects over WebSocket, drives PredictedClient +
// RemoteInterpolator, and falls back to the M0 offline single-player mode if
// the connection fails or doesn't complete within 2s of load.
import {
  MessageType,
  WebSocketTransport,
  decodeMessageSafely,
  encodeMessage,
  withLatency,
  type FireCmdMessage,
  type HitEventMessage,
  type SnapshotMessage,
  type Transport,
} from "@vg/protocol";
import { LEVEL_BOXES, type InputFrame } from "@vg/sim";
import { RemoteInterpolator, type RemotePose } from "./interpolation.js";
import { PredictedClient, type AuthoritativeSnapshot } from "./prediction.js";

const CONNECT_TIMEOUT_MS = 2000;
const INPUT_REDUNDANCY = 3; // newest + previous 2, see @vg/protocol InputBatch docs

export interface NetHud {
  connected: boolean;
  rttMs: number | null;
  snapshotAgeMs: number;
  correctionsPerSecond: number;
  starvedFrames: number;
}

export interface HitFeedbackEvent {
  youAreShooter: boolean;
  youAreTarget: boolean;
}

export interface NetClient {
  isOnline(): boolean;
  /** Call once per fixed tick with this tick's built input. No-ops if offline. */
  sendInput(input: InputFrame): void;
  /** Call once per fixed tick after sendInput to let prediction/interp advance bookkeeping. */
  getLocalRenderPosition(): { x: number; y: number; z: number } | null;
  isLocalCrouching(): boolean;
  getLocalIndex(): number | null;
  getRemotePoses(): readonly RemotePose[] | null;
  /** The server tick remote players are currently being rendered at (for FireCmd.viewTick). */
  getViewTick(): number;
  fire(): void;
  onHit(cb: (e: HitFeedbackEvent) => void): void;
  getHud(): NetHud;
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
    const interpolator = new RemoteInterpolator();

    const inputHistory: InputFrame[] = [];
    let fireSeq = 0;
    let lastSnapshotAt = performance.now();
    let lastSendAt = 0;
    let rttEstimateMs: number | null = null;
    let correctionsWindowStart = performance.now();
    let correctionsAtWindowStart = 0;
    let correctionsPerSecond = 0;

    const hitCbs: Array<(e: HitFeedbackEvent) => void> = [];

    function onSnapshot(msg: SnapshotMessage): void {
      lastSnapshotAt = performance.now();
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
          })),
        };
        predicted.reconcile(authoritative);
      }
    }

    function onHitEvent(msg: HitEventMessage): void {
      if (localIndex === null) return;
      const youAreShooter = msg.shooterIndex === localIndex;
      const youAreTarget = msg.targetIndex === localIndex;
      if (!youAreShooter && !youAreTarget) return;
      for (const cb of hitCbs) cb({ youAreShooter, youAreTarget });
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
        predicted = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES);

        const client: NetClient = {
          isOnline: () => true,
          sendInput(input: InputFrame) {
            if (!predicted) return;
            // Send exactly the quantized input PredictedClient predicted
            // with (F4 fix) — not the raw one — so the wire bytes agree
            // bit-for-bit with what local prediction/replay assumed.
            const { seq: thisSeq, quantizedInput } = predicted.queueAndPredict(input);
            inputHistory.push(quantizedInput);
            if (inputHistory.length > INPUT_REDUNDANCY) inputHistory.shift();
            const firstSeq = thisSeq - inputHistory.length + 1;
            transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, frames: inputHistory.slice() }));
            lastSendAt = performance.now();
          },
          getLocalRenderPosition() {
            return predicted ? predicted.getRenderPosition() : null;
          },
          isLocalCrouching() {
            if (!predicted || localIndex === null) return false;
            return predicted.getPredictedState().crouching[localIndex] === 1;
          },
          getLocalIndex: () => localIndex,
          getRemotePoses: () => interpolator.sample(),
          getViewTick: () => Math.round(interpolator.getCurrentTargetTick()),
          fire() {
            // FireCmd.viewTick is a wire u32 — round the continuous render
            // target to the nearest integer tick (this is exactly the tick
            // the client was visually rendering remote players at).
            const viewTick = Math.max(0, Math.round(interpolator.getCurrentTargetTick()));
            const msg: FireCmdMessage = { type: MessageType.FireCmd, seq: fireSeq++, viewTick };
            transport.send(encodeMessage(msg));
          },
          onHit(cb) {
            hitCbs.push(cb);
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
          close() {
            transport.close();
          },
        };
        resolve(client);
      } else if (msg.type === MessageType.Snapshot) {
        onSnapshot(msg);
      } else if (msg.type === MessageType.HitEvent) {
        onHitEvent(msg);
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
