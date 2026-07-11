import type { InputFrame } from "@vg/sim";

const MOUSE_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.01;

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let fireHeld = false;
let adsHeld = false;
let buyMenuOpen = false;
// The match controller enables the buy menu only while the authoritative
// state is in PHASE_BUY. Keeping this separate from `buyMenuOpen` prevents B
// from opening a stale shop during waiting/round-end/match-end snapshots.
let buyMenuAvailable = false;
// Settings, agent select, and future modal surfaces share gameplay-input
// suppression. Track owners independently so closing one overlay cannot
// accidentally re-lock the pointer while another overlay remains open.
const interfaceOverlaySources = new Set<string>();
/** M3: MMB casts a map ping (edge-triggered — see buildInputFrame()'s one-shot consume). */
let pingRequested = false;
const buyKeyCallbacks: Array<(digit: number) => void> = [];
const buyMenuListeners: Array<(open: boolean) => void> = [];

function onMouseDown(e: MouseEvent): void {
  if (buyMenuOpen || isInterfaceOverlayOpen()) return;
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
    if (!e.repeat && buyMenuAvailable) setBuyMenuOpen(!buyMenuOpen);
  } else if (e.code === "Escape" && buyMenuOpen) {
    setBuyMenuOpen(false);
  } else if (e.code === "KeyZ" && !buyMenuOpen && !isInterfaceOverlayOpen()) {
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
  const nextOpen = open && buyMenuAvailable && !isInterfaceOverlayOpen();
  if (buyMenuOpen === nextOpen) return;
  buyMenuOpen = nextOpen;
  if (nextOpen) {
    fireHeld = false;
    adsHeld = false;
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
  } else if (lockedCanvas && !isInterfaceOverlayOpen()) {
    requestPointerLockWithFallback(lockedCanvas);
  }
  for (const cb of buyMenuListeners) cb(nextOpen);
}

/**
 * Enables/disables opening the buy menu from authoritative match state.
 * Disabling immediately closes an already-open menu so phase transitions can
 * never leave a stale modal intercepting input.
 */
export function setBuyMenuAvailable(available: boolean): void {
  buyMenuAvailable = available;
  if (!available && buyMenuOpen) setBuyMenuOpen(false);
}

/** Suppresses gameplay while a named non-buy modal owns the interface. */
export function setInterfaceOverlayOpen(open: boolean, source = "default"): void {
  const wasOpen = isInterfaceOverlayOpen();
  if (open) interfaceOverlaySources.add(source);
  else interfaceOverlaySources.delete(source);
  const nowOpen = isInterfaceOverlayOpen();
  if (wasOpen === nowOpen) return;
  fireHeld = false;
  adsHeld = false;
  if (nowOpen) {
    if (buyMenuOpen) setBuyMenuOpen(false);
    if (typeof document !== "undefined" && document.pointerLockElement) document.exitPointerLock();
  } else if (lockedCanvas && !buyMenuOpen) {
    requestPointerLockWithFallback(lockedCanvas);
  }
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

/** Exposed for HUD/tests; authoritative match state owns this flag. */
export function isBuyMenuAvailable(): boolean {
  return buyMenuAvailable;
}

export function isInterfaceOverlayOpen(): boolean {
  return interfaceOverlaySources.size > 0;
}

export function setupInput(canvas: HTMLCanvasElement): void {
  lockedCanvas = canvas;
  canvas.addEventListener("click", () => {
    if (!buyMenuOpen && !isInterfaceOverlayOpen()) requestPointerLockWithFallback(canvas);
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

/** Synchronises client-side mouse look to an authoritative spawn direction. */
export function setLookAngles(nextYaw: number, nextPitch: number): void {
  if (Number.isFinite(nextYaw)) yaw = nextYaw;
  if (Number.isFinite(nextPitch)) pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, nextPitch));
}

/**
 * M4a ability key layout (documented deviation from the spec's literal
 * "C/Q/E/X" suggestion): E is already bound to interact/plant/defuse (see
 * `interact` below), so abilities use C (basic1), Q (basic2), F (signature),
 * X (ult) — E stays interact everywhere, never double-bound.
 */
function abilityHeld(code: string): boolean {
  return !buyMenuOpen && !isInterfaceOverlayOpen() && keys.has(code);
}

/** Builds this instant's InputFrame for player 0 from held keys + current look yaw/pitch. */
export function buildInputFrame(): InputFrame {
  const forward = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
  const right = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
  const inputSuppressed = buyMenuOpen || isInterfaceOverlayOpen();
  // Edge-triggered: consumed once per call so a single click/tap sends
  // exactly one ping input frame with ping=true, not one per rendered frame
  // for as long as the mouse button happens to still be "down" in some
  // stale sense — there's no held state to accidentally re-read here since
  // onMouseUp never clears pingRequested; this call site is the only place
  // it's ever reset.
  const ping = !inputSuppressed && pingRequested;
  pingRequested = false;
  return {
    forward: inputSuppressed ? 0 : forward,
    right: inputSuppressed ? 0 : right,
    yaw,
    pitch,
    jump: !inputSuppressed && keys.has("Space"),
    crouch: !inputSuppressed && (keys.has("ControlLeft") || keys.has("ControlRight")),
    walk: !inputSuppressed && (keys.has("ShiftLeft") || keys.has("ShiftRight")),
    fire: !inputSuppressed && fireHeld,
    ads: !inputSuppressed && adsHeld,
    reload: !inputSuppressed && keys.has("KeyR"),
    slot1: !inputSuppressed && keys.has("Digit1"),
    slot2: !inputSuppressed && keys.has("Digit2"),
    interact: !inputSuppressed && keys.has("KeyE"),
    ping,
    ability1: abilityHeld("KeyC"),
    ability2: abilityHeld("KeyQ"),
    signature: abilityHeld("KeyF"),
    ult: abilityHeld("KeyX"),
  };
}
