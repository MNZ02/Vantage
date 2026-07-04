import * as THREE from "three";
import { EYE_HEIGHT_CROUCH, EYE_HEIGHT_STAND, FIXED_DT, createState, tick, type SimState } from "@vg/sim";
import { buildInputFrame, getPitch, getYaw, setupInput } from "./input.js";
import { GRAYBOX_BOXES, SPAWN_POSITION } from "./graybox.js";
import {
  createFpsCounter,
  createHitFlashOverlay,
  createHitmarker,
  createRemotePlayerProxy,
  createScene,
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

let netClient: NetClient | null = null;
const remoteProxies = new Map<number, RemotePlayerProxy>();

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
    client.onHit(({ youAreShooter, youAreTarget }) => {
      if (youAreShooter) {
        hitmarker.show();
        // eslint-disable-next-line no-console
        console.log("[hit] confirmed hit");
      }
      if (youAreTarget) {
        hitFlash.flash();
      }
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
      continue;
    }
    if (!proxy) {
      proxy = createRemotePlayerProxy(scene);
      remoteProxies.set(i, proxy);
    }
    proxy.setPose(pose);
  }
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
  let fired = false;

  if (netClient && netClient.isOnline()) {
    while (accumulator >= FIXED_DT) {
      const input = buildInputFrame();
      netClient.sendInput(input);
      if (input.fire) {
        netClient.fire();
        fired = true;
      }
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
  } else if (offlineState && offlinePreviousState) {
    while (accumulator >= FIXED_DT) {
      offlinePreviousState = offlineState;
      const input = buildInputFrame();
      offlineState = tick(offlineState, [input], GRAYBOX_BOXES);
      accumulator -= FIXED_DT;
    }
    const alpha = accumulator / FIXED_DT;
    renderX = lerp(offlinePreviousState.posX[0]!, offlineState.posX[0]!, alpha);
    renderY = lerp(offlinePreviousState.posY[0]!, offlineState.posY[0]!, alpha);
    renderZ = lerp(offlinePreviousState.posZ[0]!, offlineState.posZ[0]!, alpha);
    eyeHeight = offlineState.crouching[0] === 1 ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;
  }

  camera.position.set(renderX, renderY + eyeHeight, renderZ);
  // Mouse look is applied every rendered frame (not gated to the fixed tick)
  // for the smoothest possible feel; only movement is fixed-timestep.
  // rotation.y = yaw + PI because Three's default camera forward is -Z while
  // the sim's yaw=0 forward direction is +Z (see input.ts / movement.ts).
  camera.rotation.order = "YXZ";
  camera.rotation.y = getYaw() + Math.PI;
  camera.rotation.x = getPitch();

  if (fired) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const from = camera.position.clone();
    const to = from.clone().addScaledVector(dir, 50);
    spawnTracer(scene, from, to, 100);
  }

  renderer.render(scene, camera);

  if (frameSeconds > 0) {
    fpsCounter.update(1 / frameSeconds);
  }
  if (netClient && netClient.isOnline()) {
    const hud = netClient.getHud();
    fpsCounter.updateExtra([
      `rtt: ${hud.rttMs !== null ? hud.rttMs.toFixed(0) + "ms" : "--"}`,
      `snapshot age: ${hud.snapshotAgeMs.toFixed(0)}ms`,
      `corrections/s: ${hud.correctionsPerSecond.toFixed(1)}`,
      `interp starved frames: ${hud.starvedFrames}`,
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
