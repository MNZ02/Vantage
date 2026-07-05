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
import {
  ARMOR_HEAVY,
  ARMOR_HEAVY_PRICE,
  ARMOR_LIGHT,
  ARMOR_LIGHT_PRICE,
  ARMOR_ABSORB_RATE,
  BUY_ITEM_HEAVY_ARMOR,
  BUY_ITEM_LIGHT_ARMOR,
  MAX_CREDITS,
  NO_PLAYER,
  TAG_TICKS,
  WEAPON_NONE,
} from "./constants.js";
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
    // M3 refund bookkeeping: remember which armor item this buy-phase's
    // purchase was, so a same-phase sell knows what price to refund. See
    // applySell()'s doc comment for the (documented, imperfect) simplification
    // this implies when light-then-heavy are bought in the same phase.
    next.armorPurchasedItemId[playerIndex] = itemId;
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
    next.primaryPurchasedItemId[playerIndex] = weapon.id;
  } else {
    next.weaponSecondary[playerIndex] = weapon.id;
    next.magSecondary[playerIndex] = weapon.magSize;
    next.reserveSecondary[playerIndex] = weapon.reserveAmmo;
    next.secondaryPurchasedItemId[playerIndex] = weapon.id;
  }
  return next;
}

/**
 * Applies a SellCmd (M3, match mode only — sell is server-gated to the buy
 * phase, same as applyBuy's DM-anytime/match-buy-phase-only split; this
 * function itself doesn't check phase, matching applyBuy's own permissive
 * style). Refunds the FULL price of `itemId`, but ONLY if it is exactly the
 * item that slot's/armor's *ThisBuy tracking says was purchased THIS buy
 * phase (see state.ts's primaryPurchasedItemId/secondaryPurchasedItemId/
 * armorPurchasedItemId, snapshotted fresh at every buy-phase start by
 * match.ts's enterBuyPhase) — reverts that slot/armor to whatever it held at
 * the start of the CURRENT buy phase (weaponPrimaryAtBuyStart/
 * weaponSecondaryAtBuyStart/armorAtBuyStart), and refills the reverted
 * weapon's mag to full so a sold-back-to weapon isn't left empty.
 *
 * Documented simplification: only the MOST RECENT purchase into a given
 * slot/armor this buy phase is sellable (re-buying into the same slot
 * overwrites the tracked itemId) — buying light armor then heavy armor in
 * the same phase and selling only recovers the heavy price, not both. This
 * mirrors how the loadout itself already only remembers the latest
 * purchase's effect; a full purchase history/stack was judged not worth the
 * extra state for a v1 economy. No-op (unchanged clone) if `itemId` isn't
 * the tracked purchase for its slot, the player is dead, or `itemId` is
 * unrecognized.
 */
export function applySell(state: SimState, playerIndex: number, itemId: number): SimState {
  const next = cloneState(state);
  if (next.alive[playerIndex] === 0) return next;

  if (itemId === BUY_ITEM_LIGHT_ARMOR || itemId === BUY_ITEM_HEAVY_ARMOR) {
    if (next.armorPurchasedItemId[playerIndex] !== itemId) return next;
    const price = itemId === BUY_ITEM_LIGHT_ARMOR ? ARMOR_LIGHT_PRICE : ARMOR_HEAVY_PRICE;
    next.credits[playerIndex] = Math.min(MAX_CREDITS, next.credits[playerIndex]! + price);
    next.armor[playerIndex] = next.armorAtBuyStart[playerIndex]!;
    next.armorPurchasedItemId[playerIndex] = NO_PLAYER;
    return next;
  }

  const weapon = getWeaponDef(itemId);
  if (!weapon) return next;

  if (weapon.slot === "primary") {
    if (next.primaryPurchasedItemId[playerIndex] !== itemId) return next;
    next.credits[playerIndex] = Math.min(MAX_CREDITS, next.credits[playerIndex]! + weapon.price);
    const revertId = next.weaponPrimaryAtBuyStart[playerIndex]!;
    next.weaponPrimary[playerIndex] = revertId;
    if (revertId === WEAPON_NONE) {
      next.magPrimary[playerIndex] = 0;
      next.reservePrimary[playerIndex] = 0;
    } else {
      const revertDef = getWeaponDef(revertId);
      next.magPrimary[playerIndex] = revertDef?.magSize ?? 0;
      next.reservePrimary[playerIndex] = revertDef?.reserveAmmo ?? 0;
    }
    next.primaryPurchasedItemId[playerIndex] = WEAPON_NONE;
  } else {
    if (next.secondaryPurchasedItemId[playerIndex] !== itemId) return next;
    next.credits[playerIndex] = Math.min(MAX_CREDITS, next.credits[playerIndex]! + weapon.price);
    const revertId = next.weaponSecondaryAtBuyStart[playerIndex]!;
    next.weaponSecondary[playerIndex] = revertId;
    const revertDef = getWeaponDef(revertId);
    next.magSecondary[playerIndex] = revertDef?.magSize ?? 0;
    next.reserveSecondary[playerIndex] = revertDef?.reserveAmmo ?? 0;
    next.secondaryPurchasedItemId[playerIndex] = WEAPON_NONE;
  }
  return next;
}
