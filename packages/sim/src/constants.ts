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

// ---- M2 gunplay constants (global, weapon-independent; see weapons/data.ts
// for per-weapon tunables). ----

/**
 * Counter-strafe deadzone: fraction of RUN_SPEED below which movement
 * contributes NO extra spread (accuracy is back to standing-still). Below
 * this, ground speed is decelerating/tapped-opposite fast enough that
 * "first bullet accuracy" is restored — this is what makes counter-strafing
 * (tap the opposite direction to stop instantly) meaningfully better than
 * just releasing keys and coasting to a stop via friction. Above the
 * deadzone, movement spread ramps linearly up to full at 100% run speed.
 */
export const COUNTER_STRAFE_DEADZONE = 0.3;

/** Spawn/full health, hit points. */
export const SPAWN_HEALTH = 100;

/** Fraction of incoming damage armor (shields) absorbs until depleted (Valorant model). */
export const ARMOR_ABSORB_RATE = 0.66;
export const ARMOR_LIGHT = 25;
export const ARMOR_LIGHT_PRICE = 400;
export const ARMOR_HEAVY = 50;
export const ARMOR_HEAVY_PRICE = 1000;

/** Movement-speed multiplier applied while tagged (hit recently), and how long it lasts, in ticks. */
export const TAG_MULT = 0.4;
export const TAG_TICKS = 32; // 0.5s @ 64Hz

/** Ticks of airborne-class weapon spread applied after landing from a jump. */
export const LAND_PENALTY_TICKS = 16;

/** Ticks of continuous no-fire before spray index recovers to 0. */
export const SPRAY_RESET_TICKS = 8;

/** Ticks between death and DM respawn (3s @ 64Hz). */
export const RESPAWN_TICKS = 192;

/** Region boundaries on the player capsule, as fractions/absolute meters of capsule height. */
export const LEG_REGION_HEIGHT_FRACTION = 0.45; // below this fraction of height = legs
export const HEAD_REGION_HEIGHT_M = 0.3; // top this many meters of the capsule = head

/** Economy. */
export const START_CREDITS = 800;
export const MAX_CREDITS = 9000;
export const KILL_REWARD = 200;
export const ASSIST_WINDOW_TICKS = 192; // 3s @ 64Hz, last-damager assist eligibility

/** Dropped-weapon world entities. */
export const MAX_DROPPED_WEAPONS = 32;
export const DROP_DESPAWN_TICKS = 1920; // 30s @ 64Hz
export const PICKUP_RADIUS_M = 0.8;

/** Sidearm/armor buy item ids (weapon ids double as buy item ids; these two are armor-only). */
export const BUY_ITEM_LIGHT_ARMOR = 200;
export const BUY_ITEM_HEAVY_ARMOR = 201;

/** Sentinel weapon id meaning "no weapon equipped in this slot". */
export const WEAPON_NONE = 255;
