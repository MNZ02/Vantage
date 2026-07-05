import type { InputFrame } from "@vg/sim";

const MOUSE_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.01;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let fireHeld = false;
let adsHeld = false;
let buyMenuOpen = false;
/** M3: MMB casts a map ping (edge-triggered — see buildInputFrame()'s one-shot consume). */
let pingRequested = false;
const buyKeyCallbacks: Array<(digit: number) => void> = [];
const buyMenuListeners: Array<(open: boolean) => void> = [];

function onMouseDown(e: MouseEvent): void {
  if (buyMenuOpen) return;
  if (e.button === 0) fireHeld = true;
  if (e.button === 2) adsHeld = true;
  if (e.button === 1) pingRequested = true; // middle mouse button: cast a map ping
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
  } else if (e.code === "KeyZ" && !buyMenuOpen) {
    pingRequested = true; // Z: alternate map-ping key (see MMB in onMouseDown)
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

/**
 * M4a ability key layout (documented deviation from the spec's literal
 * "C/Q/E/X" suggestion): E is already bound to interact/plant/defuse (see
 * `interact` below), so abilities use C (basic1), Q (basic2), F (signature),
 * X (ult) — E stays interact everywhere, never double-bound.
 */
function abilityHeld(code: string): boolean {
  return !buyMenuOpen && keys.has(code);
}

/** Builds this instant's InputFrame for player 0 from held keys + current look yaw/pitch. */
export function buildInputFrame(): InputFrame {
  const forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const right = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const inBuyMenu = buyMenuOpen;
  // Edge-triggered: consumed once per call so a single click/tap sends
  // exactly one ping input frame with ping=true, not one per rendered frame
  // for as long as the mouse button happens to still be "down" in some
  // stale sense — there's no held state to accidentally re-read here since
  // onMouseUp never clears pingRequested; this call site is the only place
  // it's ever reset.
  const ping = !inBuyMenu && pingRequested;
  pingRequested = false;
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
    interact: !inBuyMenu && keys.has("KeyE"),
    ping,
    ability1: abilityHeld("KeyC"),
    ability2: abilityHeld("KeyQ"),
    signature: abilityHeld("KeyF"),
    ult: abilityHeld("KeyX"),
  };
}
