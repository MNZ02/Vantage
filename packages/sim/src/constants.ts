// All tunable movement constants in one place (M0 spec: "tune in sim constants,
// exposed in one constants file").

export const FIXED_DT = 15.625 / 1000; // 64 Hz

export const MAX_PLAYERS = 16;

// Speeds, m/s.
export const RUN_SPEED = 6.75;
export const WALK_SPEED = 3.6;
export const CROUCH_SPEED = 3.4;

// Source-style ground movement.
export const GROUND_ACCEL = 14; // m/s^2 per m/s of wishSpeed headroom, tuned for snappy convergence
export const GROUND_FRICTION = 6; // 1/s
export const STOP_SPEED = 1.0; // m/s, below this friction uses a flat floor so players actually stop

// Air movement: minimal air control.
export const AIR_ACCEL = 2;
export const AIR_SPEED_CAP = 0.6; // fraction of wishSpeed reachable purely from air accel

export const GRAVITY = 18; // m/s^2
export const JUMP_APEX_HEIGHT = 0.9; // m
export const JUMP_SPEED = Math.sqrt(2 * GRAVITY * JUMP_APEX_HEIGHT);

// Capsule dimensions, meters.
export const CAPSULE_RADIUS = 0.4;
export const STAND_HEIGHT = 1.8;
export const CROUCH_HEIGHT = 1.3;
export const EYE_HEIGHT_STAND = 1.65;
export const EYE_HEIGHT_CROUCH = 1.15;

// Collision tolerances.
export const GROUND_PROBE_EPSILON = 0.05; // m, how far below feet counts as "grounded"
export const SKIN_WIDTH = 1e-4; // m, small separation kept after push-out to avoid re-penetration jitter

// Source-style grounded step-up: a box top at or below this height above the
// current feet, when grounded and otherwise blocked, is climbed automatically
// instead of treated as a wall (stairs, curbs, low ledges).
export const MAX_STEP_HEIGHT = 0.45;
