import * as THREE from "three";
import {
  AGENT_NONE,
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_STAND,
  FIXED_DT,
  LEVEL_BOXES,
  MODE_MATCH,
  NO_PLAYER,
  PHASE_BUY,
  PHASE_WAITING,
  SPIKE_CARRIED,
  SPIKE_PLANTED,
  WEAPON_NONE,
  createState,
  eyePosition,
  getWeaponDef,
  livingTeammates,
  raycastBoxes,
  shotDirection,
  tick,
  viewDirection,
  type SimState,
} from "@vg/sim";
import { buildInputFrame, getPitch, getYaw, onBuyKeyPressed, onBuyMenuToggle, setLookSensitivityMultiplier, setupInput } from "./input.js";
import { GRAYBOX_BOXES, SPAWN_POSITION } from "./graybox.js";
import {
  createAbilityEntityRenderer,
  createAbilityHud,
  createAgentSelectOverlay,
  createBuyMenu,
  createCombatHud,
  createDamageDirectionIndicator,
  createFlashOverlay,
  createFpsCounter,
  createHitFlashOverlay,
  createHitmarker,
  createKillFeed,
  createMatchHud,
  createMinimap,
  createReconnectBanner,
  createRemotePlayerProxy,
  createScene,
  createSpectateOverlay,
  buildGrayboxMeshes,
  spawnTracer,
  type RemotePlayerProxy,
} from "./render.js";
import { connectNetClient, type NetClient } from "./net.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
setupInput(canvas);

const { renderer, scene, camera } = createScene(canvas);
buildGrayboxMeshes(scene, GRAYBOX_BOXES);
const fpsCounter = createFpsCounter();
const hitFlash = createHitFlashOverlay();
const hitmarker = createHitmarker();
const killFeed = createKillFeed((i) => `P${i}`);
const damageIndicator = createDamageDirectionIndicator();
const combatHud = createCombatHud();
const matchHud = createMatchHud();
const minimap = createMinimap();
const spectateOverlay = createSpectateOverlay();
const reconnectBanner = createReconnectBanner();
const abilityHud = createAbilityHud();
const flashOverlay = createFlashOverlay();
const abilityEntities = createAbilityEntityRenderer(scene);
const agentSelect = createAgentSelectOverlay((agentId) => netClient?.selectAgent(agentId));

let netClient: NetClient | null = null;
const remoteProxies = new Map<number, RemotePlayerProxy>();
interface RemoteWeaponSnapshot {
  magActive: number;
  activeSlot: number;
  weaponPrimary: number;
  weaponSecondary: number;
}
const remoteLastWeapon = new Map<number, RemoteWeaponSnapshot>();

/** M3: fading TeamPing markers for the minimap (see render.ts's Minimap). */
const teamPings: Array<{ x: number; z: number; createdAtMs: number }> = [];
const TEAM_PING_RETENTION_MS = 5200;

const buyMenu = createBuyMenu(
  (itemId) => {
    netClient?.buy(itemId);
  },
  (itemId) => {
    netClient?.sell(itemId);
  },
);
onBuyMenuToggle((open) => buyMenu.setOpen(open));
onBuyKeyPressed((digit) => {
  // Rows are numbered 1..8 in createBuyMenu's item order (6 weapons + 2 armors).
  const itemIds = [0, 1, 2, 3, 4, 5, 200, 201];
  const itemId = itemIds[digit - 1];
  if (itemId !== undefined) netClient?.buy(itemId);
});

// ---- M3 spectate: while dead in match mode, camera follows a living
// teammate's interpolated pose instead of the (frozen, dead) local player. ----
let spectateIndex: number | null = null;
canvas.addEventListener("click", () => {
  if (!netClient) return;
  const localIndex = netClient.getLocalIndex();
  const state = netClient.getPredictedState();
  if (localIndex === null || !state || state.alive[localIndex] === 1) return; // only cycles while actually dead
  const mates = livingTeammates(state, localIndex);
  if (mates.length === 0) {
    spectateIndex = null;
    return;
  }
  const currentPos = spectateIndex === null ? -1 : mates.indexOf(spectateIndex);
  spectateIndex = mates[(currentPos + 1) % mates.length]!;
});

// ---- Offline (M0) fallback state — used only if connecting fails/times out. ----
let offlineState: SimState | null = null;
let offlinePreviousState: SimState | null = null;

function startOffline(): void {
  // Client is allowed wall-clock/random APIs (only sim/src is banned from
  // them); the sim itself only ever sees the pure (state, inputs, boxes) it's given.
  offlineState = createState(Date.now() >>> 0, 1);
  offlineState.posX[0] = SPAWN_POSITION.x;
  offlineState.posY[0] = SPAWN_POSITION.y;
  offlineState.posZ[0] = SPAWN_POSITION.z;
  offlinePreviousState = offlineState;
}

connectNetClient().then((client) => {
  if (client) {
    netClient = client;
    client.onPredictedHit(() => {
      hitmarker.showPredicted();
    });
    client.onConfirmedHit(({ damage }) => {
      hitmarker.showConfirmed(damage);
    });
    client.onDamageTaken(({ attackerIndex }) => {
      hitFlash.flash();
      const localIndex = netClient?.getLocalIndex();
      const state = netClient?.getPredictedState();
      if (localIndex !== null && localIndex !== undefined && state) {
        // Screen-relative angle from the local player's current yaw toward the attacker.
        const dx = state.posX[attackerIndex]! - state.posX[localIndex]!;
        const dz = state.posZ[attackerIndex]! - state.posZ[localIndex]!;
        const worldAngle = Math.atan2(dx, dz);
        const screenAngle = worldAngle - getYaw();
        damageIndicator.show(screenAngle);
      }
    });
    client.onKillEvent((e) => {
      killFeed.push(e);
    });
    client.onMatchEvent((e) => {
      const localIndex = netClient?.getLocalIndex();
      const state = netClient?.getPredictedState();
      const myTeam = localIndex !== null && localIndex !== undefined && state ? state.team[localIndex]! : 255;
      if (e.kind === 1) matchHud.showRoundEnd(e.winnerTeam, e.reason, myTeam);
      else if (e.kind === 2) {
        const s = netClient?.getPredictedState();
        if (s) matchHud.showMatchEnd(s.scoreTeam0, s.scoreTeam1, myTeam);
      }
    });
    client.onTeamPing((e) => {
      teamPings.push({ x: e.x, z: e.z, createdAtMs: performance.now() });
    });
    // eslint-disable-next-line no-console
    console.log("[net] connected, playing online");
  } else {
    // eslint-disable-next-line no-console
    console.log("[net] offline (no server reachable within 2s) — falling back to single-player");
    startOffline();
  }
});

// Fixed-timestep accumulator: the sim always advances in whole FIXED_DT
// steps, independent of the render frame rate; the frame itself is drawn by
// linearly interpolating between the previous and current sim states
// (offline) or by PredictedClient's own render-position smoothing (online).
let accumulator = 0;
let lastFrameTime = performance.now();

const MAX_FRAME_TIME = 0.25; // clamp to avoid a "spiral of death" after a stall (tab backgrounding, breakpoints, etc.)

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Deliberately called once per *rendered* frame (see the call site in
// frame(), outside the fixed-tick input loop) rather than once per fixed
// 64Hz tick: RemoteInterpolator.sample() now targets a continuous
// (fractional) render time, not a snapshot-cadence-aligned tick, so calling
// it every rendered frame is what makes remote players glide instead of
// visibly stepping at the 32Hz snapshot rate.
function syncRemoteProxies(): void {
  if (!netClient) return;
  const poses = netClient.getRemotePoses();
  if (!poses) return;
  const localIndex = netClient.getLocalIndex();

  for (let i = 0; i < poses.length; i++) {
    if (i === localIndex) continue;
    const pose = poses[i]!;
    let proxy = remoteProxies.get(i);
    if (!pose.connected) {
      if (proxy) {
        proxy.dispose(scene);
        remoteProxies.delete(i);
      }
      remoteLastWeapon.delete(i);
      continue;
    }
    if (!proxy) {
      proxy = createRemotePlayerProxy(scene);
      remoteProxies.set(i, proxy);
    }
    proxy.setPose(pose);

    // Remote shot tracer heuristic: active-slot ammo decreased since the
    // last check -> they fired (see interpolation.ts's RemotePose.magActive
    // doc comment for why this proxies shotCounter, which isn't on the wire).
    // Gated on activeSlot/weaponPrimary/weaponSecondary all being unchanged
    // too: magActive refers to whichever slot is active, so a weapon switch
    // (e.g. primary mag 25 -> secondary mag 12) is a magActive *decrease*
    // that is not a shot and must not spawn a stray tracer.
    const prev = remoteLastWeapon.get(i);
    const weaponUnchanged =
      !!prev && prev.activeSlot === pose.activeSlot && prev.weaponPrimary === pose.weaponPrimary && prev.weaponSecondary === pose.weaponSecondary;
    if (prev && weaponUnchanged && pose.magActive < prev.magActive && pose.alive) {
      const from = new THREE.Vector3(pose.posX, pose.posY + EYE_HEIGHT_STAND, pose.posZ);
      const dir = viewDirection(pose.yaw, pose.pitch);
      const to = from.clone().add(new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(50));
      spawnTracer(scene, from, to, 100);
    }
    remoteLastWeapon.set(i, {
      magActive: pose.magActive,
      activeSlot: pose.activeSlot,
      weaponPrimary: pose.weaponPrimary,
      weaponSecondary: pose.weaponSecondary,
    });
  }
}

/** FOV smoothing state for ADS zoom (see updateAds()). */
let currentFov = 90;
let adsSensitivityMult = 1;

function zoomForStage(weaponId: number, adsStage: number): number {
  if (adsStage === 0) return 1;
  const weapon = getWeaponDef(weaponId);
  if (!weapon) return 1;
  return weapon.adsZoomStages[adsStage - 1] ?? 1;
}

function updateAds(frameSeconds: number): void {
  if (!netClient) return;
  const localIndex = netClient.getLocalIndex();
  const state = netClient.getPredictedState();
  if (localIndex === null || !state) return;

  const weaponId = state.activeSlot[localIndex] === 0 ? state.weaponPrimary[localIndex]! : state.weaponSecondary[localIndex]!;
  const zoom = weaponId === WEAPON_NONE ? 1 : zoomForStage(weaponId, state.adsStage[localIndex]!);
  const targetFov = 90 / zoom;

  // ~100ms smoothing: exponential approach with a time-constant tuned so it
  // visually settles in roughly that window.
  const smoothing = 1 - Math.exp(-frameSeconds / 0.05);
  currentFov = lerp(currentFov, targetFov, smoothing);
  camera.fov = currentFov;
  camera.updateProjectionMatrix();

  adsSensitivityMult = 1 / zoom; // sensitivity scales down proportionally to zoom while ADS
  setLookSensitivityMultiplier(adsSensitivityMult);
}

function fireLocalTracersAndHitmarkers(): void {
  if (!netClient) return;
  const localIndex = netClient.getLocalIndex();
  const state = netClient.getPredictedState();
  if (localIndex === null || !state) return;
  const shots = netClient.getLastLocalShots();
  if (shots.length === 0) return;

  const origin = eyePosition(state, localIndex);
  for (const shot of shots) {
    const weapon = getWeaponDef(shot.weaponId);
    if (!weapon) continue;
    const dir = shotDirection(state, localIndex, weapon, shot.shotIndex, shot.sprayIndex);
    const from = new THREE.Vector3(origin.x, origin.y, origin.z);
    const to = from.clone().add(new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(50));
    spawnTracer(scene, from, to, 80);
  }
}

/** M3: casts a map ping — raycasts from the local player's eye/view through the world and pings the hit (x, z). */
function sendMapPingAtLookTarget(): void {
  if (!netClient) return;
  const localIndex = netClient.getLocalIndex();
  const state = netClient.getPredictedState();
  if (localIndex === null || !state) return;
  const origin = eyePosition(state, localIndex);
  const dir = viewDirection(getYaw(), getPitch());
  const dist = raycastBoxes(LEVEL_BOXES, origin, dir, 200);
  if (dist === null) return;
  netClient.sendPing(origin.x + dir.x * dist, origin.z + dir.z * dist);
}

function updateHud(): void {
  if (!netClient) return;
  const localIndex = netClient.getLocalIndex();
  const state = netClient.getPredictedState();
  if (localIndex === null || !state) return;

  const weaponId = state.activeSlot[localIndex] === 0 ? state.weaponPrimary[localIndex]! : state.weaponSecondary[localIndex]!;
  const weapon = getWeaponDef(weaponId);
  const mag = state.activeSlot[localIndex] === 0 ? state.magPrimary[localIndex]! : state.magSecondary[localIndex]!;
  const reserve = state.activeSlot[localIndex] === 0 ? state.reservePrimary[localIndex]! : state.reserveSecondary[localIndex]!;
  const alive = state.alive[localIndex] === 1;
  const respawnTicksLeft = alive ? 0 : Math.max(0, state.respawnTick[localIndex]! - state.tick);

  combatHud.update({
    health: state.health[localIndex]!,
    armor: state.armor[localIndex]!,
    weaponName: weapon?.name ?? "none",
    magAmmo: mag,
    reserveAmmo: reserve,
    credits: state.credits[localIndex]!,
    alive,
    respawnSecondsLeft: respawnTicksLeft * FIXED_DT,
  });
  buyMenu.setState(state.credits[localIndex]!, alive);

  // ---- M4a: ability HUD, flash overlay, ability world-entities, agent select ----
  abilityHud.update({
    agentId: state.agentId[localIndex]!,
    charges: [
      state.abilityCharges[localIndex * 4 + 0]!,
      state.abilityCharges[localIndex * 4 + 1]!,
      state.abilityCharges[localIndex * 4 + 2]!,
      state.abilityCharges[localIndex * 4 + 3]!,
    ],
    ultPoints: state.ultPoints[localIndex]!,
  });
  const flashedTicksLeft = Math.max(0, state.flashedUntilTick[localIndex]! - state.tick);
  flashOverlay.update(flashedTicksLeft, state.flashIntensity[localIndex]!);
  abilityEntities.sync(state);

  const inWaitingPhase = state.mode === MODE_MATCH && state.matchPhase === PHASE_WAITING;
  agentSelect.setOpen(inWaitingPhase);
  if (inWaitingPhase) {
    const picks = Array.from(state.agentId);
    const teams = Array.from(state.team);
    agentSelect.setPicks(picks, teams, localIndex, state.agentId[localIndex]!);
  }

  if (state.mode !== MODE_MATCH) {
    matchHud.update({
      mode: 0,
      matchPhase: 0,
      phaseSecondsLeft: 0,
      roundNumber: 0,
      scoreTeam0: 0,
      scoreTeam1: 0,
      myTeam: 255,
      spikeState: 0,
      isCarrier: false,
      detonateSecondsLeft: 0,
      ownChannelProgress01: null,
      ownChannelKind: null,
    });
    return;
  }

  const myTeam = state.team[localIndex]!;
  const isCarrier = state.spikeCarrier === localIndex && state.spikeState === SPIKE_CARRIED;
  const isPlanting = state.planterIndex === localIndex;
  const isDefusing = state.defuserIndex === localIndex;
  const ownChannelKind = isPlanting ? "plant" : isDefusing ? "defuse" : null;
  const ownChannelProgress01 = isPlanting
    ? state.plantProgress / state.config.plantTicks
    : isDefusing
      ? state.defuseProgress / state.config.defuseTicks
      : null;
  const detonateSecondsLeft =
    state.spikeState === SPIKE_PLANTED ? Math.max(0, state.spikePlantedTick + state.config.spikeTicks - state.tick) * FIXED_DT : 0;
  const phaseSecondsLeft = state.phaseEndTick >= 0 ? Math.max(0, state.phaseEndTick - state.tick) * FIXED_DT : 0;

  matchHud.update({
    mode: state.mode,
    matchPhase: state.matchPhase,
    phaseSecondsLeft,
    roundNumber: state.roundNumber,
    scoreTeam0: state.scoreTeam0,
    scoreTeam1: state.scoreTeam1,
    myTeam,
    spikeState: state.spikeState,
    isCarrier,
    detonateSecondsLeft,
    ownChannelProgress01,
    ownChannelKind,
  });

  buyMenu.setMatchState(purchasedItemIds(state, localIndex), state.matchPhase === PHASE_BUY);

  // ---- Minimap ----
  const nowMs = performance.now();
  const poses = netClient.getRemotePoses();
  const teammates: Array<{ x: number; z: number }> = [];
  const visibleEnemies: Array<{ x: number; z: number }> = [];
  // The team-shared visibility mask is server-computed and travels on the
  // wire as a single per-recipient field (Snapshot.visibleEnemyMask) — it's
  // not part of SimState (see @vg/server ServerHost.updateVisibility()), so
  // it's read from the net layer's match HUD snapshot, not the sim state.
  const visibleEnemyMask = netClient.getMatchHud().visibleEnemyMask;
  if (poses) {
    for (let i = 0; i < poses.length; i++) {
      const p = poses[i]!;
      if (!p.connected) continue;
      if (i === localIndex) continue;
      if (p.team === myTeam) {
        if (p.alive) teammates.push({ x: p.posX, z: p.posZ });
      } else if (p.alive && (visibleEnemyMask & (1 << i)) !== 0) {
        visibleEnemies.push({ x: p.posX, z: p.posZ });
      }
    }
  }
  minimap.update({
    self: alive ? { x: state.posX[localIndex]!, z: state.posZ[localIndex]!, yaw: state.yaw[localIndex]! } : null,
    teammates,
    visibleEnemies,
    spike:
      state.spikeState === SPIKE_CARRIED || state.spikeState === 1 || state.spikeState === SPIKE_PLANTED
        ? { state: state.spikeState, x: state.spikeX, z: state.spikeZ }
        : null,
    pings: teamPings.map((p) => ({ x: p.x, z: p.z, ageMs: nowMs - p.createdAtMs })),
  });
  for (let i = teamPings.length - 1; i >= 0; i--) {
    if (nowMs - teamPings[i]!.createdAtMs > TEAM_PING_RETENTION_MS) teamPings.splice(i, 1);
  }

  // ---- Spectate overlay ----
  if (!alive) {
    const mates = livingTeammates(state, localIndex);
    if (spectateIndex === null || !mates.includes(spectateIndex)) spectateIndex = mates[0] ?? null;
    spectateOverlay.update(spectateIndex, mates.length === 0);
  } else {
    spectateIndex = null;
    spectateOverlay.update(null, false);
  }
}

/** Item ids purchased THIS buy phase (see @vg/sim's per-buy-phase purchase tracking) — drives sell-button visibility. */
function purchasedItemIds(state: SimState, localIndex: number): Set<number> {
  const out = new Set<number>();
  if (state.primaryPurchasedItemId[localIndex] !== WEAPON_NONE) out.add(state.primaryPurchasedItemId[localIndex]!);
  if (state.secondaryPurchasedItemId[localIndex] !== WEAPON_NONE) out.add(state.secondaryPurchasedItemId[localIndex]!);
  if (state.armorPurchasedItemId[localIndex] !== NO_PLAYER) out.add(state.armorPurchasedItemId[localIndex]!);
  return out;
}

function frame(now: number): void {
  requestAnimationFrame(frame);

  let frameSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (frameSeconds > MAX_FRAME_TIME) frameSeconds = MAX_FRAME_TIME;
  if (frameSeconds < 0) frameSeconds = 0;

  accumulator += frameSeconds;

  let renderX = 0;
  let renderY = 0;
  let renderZ = 0;
  let eyeHeight = EYE_HEIGHT_STAND;

  let spectateCameraOverride: { x: number; y: number; z: number; yaw: number; pitch: number } | null = null;

  if (netClient && netClient.isOnline()) {
    while (accumulator >= FIXED_DT) {
      const input = buildInputFrame();
      netClient.sendInput(input);
      fireLocalTracersAndHitmarkers();
      if (input.ping) sendMapPingAtLookTarget();
      accumulator -= FIXED_DT;
    }
    const pos = netClient.getLocalRenderPosition();
    if (pos) {
      renderX = pos.x;
      renderY = pos.y;
      renderZ = pos.z;
    }
    eyeHeight = netClient.isLocalCrouching() ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
    syncRemoteProxies();
    updateAds(frameSeconds);
    updateHud();
    reconnectBanner.setVisible(netClient.getHud().reconnecting);

    // M3 spectate: while dead, replace the local (frozen) camera with a
    // living teammate's interpolated pose. Never spectates enemies (see
    // livingTeammates()'s team filter, used to populate spectateIndex).
    const localIndex = netClient.getLocalIndex();
    const state = netClient.getPredictedState();
    if (localIndex !== null && state && state.alive[localIndex] === 0 && spectateIndex !== null) {
      const poses = netClient.getRemotePoses();
      const target = poses?.[spectateIndex];
      if (target && target.connected && target.alive) {
        spectateCameraOverride = {
          x: target.posX,
          y: target.posY,
          z: target.posZ,
          yaw: target.yaw,
          pitch: target.pitch,
        };
      }
    }
  } else if (offlineState && offlinePreviousState) {
    while (accumulator >= FIXED_DT) {
      offlinePreviousState = offlineState;
      const input = buildInputFrame(); // already zeroes movement/actions while the buy menu is open
      offlineState = tick(offlineState, [input], GRAYBOX_BOXES).state;
      accumulator -= FIXED_DT;
    }
    const alpha = accumulator / FIXED_DT;
    renderX = lerp(offlinePreviousState.posX[0]!, offlineState.posX[0]!, alpha);
    renderY = lerp(offlinePreviousState.posY[0]!, offlineState.posY[0]!, alpha);
    renderZ = lerp(offlinePreviousState.posZ[0]!, offlineState.posZ[0]!, alpha);
    eyeHeight = offlineState.crouching[0] === 1 ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
  }

  camera.rotation.order = "YXZ";
  if (spectateCameraOverride) {
    camera.position.set(spectateCameraOverride.x, spectateCameraOverride.y + EYE_HEIGHT_STAND, spectateCameraOverride.z);
    camera.rotation.y = spectateCameraOverride.yaw + Math.PI;
    camera.rotation.x = spectateCameraOverride.pitch;
  } else {
    camera.position.set(renderX, renderY + eyeHeight, renderZ);
    // Mouse look is applied every rendered frame (not gated to the fixed tick)
    // for the smoothest possible feel; only movement is fixed-timestep.
    // rotation.y = yaw + PI because Three's default camera forward is -Z while
    // the sim's yaw=0 forward direction is +Z (see input.ts / movement.ts).
    camera.rotation.y = getYaw() + Math.PI;
    camera.rotation.x = getPitch();
  }

  renderer.render(scene, camera);

  if (frameSeconds > 0) {
    fpsCounter.update(1 / frameSeconds);
  }
  if (netClient && netClient.isOnline()) {
    const hud = netClient.getHud();
    const hitreg = netClient.getHitRegStats();
    fpsCounter.updateExtra([
      `rtt: ${hud.rttMs !== null ? hud.rttMs.toFixed(0) + "ms" : "--"}`,
      `snapshot age: ${hud.snapshotAgeMs.toFixed(0)}ms`,
      `corrections/s: ${hud.correctionsPerSecond.toFixed(1)}`,
      `interp starved frames: ${hud.starvedFrames}`,
      `hitreg agree: ${hitreg.agreementPercent.toFixed(1)}% (n=${hitreg.totalResolved})`,
    ]);
  } else {
    fpsCounter.updateExtra(["offline (single-player)"]);
  }
}

requestAnimationFrame((first) => {
  lastFrameTime = first;
  requestAnimationFrame(frame);
});

// Spawn the (stub) net-pump worker now so the plumbing exists ahead of a
// future move of network I/O off the main thread; it only posts a heartbeat
// today (see netpump.worker.ts) — deliberately unchanged/out of scope for
// M1 (spec: "netpump worker remains a stub").
const netWorker = new Worker(new URL("./netpump.worker.ts", import.meta.url), { type: "module" });
netWorker.onmessage = (e: MessageEvent) => {
  // eslint-disable-next-line no-console
  console.debug("[netpump]", e.data);
};
