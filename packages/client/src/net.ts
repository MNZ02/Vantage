// Client netcode glue: connects over WebSocket, drives PredictedClient +
// RemoteInterpolator, and falls back to the M0 offline single-player mode if
// the connection fails or doesn't complete within 5s of load. The slightly
// wider startup window leaves room for shader/model initialization on slow
// GPUs without incorrectly abandoning a healthy local WebSocket handshake.
//
// M3: also owns mid-match reconnect — the session token + server URL are
// stashed in sessionStorage on every Welcome (match mode only), so a tab
// refresh's fresh connectNetClient() call picks the token back up and sends
// it in Hello; an unexpected close (not a user-initiated close()) triggers
// an auto-retry loop (every 2s, up to 90s, matching the server's hold
// window) rather than falling back to offline mode outright.
import {
  MessageType,
  NO_TOKEN,
  PROTOCOL_VERSION,
  TOKEN_LENGTH,
  WebSocketTransport,
  decodeMessageSafely,
  encodeMessage,
  withLatency,
  type AbilityEventMessage,
  type DamageTakenMessage,
  type KillEventMessage,
  type HitConfirmMessage,
  type MatchEventMessage,
  type SnapshotDroppedWeapon,
  type SnapshotMessage,
  type TeamPingMessage,
  type Transport,
} from "@vg/protocol";
import {
  ABILITY_PENETRATES_WALLS,
  LEVEL_BOXES,
  MODE_MATCH,
  createState,
  eyePosition,
  raycastBoxes,
  raycastPlayers,
  raycastWalls,
  shotDirection,
  type InputFrame,
  type ShotEvent,
  type SimState,
} from "@vg/sim";
import { HitRegTracker, type HitRegStats } from "./hitreg.js";
import { RemoteInterpolator, type RemotePose } from "./interpolation.js";
import { PredictedClient, type AuthoritativeSnapshot } from "./prediction.js";
import { getShotPresentationWeapon } from "./shotPresentation.js";

const CONNECT_TIMEOUT_MS = 5000;
const INPUT_REDUNDANCY = 3; // newest + previous 2, see @vg/protocol InputBatch docs
const FIRE_MAX_RANGE = 100; // mirrors the server's default (see ServerHostOptions.fireMaxRange)
const RECONNECT_RETRY_INTERVAL_MS = 2000;
const RECONNECT_ATTEMPT_TIMEOUT_MS = 5000;
const RECONNECT_TOTAL_WINDOW_MS = 90_000; // matches the server's reconnectHoldMs default
const SESSION_STORAGE_KEY = "vg_reconnect_session";

export interface NetHud {
  connected: boolean;
  rttMs: number | null;
  snapshotAgeMs: number;
  correctionsPerSecond: number;
  starvedFrames: number;
  /** True while an unexpected disconnect is being retried (see the module doc comment). */
  reconnecting: boolean;
}

export interface PredictedHitEvent {
  targetIndex: number;
}

/** Cosmetic nearest impact resolved from the same predicted shot direction used by hit-reg feedback. */
export interface PredictedShotImpactEvent {
  x: number;
  y: number;
  z: number;
  distance: number;
  kind: "player" | "world" | "ability-wall";
  /** Present only for player impacts. */
  targetIndex: number | null;
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

/** M3 match HUD snapshot — everything the phase/round/spike/minimap UI needs, read once per frame. */
export interface MatchHud {
  mode: number;
  myTeam: number;
  matchPhase: number;
  phaseTicksLeft: number;
  roundNumber: number;
  scoreTeam0: number;
  scoreTeam1: number;
  spikeState: number;
  spikeCarrier: number;
  spikeX: number;
  spikeY: number;
  spikeZ: number;
  spikePlantedTicksLeft: number;
  activePlantProgress: number;
  planterIndex: number;
  activeDefuseProgress: number;
  defuserIndex: number;
  visibleEnemyMask: number;
}

export interface TeamPingEvent {
  playerIndex: number;
  x: number;
  z: number;
}

const NULL_MATCH_HUD: MatchHud = {
  mode: 0,
  myTeam: 255,
  matchPhase: 0,
  phaseTicksLeft: 0,
  roundNumber: 0,
  scoreTeam0: 0,
  scoreTeam1: 0,
  spikeState: 0,
  spikeCarrier: 255,
  spikeX: 0,
  spikeY: 0,
  spikeZ: 0,
  spikePlantedTicksLeft: 0,
  activePlantProgress: 0,
  planterIndex: 255,
  activeDefuseProgress: 0,
  defuserIndex: 255,
  visibleEnemyMask: 0,
};

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
  /** Latest authoritative dropped-weapon list from Snapshot. */
  getDroppedWeapons(): readonly SnapshotDroppedWeapon[];
  /** The server tick remote players are currently being rendered at (carried in every InputBatch's viewTick header). */
  getViewTick(): number;
  /** Shots the local player fired on the most recent sendInput() call (for tracer/hitmarker rendering). */
  getLastLocalShots(): readonly ShotEvent[];
  buy(itemId: number): void;
  /** M3: sell back an item bought this buy phase, for a full refund. */
  sell(itemId: number): void;
  /** M3: cast a map ping at a world (x, z) — rate-limited server-side. */
  sendPing(x: number, z: number): void;
  /** M4a: pick an agent during the waiting phase. */
  selectAgent(agentId: number): void;
  /** M3: phase/round/score/spike/minimap state, updated on every Snapshot. Zeroed-out in DM mode. */
  getMatchHud(): MatchHud;
  onPredictedHit(cb: (e: PredictedHitEvent) => void): void;
  /** Fires once for the nearest visible player/world impact of each locally-predicted shot. */
  onPredictedShotImpact(cb: (e: PredictedShotImpactEvent) => void): void;
  onConfirmedHit(cb: (e: ConfirmedHitEvent) => void): void;
  onDamageTaken(cb: (e: DamageTakenEvent) => void): void;
  onKillEvent(cb: (e: KillFeedEvent) => void): void;
  onMatchEvent(cb: (e: MatchEventMessage) => void): void;
  onTeamPing(cb: (e: TeamPingEvent) => void): void;
  /** M5: ability world-event VFX/sound cues (cast/detonate/pulse/expire) — see @vg/protocol AbilityEventMessage. Purely cosmetic, wired straight through from the server. */
  onAbilityEvent(cb: (e: AbilityEventMessage) => void): void;
  getHud(): NetHud;
  getHitRegStats(): HitRegStats;
  close(): void;
}

function parseServerUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const override = params.get("server");
  if (override) {
    try {
      const parsed = new URL(override, window.location.href);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return parsed.href;
    } catch {
      /* fall through to the same-origin host default */
    }
  }
  const host = window.location.hostname || "localhost";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}:8787`;
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

interface SavedSession {
  token: number[];
  url: string;
}

/** Reads the saved reconnect token/url from sessionStorage, or null if absent/corrupt/wrong-length. */
function loadSavedSession(): { token: Uint8Array; url: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedSession;
    if (!Array.isArray(parsed.token) || parsed.token.length !== TOKEN_LENGTH || typeof parsed.url !== "string") return null;
    const parsedUrl = new URL(parsed.url);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") return null;
    return { token: Uint8Array.from(parsed.token), url: parsed.url };
  } catch {
    return null;
  }
}

function saveSession(token: Uint8Array, url: string): void {
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: Array.from(token), url } satisfies SavedSession));
  } catch {
    /* sessionStorage unavailable (private mode, etc.) — reconnect degrades to "treated as a fresh join", not fatal */
  }
}

function clearSavedSession(): void {
  try {
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Builds a scratch SimState populated only with the position/crouching/alive
 * fields a cosmetic raycast needs, from currently-interpolated remote poses
 * — used solely for the client's own predicted-hit feedback (see PLAN.md
 * §3.2 hit feedback policy: predicted hitmarkers are cosmetic only, never
 * authoritative). The local row is populated too so raycastPlayers can use
 * its team for friendly-fire exclusion, though its collision volume is
 * ignored because raycastPlayers always excludes the shooter index.
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
    scratch.team[i] = p.team;
  }
  return scratch;
}

/**
 * Attempts to connect within CONNECT_TIMEOUT_MS. Resolves with a live
 * NetClient on success, or null if the connection failed/timed out (caller
 * should fall back to offline single-player mode, preserving M0 behavior).
 * If a saved reconnect session exists (see the module doc comment), the
 * saved URL is used and its token is presented in Hello.
 */
export function connectNetClient(): Promise<NetClient | null> {
  return new Promise((resolve) => {
    let settled = false;
    const saved = loadSavedSession();
    const url = saved?.url ?? parseServerUrl();
    const initialToken = saved?.token ?? NO_TOKEN;

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

    socket.addEventListener("open", () => {
      // Send Hello first — carries the reconnect token, if any (all-zero
      // otherwise). The server's Welcome is sent unconditionally at
      // connect()-time regardless (see ServerHost), so ordering with this
      // Hello doesn't matter for a fresh join; it matters only for reconnect,
      // where the server is specifically waiting on this message.
      try {
        socket.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: initialToken }));
      } catch {
        /* socket not actually open yet in some edge case — ignore, Welcome will just arrive late or not at all and the connect timeout handles it */
      }
    });

    const rawTransport = new WebSocketTransport(socket);
    const transport = maybeWrapWithFakeLag(rawTransport);

    let predicted: PredictedClient | null = null;
    let localIndex: number | null = null;
    let numPlayers = 0;
    const currentUrl = url;
    let currentToken: Uint8Array = initialToken;
    let mode = 0;
    const interpolator = new RemoteInterpolator();
    const hitreg = new HitRegTracker();

    const inputHistory: InputFrame[] = [];
    let lastSnapshotAt = performance.now();
    let lastSendAt = 0;
    let rttEstimateMs: number | null = null;
    let correctionsWindowStart = performance.now();
    let correctionsAtWindowStart = 0;
    let correctionsPerSecond = 0;
    let matchHud: MatchHud = NULL_MATCH_HUD;
    let droppedWeapons: readonly SnapshotDroppedWeapon[] = [];
    let reconnecting = false;
    let networkConnected = true;
    let userClosed = false;
    let currentTransport = transport;

    const predictedHitCbs: Array<(e: PredictedHitEvent) => void> = [];
    const predictedShotImpactCbs: Array<(e: PredictedShotImpactEvent) => void> = [];
    const confirmedHitCbs: Array<(e: ConfirmedHitEvent) => void> = [];
    const damageTakenCbs: Array<(e: DamageTakenEvent) => void> = [];
    const killEventCbs: Array<(e: KillFeedEvent) => void> = [];
    const matchEventCbs: Array<(e: MatchEventMessage) => void> = [];
    const teamPingCbs: Array<(e: TeamPingEvent) => void> = [];
    const abilityEventCbs: Array<(e: AbilityEventMessage) => void> = [];

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
            team: p.team,
            agentId: p.agentId,
          }),
        ),
      );
      mode = msg.mode;
      droppedWeapons = msg.droppedWeapons;
      matchHud = {
        mode: msg.mode,
        myTeam: localIndex !== null ? (msg.players[localIndex]?.team ?? 255) : 255,
        matchPhase: msg.matchPhase,
        phaseTicksLeft: msg.phaseTicksLeft,
        roundNumber: msg.roundNumber,
        scoreTeam0: msg.scoreTeam0,
        scoreTeam1: msg.scoreTeam1,
        spikeState: msg.spikeState,
        spikeCarrier: msg.spikeCarrier,
        spikeX: msg.spikeX,
        spikeY: msg.spikeY,
        spikeZ: msg.spikeZ,
        spikePlantedTicksLeft: msg.spikePlantedTicksLeft,
        activePlantProgress: msg.activePlantProgress,
        planterIndex: msg.planterIndex,
        activeDefuseProgress: msg.activeDefuseProgress,
        defuserIndex: msg.defuserIndex,
        visibleEnemyMask: msg.visibleEnemyMask,
      };
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
            team: p.team,
            agentId: p.agentId,
            ultPoints: p.ultPoints,
            flashedTicksLeft: p.flashedTicksLeft,
            flashIntensity: p.flashIntensity,
            abilityCharges: p.abilityCharges,
          })),
          abilityEntities: msg.abilityEntities.map((e) => ({
            slot: e.slot,
            entType: e.entType,
            owner: e.owner,
            abilityId: e.abilityId,
            x: e.x,
            y: e.y,
            z: e.z,
            velX: e.velX,
            velY: e.velY,
            velZ: e.velZ,
            ageTicks: e.ageTicks,
            endTicksLeft: e.endTicksLeft,
            param: e.param,
          })),
          match:
            msg.mode === MODE_MATCH
              ? {
                  mode: msg.mode,
                  matchPhase: msg.matchPhase,
                  phaseTicksLeft: msg.phaseTicksLeft,
                  roundNumber: msg.roundNumber,
                  scoreTeam0: msg.scoreTeam0,
                  scoreTeam1: msg.scoreTeam1,
                  spikeState: msg.spikeState,
                  spikeCarrier: msg.spikeCarrier,
                  spikeX: msg.spikeX,
                  spikeY: msg.spikeY,
                  spikeZ: msg.spikeZ,
                  spikePlantedTicksLeft: msg.spikePlantedTicksLeft,
                  activePlantProgress: msg.activePlantProgress,
                  planterIndex: msg.planterIndex,
                  activeDefuseProgress: msg.activeDefuseProgress,
                  defuserIndex: msg.defuserIndex,
                }
              : undefined,
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

    function onMatchEvent(msg: MatchEventMessage): void {
      for (const cb of matchEventCbs) cb(msg);
    }

    function onTeamPing(msg: TeamPingMessage): void {
      for (const cb of teamPingCbs) cb({ playerIndex: msg.playerIndex, x: msg.x, z: msg.z });
    }

    function onAbilityEvent(msg: AbilityEventMessage): void {
      for (const cb of abilityEventCbs) cb(msg);
    }

    function wireTransport(t: Transport): void {
      t.onMessage((data) => {
        // A malformed/truncated frame (corrupt packet, a stray non-protocol
        // byte, etc.) must be dropped, not thrown from inside a WebSocket
        // message handler — decodeMessageSafely() never throws.
        const msg = decodeMessageSafely(data);
        if (msg === null) return;
        if (msg.type === MessageType.Welcome) {
          if (!settled) {
            settled = true;
            clearTimeout(timeoutHandle);
            localIndex = msg.playerIndex;
            numPlayers = msg.numPlayers;
            predicted = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES, msg.mode);
            resolve(client);
          } else {
            // A second Welcome (reconnect reattach, possibly a different
            // playerIndex than a provisional/original one — e.g. a restarted
            // server that treats us as a fresh join). PredictedClient bakes
            // localIndex in at construction (stepLocalOnly feeds the local
            // input into that slot; getRenderPosition reads it), so it MUST
            // be rebuilt whenever a Welcome arrives — otherwise prediction
            // keeps simulating the OLD slot: the camera renders from a stale
            // position, the local input is applied to a ghost, and every
            // fired shot resolves from the wrong origin (shots visibly "miss"
            // despite perfect aim). Position/loadout for the new slot are
            // refreshed by the very next Snapshot's reconcile() — the sim
            // tick gap between disconnect and reattach is exactly what
            // reconcile()'s existing tick-offset rebase handles.
            localIndex = msg.playerIndex;
            numPlayers = msg.numPlayers;
            predicted = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES, msg.mode);
            inputHistory.length = 0; // input seqs restart at 0 with the fresh PredictedClient
            reconnecting = false;
          }
          mode = msg.mode;
          if (msg.mode === MODE_MATCH && msg.token.some((b) => b !== 0)) {
            currentToken = msg.token;
            saveSession(msg.token, currentUrl);
          }
        } else if (msg.type === MessageType.Snapshot) {
          onSnapshot(msg);
        } else if (msg.type === MessageType.HitConfirm) {
          onHitConfirm(msg);
        } else if (msg.type === MessageType.DamageTaken) {
          onDamageTaken(msg);
        } else if (msg.type === MessageType.KillEvent) {
          onKillEvent(msg);
        } else if (msg.type === MessageType.MatchEvent) {
          onMatchEvent(msg);
        } else if (msg.type === MessageType.TeamPing) {
          onTeamPing(msg);
        } else if (msg.type === MessageType.AbilityEvent) {
          onAbilityEvent(msg);
        }
      });

      t.onClose(() => {
        if (!settled) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          resolve(null);
          return;
        }
        if (userClosed) return;
        if (t !== currentTransport) return;
        networkConnected = false;
        // Mid-match unexpected disconnect: auto-retry rather than falling
        // back to offline mode (that would silently strand the player out
        // of a live match). Only meaningful in match mode (mode carries the
        // last-known value from Welcome/Snapshot).
        if (mode === MODE_MATCH) {
          startReconnectLoop();
        }
      });
    }

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt: Transport | null = null;
    let reconnectAttemptTimeout: ReturnType<typeof setTimeout> | null = null;
    let reconnectDeadline = 0;

    function clearReconnectAttempt(close: boolean): void {
      if (reconnectAttemptTimeout) {
        clearTimeout(reconnectAttemptTimeout);
        reconnectAttemptTimeout = null;
      }
      const attempt = reconnectAttempt;
      reconnectAttempt = null;
      if (close && attempt) {
        try {
          attempt.close();
        } catch {
          /* already closed */
        }
      }
    }

    function giveUpReconnect(): void {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      clearReconnectAttempt(true);
      reconnecting = false;
      networkConnected = false;
      clearSavedSession();
    }

    function scheduleReconnect(delayMs: number): void {
      if (!reconnecting || userClosed || reconnectTimer || reconnectAttempt) return;
      if (performance.now() > reconnectDeadline) {
        giveUpReconnect();
        return;
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        attemptReconnect();
      }, delayMs);
    }

    function startReconnectLoop(): void {
      if (reconnecting || userClosed) return;
      reconnecting = true;
      networkConnected = false;
      reconnectDeadline = performance.now() + RECONNECT_TOTAL_WINDOW_MS;
      scheduleReconnect(0);
    }

    function attemptReconnect(): void {
      if (!reconnecting || userClosed || reconnectAttempt) return;
      if (performance.now() > reconnectDeadline) {
        giveUpReconnect();
        return;
      }
      let retrySocket: WebSocket;
      try {
        retrySocket = new WebSocket(currentUrl);
      } catch {
        scheduleReconnect(RECONNECT_RETRY_INTERVAL_MS);
        return;
      }
      retrySocket.addEventListener("open", () => {
        try {
          retrySocket.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION, reconnectToken: currentToken }));
        } catch {
          /* ignore */
        }
      });
      const retryRaw = new WebSocketTransport(retrySocket);
      const retryTransport = maybeWrapWithFakeLag(retryRaw);
      reconnectAttempt = retryTransport;
      reconnectAttemptTimeout = setTimeout(() => {
        if (reconnectAttempt !== retryTransport) return;
        clearReconnectAttempt(true);
        scheduleReconnect(RECONNECT_RETRY_INTERVAL_MS);
      }, RECONNECT_ATTEMPT_TIMEOUT_MS);
      let attached = false;
      retryTransport.onMessage((data) => {
        const msg = decodeMessageSafely(data);
        if (msg === null) return;
        if (msg.type === MessageType.Welcome && !attached) {
          attached = true;
          clearReconnectAttempt(false);
          currentTransport = retryTransport;
          wireTransport(retryTransport);
          // Re-deliver this very Welcome to the freshly-wired handler (it
          // was consumed by this bootstrap listener, not wireTransport's).
          localIndex = msg.playerIndex;
          numPlayers = msg.numPlayers;
          mode = msg.mode;
          // The reattach may land on a DIFFERENT player slot (e.g. a
          // restarted server treats us as a fresh join). PredictedClient
          // bakes localIndex in at construction — stepLocalOnly feeds the
          // local input into that slot, getRenderPosition reads it — so it
          // MUST be rebuilt or prediction keeps simulating the OLD slot:
          // the camera renders from a stale position, inputs are applied to
          // a ghost, and every fired shot resolves from the wrong origin
          // ("perfectly aimed" shots visibly miss). Position/loadout for
          // the new slot are refreshed by the next Snapshot's reconcile().
          predicted = new PredictedClient(msg.seed, msg.numPlayers, msg.playerIndex, LEVEL_BOXES, msg.mode);
          inputHistory.length = 0; // input seqs restart at 0 with the fresh PredictedClient
          reconnecting = false;
          networkConnected = true;
          if (msg.mode === MODE_MATCH && msg.token.some((b) => b !== 0)) {
            currentToken = msg.token;
            saveSession(msg.token, currentUrl);
          }
        }
      });
      retryTransport.onClose(() => {
        if (attached || reconnectAttempt !== retryTransport) return;
        clearReconnectAttempt(false);
        scheduleReconnect(RECONNECT_RETRY_INTERVAL_MS);
      });
    }

    const client: NetClient = {
      isOnline: () => true,
      sendInput(input: InputFrame) {
        if (!predicted || localIndex === null || !networkConnected) return;
        // Send exactly the quantized input PredictedClient predicted
        // with (F4 fix) — not the raw one — so the wire bytes agree
        // bit-for-bit with what local prediction/replay assumed.
        const { seq: thisSeq, quantizedInput } = predicted.queueAndPredict(input);
        inputHistory.push(quantizedInput);
        if (inputHistory.length > INPUT_REDUNDANCY) inputHistory.shift();
        const firstSeq = thisSeq - inputHistory.length + 1;
        const viewTick = Math.max(0, Math.round(interpolator.getCurrentTargetTick()));
        currentTransport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, viewTick, frames: inputHistory.slice() }));
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
            const weapon = getShotPresentationWeapon(shot.weaponId);
            if (!weapon) continue;
            const dir = shotDirection(state, localIndex, weapon, shot.shotIndex, shot.sprayIndex);
            const playerHit = raycastPlayers(cosmeticState, localIndex, origin, dir, FIRE_MAX_RANGE, mode === MODE_MATCH);
            const penetratesWalls = ABILITY_PENETRATES_WALLS.has(shot.weaponId);

            // Static level geometry is exact on the client because LEVEL_BOXES
            // is the same source used by ServerHost. Ability walls come from
            // the reconciled predicted state. Only remote player positions are
            // approximate (interpolated at view time), matching the existing
            // cosmetic hitmarker contract.
            const staticWallDist = penetratesWalls ? null : raycastBoxes(LEVEL_BOXES, origin, dir, FIRE_MAX_RANGE);
            const abilityWallHit = penetratesWalls ? null : raycastWalls(state, origin, dir, FIRE_MAX_RANGE);
            let occluderDist: number | null = staticWallDist;
            let occluderKind: PredictedShotImpactEvent["kind"] = "world";
            if (abilityWallHit && (occluderDist === null || abilityWallHit.dist < occluderDist)) {
              occluderDist = abilityWallHit.dist;
              occluderKind = "ability-wall";
            }

            // The authoritative server treats a wall at the same distance as
            // blocking, hence the strict comparison here.
            const visiblePlayerHit = playerHit !== null && (occluderDist === null || playerHit.dist < occluderDist);
            hitreg.recordPredictedShot(visiblePlayerHit);
            if (visiblePlayerHit && playerHit) {
              for (const cb of predictedHitCbs) cb({ targetIndex: playerHit.playerIndex });
            }

            const impactDistance = visiblePlayerHit && playerHit ? playerHit.dist : occluderDist;
            if (impactDistance !== null) {
              const impact: PredictedShotImpactEvent = {
                x: origin.x + dir.x * impactDistance,
                y: origin.y + dir.y * impactDistance,
                z: origin.z + dir.z * impactDistance,
                distance: impactDistance,
                kind: visiblePlayerHit ? "player" : occluderKind,
                targetIndex: visiblePlayerHit && playerHit ? playerHit.playerIndex : null,
              };
              for (const cb of predictedShotImpactCbs) cb(impact);
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
      getDroppedWeapons: () => droppedWeapons,
      getViewTick: () => Math.round(interpolator.getCurrentTargetTick()),
      getLastLocalShots: () => (networkConnected && predicted ? predicted.getLastShots() : []),
      buy(itemId: number) {
        if (!networkConnected) return;
        currentTransport.send(encodeMessage({ type: MessageType.BuyCmd, itemId }));
      },
      sell(itemId: number) {
        if (!networkConnected) return;
        currentTransport.send(encodeMessage({ type: MessageType.SellCmd, itemId }));
      },
      sendPing(x: number, z: number) {
        if (!networkConnected) return;
        currentTransport.send(encodeMessage({ type: MessageType.MapPing, x, z }));
      },
      selectAgent(agentId: number) {
        if (!networkConnected) return;
        currentTransport.send(encodeMessage({ type: MessageType.AgentSelectCmd, agentId }));
      },
      getMatchHud: () => matchHud,
      onPredictedHit(cb) {
        predictedHitCbs.push(cb);
      },
      onPredictedShotImpact(cb) {
        predictedShotImpactCbs.push(cb);
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
      onMatchEvent(cb) {
        matchEventCbs.push(cb);
      },
      onTeamPing(cb) {
        teamPingCbs.push(cb);
      },
      onAbilityEvent(cb) {
        abilityEventCbs.push(cb);
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
          connected: networkConnected,
          rttMs: rttEstimateMs,
          snapshotAgeMs: now - lastSnapshotAt,
          correctionsPerSecond,
          starvedFrames: interpolator.getStarvedFrameCount(),
          reconnecting,
        };
      },
      getHitRegStats: () => hitreg.getStats(),
      close() {
        userClosed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        clearReconnectAttempt(true);
        currentTransport.close();
        clearSavedSession();
      },
    };

    wireTransport(transport);
  });
}
