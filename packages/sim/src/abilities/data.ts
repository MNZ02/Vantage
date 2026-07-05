// Ability tuning table (the "abilities.json" of the plan), mirroring
// weapons/data.ts's style: a typed const, zero deps, original names with the
// Valorant analog noted only in a comment (mechanics aren't copyrightable;
// names/art are). Distances in meters, ticks at FIXED_DT (64 Hz).
//
// Every ability referenced here is heterogeneous enough (self-mobility vs.
// projectile vs. instant-AoE vs. cast-then-effect) that behavior lives in
// abilities/logic.ts as a per-ability-id switch, not a fully generic
// interpreter — this table only holds the tunable numbers.

import {
  ABILITY_SLOT_BASIC1,
  ABILITY_SLOT_BASIC2,
  ABILITY_SLOT_SIGNATURE,
  ABILITY_SLOT_ULT,
  AGENT_LUMEN,
  AGENT_SONAR,
  AGENT_UMBRA,
  AGENT_ZEPHYR,
} from "../constants.js";
import type { WeaponDef } from "../weapons/data.js";

// ---- Ability ids (stable across the wire protocol; also the array index
// into ABILITIES below). ----
export const ABL_ZEPHYR_UPDRAFT = 0;
export const ABL_ZEPHYR_GUST = 1;
export const ABL_ZEPHYR_DASH = 2;
export const ABL_ZEPHYR_BLADES = 3;
export const ABL_UMBRA_BLIND = 4;
export const ABL_UMBRA_STEP = 5;
export const ABL_UMBRA_SHROUD = 6;
export const ABL_UMBRA_VEIL = 7;
export const ABL_SONAR_SHOCK = 8;
export const ABL_SONAR_PULSE = 9;
export const ABL_SONAR_RECON = 10;
export const ABL_SONAR_RAIL = 11;
export const ABL_LUMEN_SLOW = 12;
export const ABL_LUMEN_WALL = 13;
export const ABL_LUMEN_MEND = 14;
export const ABL_LUMEN_RES = 15;
export const NUM_ABILITIES = 16;

/** agentId -> [basic1, basic2, signature, ult] ability ids. */
export const AGENT_ABILITIES: readonly (readonly [number, number, number, number])[] = [
  [ABL_ZEPHYR_UPDRAFT, ABL_ZEPHYR_GUST, ABL_ZEPHYR_DASH, ABL_ZEPHYR_BLADES],
  [ABL_UMBRA_BLIND, ABL_UMBRA_STEP, ABL_UMBRA_SHROUD, ABL_UMBRA_VEIL],
  [ABL_SONAR_SHOCK, ABL_SONAR_PULSE, ABL_SONAR_RECON, ABL_SONAR_RAIL],
  [ABL_LUMEN_SLOW, ABL_LUMEN_WALL, ABL_LUMEN_MEND, ABL_LUMEN_RES],
];

export function abilityIdForSlot(agentId: number, slot: number): number | null {
  const row = AGENT_ABILITIES[agentId];
  if (!row) return null;
  return row[slot] ?? null;
}

export type AbilityKind =
  | "instantSelfVelocity" // updraft
  | "selfDash" // dash / step (self-mobility, capsule-collision-stopped)
  | "projectile" // thrown arc that lands and transforms (gust/blind/shock/slowzone/recon/shroud)
  | "instantSelfAoeReveal" // pulse
  | "instantMultiSmoke" // veil
  | "instantWall" // wall
  | "instantHealCast" // mend
  | "castThenRevive" // resurrect
  | "ultWeapon"; // blades / rail (weapon-slot override, reuses gunplay pipeline)

export interface ProjectileParams {
  readonly speed: number; // m/s launch speed
  readonly radius: number; // landing-detection / effect radius, meters
  readonly maxFlightTicks: number; // safety fuse if it never finds a surface
}

export interface AbilityDef {
  readonly id: number;
  readonly agentId: number;
  readonly slot: number; // ABILITY_SLOT_*
  readonly name: string;
  readonly kind: AbilityKind;
  /** Basics + signature: charges purchasable/held. 0 for the ult (gated by ultPoints instead). */
  readonly maxCharges: number;
  /** Basics only; 0 for signature/ult (never buyable). */
  readonly price: number;
  /** Signature only: ticks to recharge ONE charge. 0 = doesn't auto-recharge (basics, ult, and Zephyr's kill-earned dash). */
  readonly rechargeTicks: number;
  /** Ticks between cast input and the effect resolving/firing. */
  readonly castDelayTicks: number;
  /** Ult only. */
  readonly ultCost: number;

  readonly projectile?: ProjectileParams;
  readonly radius?: number; // smoke/zone/reveal radius, meters
  readonly durationTicks?: number; // smoke/zone/wall/flash-window lifetime
  readonly damage?: number; // AoE center damage / rail flat damage
  readonly falloffRadius?: number; // AoE falloff distance (damage -> ~1 at this radius)
  readonly count?: number; // veil spheres / rail shots / wall segments
  readonly intervalTicks?: number; // recon pulse interval / rail between-shots interval
  readonly killsToRefresh?: number; // Zephyr dash: kills needed to re-earn a charge
  /** Ult weapons only (Blades/Rail): does a kill while active refill `count` charges? Spec: ONLY Blades does — Rail's 3-shot/15s window is a hard cap, not refreshable by kills. */
  readonly refreshOnKill?: boolean;
  readonly distance?: number; // dash/step travel distance, meters
  readonly healAmount?: number; // mend total HP
  readonly healDurationTicks?: number; // mend total duration
  readonly healChunkTicks?: number; // mend: ticks between chunks
  readonly healChunkAmount?: number; // mend: HP per chunk
  readonly castThenEffectTicks?: number; // resurrect: cast-to-revive delay
  readonly reviveHp?: number;
  readonly reviveRangeM?: number; // resurrect: max distance to target body
  readonly mendRangeM?: number;
}

const S = 64; // ticks per second, for readable authoring below

export const ABILITIES: readonly AbilityDef[] = [
  // ---- Zephyr (Duelist) ----
  {
    id: ABL_ZEPHYR_UPDRAFT,
    agentId: AGENT_ZEPHYR,
    slot: ABILITY_SLOT_BASIC1,
    name: "Updraft",
    kind: "instantSelfVelocity",
    maxCharges: 2,
    price: 150,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    distance: 9, // vertical launch speed, m/s
  },
  {
    id: ABL_ZEPHYR_GUST,
    agentId: AGENT_ZEPHYR,
    slot: ABILITY_SLOT_BASIC2,
    name: "Gust",
    kind: "projectile",
    maxCharges: 2,
    price: 100,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 20, radius: 0.3, maxFlightTicks: 3 * S },
    radius: 2.5, // spawned smoke radius
    durationTicks: 7 * S,
  },
  {
    id: ABL_ZEPHYR_DASH,
    agentId: AGENT_ZEPHYR,
    slot: ABILITY_SLOT_SIGNATURE,
    name: "Dash",
    kind: "selfDash",
    maxCharges: 1,
    price: 0,
    rechargeTicks: 0, // re-earned by kills, not time (see killsToRefresh)
    castDelayTicks: 0,
    ultCost: 0,
    distance: 8,
    killsToRefresh: 2,
  },
  {
    id: ABL_ZEPHYR_BLADES,
    agentId: AGENT_ZEPHYR,
    slot: ABILITY_SLOT_ULT,
    name: "Blades",
    kind: "ultWeapon",
    maxCharges: 0,
    price: 0,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 7,
    count: 5, // starting/refresh-on-kill charge count
    refreshOnKill: true,
  },

  // ---- Umbra (Controller) ----
  {
    id: ABL_UMBRA_BLIND,
    agentId: AGENT_UMBRA,
    slot: ABILITY_SLOT_BASIC1,
    name: "Blind Orb",
    kind: "projectile",
    maxCharges: 2,
    price: 250,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 16, radius: 0.3, maxFlightTicks: 3 * S },
    durationTicks: Math.round(0.5 * S), // fuse after landing before it flashes
  },
  {
    id: ABL_UMBRA_STEP,
    agentId: AGENT_UMBRA,
    slot: ABILITY_SLOT_BASIC2,
    name: "Step",
    kind: "selfDash",
    maxCharges: 1,
    price: 100,
    rechargeTicks: 0,
    castDelayTicks: Math.round(0.5 * S),
    ultCost: 0,
    distance: 12,
  },
  {
    id: ABL_UMBRA_SHROUD,
    agentId: AGENT_UMBRA,
    slot: ABILITY_SLOT_SIGNATURE,
    name: "Shroud",
    kind: "projectile",
    maxCharges: 2,
    price: 0,
    rechargeTicks: 30 * S,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 24, radius: 0.3, maxFlightTicks: 3 * S },
    radius: 4,
    durationTicks: 15 * S,
  },
  {
    id: ABL_UMBRA_VEIL,
    agentId: AGENT_UMBRA,
    slot: ABILITY_SLOT_ULT,
    name: "Veil",
    kind: "instantMultiSmoke",
    maxCharges: 0,
    price: 0,
    rechargeTicks: 0,
    castDelayTicks: Math.round(0.75 * S),
    ultCost: 7,
    radius: 6,
    durationTicks: 15 * S,
    count: 5,
    distance: 20, // placement distance in front of caster
  },

  // ---- Sonar (Initiator) ----
  {
    id: ABL_SONAR_SHOCK,
    agentId: AGENT_SONAR,
    slot: ABILITY_SLOT_BASIC1,
    name: "Shock Dart",
    kind: "projectile",
    maxCharges: 2,
    price: 150,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 22, radius: 0.3, maxFlightTicks: 3 * S },
    damage: 90,
    falloffRadius: 5,
  },
  {
    id: ABL_SONAR_PULSE,
    agentId: AGENT_SONAR,
    slot: ABILITY_SLOT_BASIC2,
    name: "Pulse",
    kind: "instantSelfAoeReveal",
    maxCharges: 1,
    price: 200,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    radius: 12,
    durationTicks: 2 * S,
  },
  {
    id: ABL_SONAR_RECON,
    agentId: AGENT_SONAR,
    slot: ABILITY_SLOT_SIGNATURE,
    name: "Recon Dart",
    kind: "projectile",
    maxCharges: 1,
    price: 0,
    rechargeTicks: 40 * S,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 22, radius: 0.3, maxFlightTicks: 3 * S },
    radius: 30, // reveal radius, LoS-gated
    durationTicks: 2 * S, // each individual pulse's reveal duration
    count: 3, // number of pulses
    intervalTicks: Math.round(1.25 * S),
  },
  {
    id: ABL_SONAR_RAIL,
    agentId: AGENT_SONAR,
    slot: ABILITY_SLOT_ULT,
    name: "Rail",
    kind: "ultWeapon",
    maxCharges: 0,
    price: 0,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 8,
    count: 3, // shots
    durationTicks: 15 * S, // activation window
    intervalTicks: Math.round(1.2 * S), // min ticks between shots
    damage: 80,
  },

  // ---- Lumen (Sentinel) ----
  {
    id: ABL_LUMEN_SLOW,
    agentId: AGENT_LUMEN,
    slot: ABILITY_SLOT_BASIC1,
    name: "Slow Zone",
    kind: "projectile",
    maxCharges: 2,
    price: 200,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 0,
    projectile: { speed: 18, radius: 0.3, maxFlightTicks: 3 * S },
    radius: 4,
    durationTicks: 4 * S,
  },
  {
    id: ABL_LUMEN_WALL,
    agentId: AGENT_LUMEN,
    slot: ABILITY_SLOT_BASIC2,
    name: "Wall",
    kind: "instantWall",
    maxCharges: 1,
    price: 400,
    rechargeTicks: 0,
    castDelayTicks: Math.round(0.4 * S),
    ultCost: 0,
    count: 3, // segments
    distance: 5, // placement distance in front of caster
    durationTicks: 30 * S,
  },
  {
    id: ABL_LUMEN_MEND,
    agentId: AGENT_LUMEN,
    slot: ABILITY_SLOT_SIGNATURE,
    name: "Mend",
    kind: "instantHealCast",
    maxCharges: 1,
    price: 0,
    rechargeTicks: 45 * S,
    castDelayTicks: 0,
    ultCost: 0,
    healAmount: 60,
    healDurationTicks: 5 * S,
    healChunkTicks: 16, // 0.25s
    healChunkAmount: 3, // 20 chunks * 3 = 60
    mendRangeM: 20,
  },
  {
    id: ABL_LUMEN_RES,
    agentId: AGENT_LUMEN,
    slot: ABILITY_SLOT_ULT,
    name: "Resurrect",
    kind: "castThenRevive",
    maxCharges: 0,
    price: 0,
    rechargeTicks: 0,
    castDelayTicks: 0,
    ultCost: 8,
    castThenEffectTicks: Math.round(1.3 * S),
    reviveHp: 100,
    reviveRangeM: 5,
  },
];

export function getAbilityDef(id: number): AbilityDef | null {
  return ABILITIES[id] ?? null;
}

// ---- Ult "weapon" combat defs (Blades / Rail): reuse the existing gunplay
// pipeline (ShotEvent -> raycastPlayers -> damageForHit -> applyDamage) by
// presenting these as ordinary WeaponDefs at a combat-only id space
// (100 + abilityId), resolved via weapons/logic.ts's getCombatWeaponDef —
// NEVER merged into weapons/data.ts's WEAPONS array, so applyBuy's normal
// shop path (which only ever sees WEAPONS[0..5]) can't accidentally "sell"
// them. equipDelayTicks/reloadTicks are unused (no reload path for these).
export const ABILITY_WEAPON_ID_BASE = 100;

export function abilityWeaponId(abilityId: number): number {
  return ABILITY_WEAPON_ID_BASE + abilityId;
}

const BLADES_WEAPON: WeaponDef = {
  id: abilityWeaponId(ABL_ZEPHYR_BLADES),
  name: "Zephyr Blades",
  slot: "primary",
  price: 0,
  magSize: 5,
  reserveAmmo: 0,
  fireRateRps: 2,
  equipDelayTicks: 0,
  reloadTicks: 0,
  damageBands: [{ maxDist: Infinity, head: 150, body: 50, legs: 50 }],
  sprayPattern: [{ yaw: 0, pitch: 0 }],
  baseSpreadRad: 0,
  movementSpreadRad: 0,
  crouchSpreadMult: 1,
  airSpreadMult: 1,
  adsSpreadMult: 1,
  adsMoveSpeedMult: 1,
  adsZoomStages: [],
};

const RAIL_WEAPON: WeaponDef = {
  id: abilityWeaponId(ABL_SONAR_RAIL),
  name: "Sonar Rail",
  slot: "primary",
  price: 0,
  magSize: 3,
  reserveAmmo: 0,
  fireRateRps: 1 / 1.2,
  equipDelayTicks: 0,
  reloadTicks: 0,
  damageBands: [{ maxDist: Infinity, head: 80, body: 80, legs: 80 }],
  sprayPattern: [{ yaw: 0, pitch: 0 }],
  baseSpreadRad: 0,
  movementSpreadRad: 0,
  crouchSpreadMult: 1,
  airSpreadMult: 1,
  adsSpreadMult: 1,
  adsMoveSpeedMult: 1,
  adsZoomStages: [],
  // Not part of the base WeaponDef shape (see ABILITY_PENETRATES_WALLS below) —
  // Rail's "hitscan through walls" is a combat-resolution rule at the server
  // boundary, not a sim-level movement/collision concept.
};

/** Combat-only weapon defs for ult-weapon abilities, keyed by ABILITY_WEAPON_ID_BASE + abilityId. Never in weapons/data.ts's WEAPONS[]. */
export const ABILITY_WEAPONS: Readonly<Record<number, WeaponDef>> = {
  [BLADES_WEAPON.id]: BLADES_WEAPON,
  [RAIL_WEAPON.id]: RAIL_WEAPON,
};

/** Weapon ids (combat space) whose shots ignore wall occlusion entirely (Sonar's Rail ult). Server's resolveShot consults this. */
export const ABILITY_PENETRATES_WALLS: ReadonlySet<number> = new Set([RAIL_WEAPON.id]);
