// Damage/armor/tag application — the ONE documented mutation boundary for
// combat outcomes. These are pure functions (clone-in/clone-out, same shape
// as tick()) but they are deliberately NOT called from inside tick(): hit
// resolution requires lag-compensated rewind + raycasting against a
// per-shooter-client view of the world, which is server-only state (the
// ring buffer of past states). The server calls these between ticks, after
// resolving each tick's returned ShotEvents against its ring buffer (see
// packages/server/src/serverHost.ts). The client never calls these — it
// only predicts cosmetic "did my raycast say I hit" feedback, never applies
// damage locally (see PLAN.md §3.2 hit feedback policy).
import { ARMOR_HEAVY, ARMOR_HEAVY_PRICE, ARMOR_LIGHT, ARMOR_LIGHT_PRICE, ARMOR_ABSORB_RATE, BUY_ITEM_HEAVY_ARMOR, BUY_ITEM_LIGHT_ARMOR, MAX_CREDITS, TAG_TICKS } from "./constants.js";
import { scheduleDeath } from "./weapons/logic.js";
import { cloneState, type SimState } from "./state.js";
import { getWeaponDef } from "./weapons/data.js";

/**
 * Applies `damage` to `targetIndex`, respecting the 66/34 armor/health split
 * (armor absorbs up to 66% of each hit until depleted; the rest always goes
 * to health), clamped so neither goes negative. Sets alive=0 + schedules a
 * respawn if health reaches 0. No-op if the target is already dead. Pure:
 * returns a new state, never mutates `state`.
 */
export function applyDamage(state: SimState, targetIndex: number, damage: number): SimState {
  const next = cloneState(state);
  if (next.alive[targetIndex] === 0) return next;

  const armor = next.armor[targetIndex]!;
  const armorAbsorbed = Math.min(armor, damage * ARMOR_ABSORB_RATE);
  const healthLoss = damage - armorAbsorbed;

  next.armor[targetIndex] = Math.max(0, armor - armorAbsorbed);
  const newHealth = Math.max(0, next.health[targetIndex]! - healthLoss);
  next.health[targetIndex] = newHealth;

  if (newHealth <= 0) {
    scheduleDeath(next, targetIndex, state.tick);
  }
  return next;
}

/** Refreshes the tag (movement-slow) window on `targetIndex` to full duration. Pure. */
export function applyTag(state: SimState, targetIndex: number): SimState {
  const next = cloneState(state);
  if (next.alive[targetIndex] === 0) return next;
  next.tagTicksLeft[targetIndex] = TAG_TICKS;
  return next;
}

/**
 * Applies a BuyCmd for `playerIndex`: a weapon id (0..5) grants that weapon
 * into its slot (primary/secondary, per WeaponDef.slot) with a full mag +
 * reserve; BUY_ITEM_LIGHT_ARMOR/BUY_ITEM_HEAVY_ARMOR set armor to 25/50
 * (never stacking above — buying light after heavy doesn't downgrade, and
 * buying either twice doesn't exceed its own value). No-op (returns an
 * unchanged clone) if the player is dead, credits are insufficient, or
 * `itemId` doesn't name a known weapon/armor item. Pure: called by the
 * server between ticks, same mutation-boundary shape as applyDamage/applyTag.
 */
export function applyBuy(state: SimState, playerIndex: number, itemId: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 0) return next;

  if (itemId === BUY_ITEM_LIGHT_ARMOR || itemId === BUY_ITEM_HEAVY_ARMOR) {
    const price = itemId === BUY_ITEM_LIGHT_ARMOR ? ARMOR_LIGHT_PRICE : ARMOR_HEAVY_PRICE;
    const value = itemId === BUY_ITEM_LIGHT_ARMOR ? ARMOR_LIGHT : ARMOR_HEAVY;
    if (next.credits[playerIndex]! < price) return next;
    next.credits[playerIndex] = next.credits[playerIndex]! - price;
    next.armor[playerIndex] = Math.max(next.armor[playerIndex]!, value);
    return next;
  }

  const weapon = getWeaponDef(itemId);
  if (!weapon) return next; // unknown item id: no-op

  if (next.credits[playerIndex]! < weapon.price) return next;
  next.credits[playerIndex] = Math.min(MAX_CREDITS, next.credits[playerIndex]! - weapon.price);

  if (weapon.slot === "primary") {
    next.weaponPrimary[playerIndex] = weapon.id;
    next.magPrimary[playerIndex] = weapon.magSize;
    next.reservePrimary[playerIndex] = weapon.reserveAmmo;
  } else {
    next.weaponSecondary[playerIndex] = weapon.id;
    next.magSecondary[playerIndex] = weapon.magSize;
    next.reserveSecondary[playerIndex] = weapon.reserveAmmo;
  }
  return next;
}
