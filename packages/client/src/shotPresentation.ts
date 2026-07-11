import { getCombatWeaponDef, type WeaponDef } from "@vg/sim";

/**
 * Resolves every shot that uses the combat pipeline, including temporary
 * ultimate weapons. Keeping presentation on this resolver prevents Blades
 * and Rail from silently losing tracers, recoil, hit feedback, and impacts.
 */
export function getShotPresentationWeapon(weaponId: number): WeaponDef | null {
  return getCombatWeaponDef(weaponId);
}
