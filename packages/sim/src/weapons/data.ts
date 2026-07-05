// Single source of truth for weapon tuning (the "weapons.json" of the plan,
// kept as a typed TS module so it's zero-dep and type-checked). Original
// names; each maps to a well-known Valorant weapon analog, noted in a
// comment only — mechanics/numbers are not copyrightable, names/art are, so
// the numbers below are baseline-approximated from published patch data
// where the spec gave concrete figures, and reasonably authored where it
// didn't (falloff bands beyond the spec's single named breakpoint, spray
// patterns, movement/ADS multipliers).
//
// Distances are meters, radians for angles, ticks at FIXED_DT (64 Hz).

import { sinApprox } from "../math.js";

export type WeaponSlot = "primary" | "secondary";

export interface DamageBand {
  /** Upper bound (inclusive) of this band's range, meters. The last band should be Infinity. */
  readonly maxDist: number;
  readonly head: number;
  readonly body: number;
  readonly legs: number;
}

export interface SprayOffset {
  readonly yaw: number;
  readonly pitch: number;
}

export interface WeaponDef {
  readonly id: number;
  readonly name: string;
  /** Which loadout slot this weapon occupies; sidearms are never dropped (see server pickup logic). */
  readonly slot: WeaponSlot;
  readonly price: number;
  readonly magSize: number;
  readonly reserveAmmo: number;
  readonly fireRateRps: number;
  readonly equipDelayTicks: number;
  readonly reloadTicks: number;
  /** Ordered ascending by maxDist; last entry's maxDist must be Infinity. */
  readonly damageBands: readonly DamageBand[];
  /** Fixed per-shot rise/weave offsets, indexed by sprayIndex. Length >= magSize for automatics. */
  readonly sprayPattern: readonly SprayOffset[];
  /** First-shot inaccuracy, standing still, radians. */
  readonly baseSpreadRad: number;
  /** Additional spread at full run speed (before crouch/air/ADS multipliers), radians. */
  readonly movementSpreadRad: number;
  readonly crouchSpreadMult: number;
  readonly airSpreadMult: number;
  readonly adsSpreadMult: number;
  readonly adsMoveSpeedMult: number;
  /** FOV zoom multiplier per ADS stage, e.g. [1.25] or Longbow's [2.5, 5]. */
  readonly adsZoomStages: readonly number[];
}

// Weapon ids, stable across the wire protocol. The sentinel "no weapon" id
// (255) lives in constants.ts as WEAPON_NONE — not redeclared here to keep a
// single source of truth.
export const WEAPON_VIPER = 0; // classic analog
export const WEAPON_MARSHAL6 = 1; // sheriff analog
export const WEAPON_WASP = 2; // spectre analog
export const WEAPON_FALCON = 3; // vandal analog
export const WEAPON_KESTREL = 4; // phantom analog
export const WEAPON_LONGBOW = 5; // operator analog

function autoSprayPattern(length: number, riseRad: number, weaveRad: number): SprayOffset[] {
  const pattern: SprayOffset[] = [];
  for (let i = 0; i < length; i++) {
    // Rises steadily for the first ~1/3 of the pattern, then weaves side to
    // side while continuing a shallower rise — an authored approximation of
    // rifle/SMG spray behavior, not a captured reference pattern.
    const riseFrac = Math.min(1, i / (length * 0.35));
    const pitch = riseRad * riseFrac;
    const weave = weaveRad * sinApprox(i * 0.9) * Math.min(1, i / 6);
    pattern.push({ yaw: weave, pitch });
  }
  return pattern;
}

function pistolSprayPattern(length: number, riseRad: number): SprayOffset[] {
  const pattern: SprayOffset[] = [];
  for (let i = 0; i < length; i++) {
    pattern.push({ yaw: 0, pitch: riseRad * Math.min(1, i / Math.max(1, length - 1)) });
  }
  return pattern;
}

const VIPER: WeaponDef = {
  id: WEAPON_VIPER,
  name: "Viper",
  slot: "secondary",
  price: 0,
  magSize: 12,
  reserveAmmo: 36,
  fireRateRps: 6.75,
  equipDelayTicks: 25,
  reloadTicks: 90,
  damageBands: [
    { maxDist: 30, head: 78, body: 26, legs: 22 },
    { maxDist: Infinity, head: 66, body: 22, legs: 18 },
  ],
  sprayPattern: pistolSprayPattern(12, 0.03),
  baseSpreadRad: 0.002,
  movementSpreadRad: 0.05,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.7,
  adsMoveSpeedMult: 0.76,
  adsZoomStages: [1.15],
};

const MARSHAL6: WeaponDef = {
  id: WEAPON_MARSHAL6,
  name: "Marshal-6",
  slot: "secondary",
  price: 800,
  magSize: 6,
  reserveAmmo: 18,
  fireRateRps: 4.0,
  equipDelayTicks: 28,
  reloadTicks: 100,
  damageBands: [
    { maxDist: 30, head: 159, body: 55, legs: 47 },
    { maxDist: Infinity, head: 145, body: 50, legs: 43 },
  ],
  sprayPattern: pistolSprayPattern(6, 0.02),
  baseSpreadRad: 0.0015,
  movementSpreadRad: 0.06,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.7,
  adsMoveSpeedMult: 0.76,
  adsZoomStages: [1.25],
};

const WASP: WeaponDef = {
  id: WEAPON_WASP,
  name: "Wasp",
  slot: "primary",
  price: 1600,
  magSize: 30,
  reserveAmmo: 90,
  fireRateRps: 13.85,
  equipDelayTicks: 43,
  reloadTicks: 140,
  damageBands: [
    { maxDist: 20, head: 78, body: 26, legs: 22 },
    { maxDist: Infinity, head: 66, body: 22, legs: 18 },
  ],
  sprayPattern: autoSprayPattern(30, 0.045, 0.02),
  baseSpreadRad: 0.005,
  movementSpreadRad: 0.09,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.7,
  adsMoveSpeedMult: 0.76,
  adsZoomStages: [1.25],
};

const FALCON: WeaponDef = {
  id: WEAPON_FALCON,
  name: "Falcon",
  slot: "primary",
  price: 2900,
  magSize: 25,
  reserveAmmo: 100,
  fireRateRps: 9.75,
  equipDelayTicks: 43,
  reloadTicks: 150,
  damageBands: [{ maxDist: Infinity, head: 160, body: 40, legs: 34 }],
  sprayPattern: autoSprayPattern(25, 0.06, 0.03),
  baseSpreadRad: 0.0008,
  movementSpreadRad: 0.08,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.7,
  adsMoveSpeedMult: 0.76,
  adsZoomStages: [1.25],
};

const KESTREL: WeaponDef = {
  id: WEAPON_KESTREL,
  name: "Kestrel",
  slot: "primary",
  price: 2900,
  magSize: 30,
  reserveAmmo: 90,
  fireRateRps: 11.0,
  equipDelayTicks: 43,
  reloadTicks: 150,
  damageBands: [
    { maxDist: 15, head: 156, body: 39, legs: 33 },
    { maxDist: Infinity, head: 140, body: 35, legs: 30 },
  ],
  sprayPattern: autoSprayPattern(30, 0.05, 0.025),
  baseSpreadRad: 0.0008,
  movementSpreadRad: 0.08,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.7,
  adsMoveSpeedMult: 0.76,
  adsZoomStages: [1.25],
};

const LONGBOW: WeaponDef = {
  id: WEAPON_LONGBOW,
  name: "Longbow",
  slot: "primary",
  price: 4700,
  magSize: 5,
  reserveAmmo: 10,
  fireRateRps: 0.6,
  equipDelayTicks: 57,
  reloadTicks: 180,
  damageBands: [{ maxDist: Infinity, head: 255, body: 150, legs: 120 }],
  sprayPattern: pistolSprayPattern(5, 0.015),
  baseSpreadRad: 0.0005,
  movementSpreadRad: 0.12,
  crouchSpreadMult: 0.6,
  airSpreadMult: 3.5,
  adsSpreadMult: 0.15,
  adsMoveSpeedMult: 0.5,
  adsZoomStages: [2.5, 5],
};

/** All weapons, indexable by id (array index === WeaponDef.id). */
export const WEAPONS: readonly WeaponDef[] = [VIPER, MARSHAL6, WASP, FALCON, KESTREL, LONGBOW];

export function getWeaponDef(id: number): WeaponDef | null {
  return WEAPONS[id] ?? null;
}

/** Damage for a hit at `distance` meters on `region`, per weapon's range-banded table. Pure, no globals. */
export function damageForHit(weapon: WeaponDef, distance: number, region: "head" | "body" | "legs"): number {
  for (const band of weapon.damageBands) {
    if (distance <= band.maxDist) {
      return band[region];
    }
  }
  const last = weapon.damageBands[weapon.damageBands.length - 1]!;
  return last[region];
}
