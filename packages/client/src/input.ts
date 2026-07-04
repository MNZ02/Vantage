import type { InputFrame } from "@vg/sim";

const MOUSE_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.01;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let firePending = false;

function onMouseDown(e: MouseEvent): void {
  if (e.button === 0) firePending = true;
}

function onKeyDown(e: KeyboardEvent): void {
  keys.add(e.code);
}

function onKeyUp(e: KeyboardEvent): void {
  keys.delete(e.code);
}

function onMouseMove(e: MouseEvent, canvas: HTMLCanvasElement): void {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * MOUSE_SENSITIVITY;
  pitch -= e.movementY * MOUSE_SENSITIVITY;
  pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
}

/** Requests pointer lock with `unadjustedMovement`, falling back to plain pointer lock
 * on browsers/situations that reject the option (Safari, some non-primary-mouse cases). */
function requestPointerLockWithFallback(canvas: HTMLCanvasElement): void {
  type LockOptions = { unadjustedMovement?: boolean };
  type LockableCanvas = HTMLCanvasElement & {
    requestPointerLock: (options?: LockOptions) => Promise<void> | void;
  };
  const lockable = canvas as LockableCanvas;
  try {
    const result = lockable.requestPointerLock({ unadjustedMovement: true });
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {
        canvas.requestPointerLock();
      });
    }
  } catch {
    canvas.requestPointerLock();
  }
}

export function setupInput(canvas: HTMLCanvasElement): void {
  canvas.addEventListener("click", () => requestPointerLockWithFallback(canvas));
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("mousemove", (e) => onMouseMove(e, canvas));
  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("pointerlockerror", () => {
    // eslint-disable-next-line no-console
    console.warn("Pointer lock request failed");
  });
}

export function getYaw(): number {
  return yaw;
}

export function getPitch(): number {
  return pitch;
}

/** Builds this instant's InputFrame for player 0 from held keys + current look yaw/pitch. */
export function buildInputFrame(): InputFrame {
  const forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const right = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const fire = firePending;
  firePending = false;
  return {
    forward,
    right,
    yaw,
    pitch,
    jump: keys.has("Space"),
    crouch: keys.has("ControlLeft") || keys.has("ControlRight"),
    walk: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    fire,
  };
}
