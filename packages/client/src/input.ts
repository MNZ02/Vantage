import type { InputFrame } from "@vg/sim";

const MOUSE_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.01;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let fireHeld = false;
let adsHeld = false;
let buyMenuOpen = false;
const buyKeyCallbacks: Array<(digit: number) => void> = [];
const buyMenuListeners: Array<(open: boolean) => void> = [];

function onMouseDown(e: MouseEvent): void {
  if (buyMenuOpen) return;
  if (e.button === 0) fireHeld = true;
  if (e.button === 2) adsHeld = true;
}

function onMouseUp(e: MouseEvent): void {
  if (e.button === 0) fireHeld = false;
  if (e.button === 2) adsHeld = false;
}

function onKeyDown(e: KeyboardEvent): void {
  keys.add(e.code);
  if (e.code === "KeyB") {
    setBuyMenuOpen(!buyMenuOpen);
  } else if (e.code === "Escape" && buyMenuOpen) {
    setBuyMenuOpen(false);
  }
  if (buyMenuOpen) {
    const digitMatch = /^Digit([1-8])$/.exec(e.code);
    if (digitMatch) {
      for (const cb of buyKeyCallbacks) cb(Number(digitMatch[1]));
    }
  }
}

function onKeyUp(e: KeyboardEvent): void {
  keys.delete(e.code);
}

/** Set by main.ts each frame from the active weapon's current ADS zoom stage (1 = hip fire). */
let sensitivityMultiplier = 1;
export function setLookSensitivityMultiplier(mult: number): void {
  sensitivityMultiplier = mult;
}

function onMouseMove(e: MouseEvent, canvas: HTMLCanvasElement): void {
  if (document.pointerLockElement !== canvas) return;
  yaw -= e.movementX * MOUSE_SENSITIVITY * sensitivityMultiplier;
  pitch -= e.movementY * MOUSE_SENSITIVITY * sensitivityMultiplier;
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

let lockedCanvas: HTMLCanvasElement | null = null;

/** Toggles the buy-menu-open flag; releases pointer lock while open, re-acquires it on close (see main.ts's DOM overlay). */
export function setBuyMenuOpen(open: boolean): void {
  buyMenuOpen = open;
  if (open) {
    fireHeld = false;
    adsHeld = false;
    if (document.pointerLockElement) document.exitPointerLock();
  } else if (lockedCanvas) {
    requestPointerLockWithFallback(lockedCanvas);
  }
  for (const cb of buyMenuListeners) cb(open);
}

export function onBuyMenuToggle(cb: (open: boolean) => void): void {
  buyMenuListeners.push(cb);
}

export function onBuyKeyPressed(cb: (digit: number) => void): void {
  buyKeyCallbacks.push(cb);
}

export function isBuyMenuOpen(): boolean {
  return buyMenuOpen;
}

export function setupInput(canvas: HTMLCanvasElement): void {
  lockedCanvas = canvas;
  canvas.addEventListener("click", () => {
    if (!buyMenuOpen) requestPointerLockWithFallback(canvas);
  });
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("keyup", onKeyUp);
  document.addEventListener("mousemove", (e) => onMouseMove(e, canvas));
  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("contextmenu", (e) => e.preventDefault()); // right-click drives ADS, not a context menu
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
  const inBuyMenu = buyMenuOpen;
  return {
    forward: inBuyMenu ? 0 : forward,
    right: inBuyMenu ? 0 : right,
    yaw,
    pitch,
    jump: !inBuyMenu && keys.has("Space"),
    crouch: !inBuyMenu && (keys.has("ControlLeft") || keys.has("ControlRight")),
    walk: !inBuyMenu && (keys.has("ShiftLeft") || keys.has("ShiftRight")),
    fire: !inBuyMenu && fireHeld,
    ads: !inBuyMenu && adsHeld,
    reload: !inBuyMenu && keys.has("KeyR"),
    slot1: !inBuyMenu && keys.has("Digit1"),
    slot2: !inBuyMenu && keys.has("Digit2"),
  };
}
