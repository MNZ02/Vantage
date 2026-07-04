import {
  EYE_HEIGHT_CROUCH,
  EYE_HEIGHT_STAND,
  FIXED_DT,
  createState,
  tick,
  type SimState,
} from "@vg/sim";
import { buildInputFrame, getPitch, getYaw, setupInput } from "./input.js";
import { GRAYBOX_BOXES, SPAWN_POSITION } from "./graybox.js";
import { createFpsCounter, createScene, buildGrayboxMeshes } from "./render.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
setupInput(canvas);

const { renderer, scene, camera } = createScene(canvas);
buildGrayboxMeshes(scene, GRAYBOX_BOXES);
const fpsCounter = createFpsCounter();

// Client is allowed wall-clock/random APIs (only sim/src is banned from them);
// the sim itself only ever sees the pure (state, inputs, boxes) it's given.
let state: SimState = createState(Date.now() >>> 0, 1);
state.posX[0] = SPAWN_POSITION.x;
state.posY[0] = SPAWN_POSITION.y;
state.posZ[0] = SPAWN_POSITION.z;

let previousState: SimState = state;

// Fixed-timestep accumulator: the sim always advances in whole FIXED_DT steps,
// independent of the render frame rate; the frame itself is drawn by linearly
// interpolating between the previous and current sim states.
let accumulator = 0;
let lastFrameTime = performance.now();

const MAX_FRAME_TIME = 0.25; // clamp to avoid a "spiral of death" after a stall (tab backgrounding, breakpoints, etc.)

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function frame(now: number): void {
  requestAnimationFrame(frame);

  let frameSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (frameSeconds > MAX_FRAME_TIME) frameSeconds = MAX_FRAME_TIME;
  if (frameSeconds < 0) frameSeconds = 0;

  accumulator += frameSeconds;

  while (accumulator >= FIXED_DT) {
    previousState = state;
    const input = buildInputFrame();
    state = tick(state, [input], GRAYBOX_BOXES);
    accumulator -= FIXED_DT;
  }

  const alpha = accumulator / FIXED_DT;
  const posX = lerp(previousState.posX[0]!, state.posX[0]!, alpha);
  const posY = lerp(previousState.posY[0]!, state.posY[0]!, alpha);
  const posZ = lerp(previousState.posZ[0]!, state.posZ[0]!, alpha);
  const eyeHeight = state.crouching[0] === 1 ? EYE_HEIGHT_CROUCH : EYE_HEIGHT_STAND;

  camera.position.set(posX, posY + eyeHeight, posZ);
  // Mouse look is applied every rendered frame (not gated to the fixed tick)
  // for the smoothest possible feel; only movement is fixed-timestep.
  // rotation.y = yaw + PI because Three's default camera forward is -Z while
  // the sim's yaw=0 forward direction is +Z (see input.ts / movement.ts).
  camera.rotation.order = "YXZ";
  camera.rotation.y = getYaw() + Math.PI;
  camera.rotation.x = getPitch();

  renderer.render(scene, camera);

  if (frameSeconds > 0) {
    fpsCounter.update(1 / frameSeconds);
  }
}

requestAnimationFrame((first) => {
  lastFrameTime = first;
  requestAnimationFrame(frame);
});

// Spawn the (stub) net-pump worker now so the plumbing exists ahead of M1's
// real transport; it only posts a heartbeat today.
const netWorker = new Worker(new URL("./netpump.worker.ts", import.meta.url), { type: "module" });
netWorker.onmessage = (e: MessageEvent) => {
  // eslint-disable-next-line no-console
  console.debug("[netpump]", e.data);
};
