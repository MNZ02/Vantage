// Own math kernel for the sim package.
//
// Constraint (see PLAN.md determinism decision / M0 spec): sim/src must not call
// the trig/inverse-trig/random members of the built-in Math object, or reach for
// wall-clock APIs — those are implementation-defined or non-deterministic across
// JS engines, which would break server/client (and cross-browser) determinism.
// sqrt/abs/min/max/floor/hypot on that same object are IEEE-754 deterministic
// and are used freely below.

export const PI = 3.14159265358979323846;
const TWO_PI = 2 * PI;
const HALF_PI = PI / 2;
const QUARTER_PI = PI / 4;
const THREE_QUARTER_PI = 3 * QUARTER_PI;

/** Wrap an arbitrary angle (radians) into (-PI, PI]. */
function wrapToPi(x: number): number {
  return x - TWO_PI * Math.floor((x + PI) / TWO_PI);
}

// Taylor series around 0, accurate to ~1e-12 for |r| <= PI/4.
function sinTaylor(r: number): number {
  const r2 = r * r;
  let term = r;
  let sum = r;
  term *= -r2 / (2 * 3);
  sum += term;
  term *= -r2 / (4 * 5);
  sum += term;
  term *= -r2 / (6 * 7);
  sum += term;
  term *= -r2 / (8 * 9);
  sum += term;
  term *= -r2 / (10 * 11);
  sum += term;
  return sum;
}

function cosTaylor(r: number): number {
  const r2 = r * r;
  let term = 1;
  let sum = 1;
  term *= -r2 / (1 * 2);
  sum += term;
  term *= -r2 / (3 * 4);
  sum += term;
  term *= -r2 / (5 * 6);
  sum += term;
  term *= -r2 / (7 * 8);
  sum += term;
  term *= -r2 / (9 * 10);
  sum += term;
  return sum;
}

/** Quadrant-reduced (sin, cos) pair, each accurate to ~1e-10 for any finite input. */
function sinCosApprox(x: number): { s: number; c: number } {
  const w = wrapToPi(x); // (-PI, PI]
  if (w >= -QUARTER_PI && w <= QUARTER_PI) {
    return { s: sinTaylor(w), c: cosTaylor(w) };
  }
  if (w > QUARTER_PI && w <= THREE_QUARTER_PI) {
    const r = w - HALF_PI; // in [-PI/4, PI/4]
    return { s: cosTaylor(r), c: -sinTaylor(r) };
  }
  if (w < -QUARTER_PI && w >= -THREE_QUARTER_PI) {
    const r = w + HALF_PI;
    return { s: -cosTaylor(r), c: sinTaylor(r) };
  }
  // remaining range: (THREE_QUARTER_PI, PI] or [-PI, -THREE_QUARTER_PI)
  const r = w > 0 ? w - PI : w + PI; // in [-PI/4, PI/4]
  return { s: -sinTaylor(r), c: -cosTaylor(r) };
}

export function sinApprox(x: number): number {
  return sinCosApprox(x).s;
}

export function cosApprox(x: number): number {
  return sinCosApprox(x).c;
}

// 32-bit multiply without relying on Math.imul (kept out of the allowed-Math list).
function imul32(a: number, b: number): number {
  const aHi = (a >>> 16) & 0xffff;
  const aLo = a & 0xffff;
  const bHi = (b >>> 16) & 0xffff;
  const bLo = b & 0xffff;
  return (aLo * bLo + (((aHi * bLo + aLo * bHi) << 16) >>> 0)) | 0;
}

// atan(r) via Taylor series, accurate for small |r| (used after half-angle reduction).
function atanTaylor(r: number): number {
  const r2 = r * r;
  return (
    r *
    (1 +
      r2 *
        (-1 / 3 +
          r2 * (1 / 5 + r2 * (-1 / 7 + r2 * (1 / 9 - r2 / 11)))))
  );
}

// atan(x) for x >= 0 via repeated half-angle reduction (atan(x) = 2*atan(x/(1+sqrt(1+x^2))))
// until the residual is small enough for the Taylor series above to be accurate to ~1e-9.
function atanNonNegative(x: number): number {
  let r = x;
  let scale = 1;
  for (let i = 0; i < 3; i++) {
    r = r / (1 + Math.sqrt(1 + r * r));
    scale *= 2;
  }
  return scale * atanTaylor(r);
}

function atanApprox(x: number): number {
  return x >= 0 ? atanNonNegative(x) : -atanNonNegative(-x);
}

/** Own atan2 replacement, accurate to ~1e-6 across the full plane (same sign/quadrant conventions as the banned built-in). */
export function atan2Approx(y: number, x: number): number {
  if (x > 0) {
    return atanApprox(y / x);
  }
  if (x < 0) {
    return y >= 0 ? atanApprox(y / x) + PI : atanApprox(y / x) - PI;
  }
  // x === 0
  if (y > 0) return HALF_PI;
  if (y < 0) return -HALF_PI;
  return 0;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scaleVec3(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthVec3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function length2D(x: number, z: number): number {
  return Math.hypot(x, z);
}

export function normalizeVec3(a: Vec3): Vec3 {
  const len = lengthVec3(a);
  if (len < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export { imul32 };
