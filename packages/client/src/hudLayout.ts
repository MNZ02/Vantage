/** Pure HUD layout helpers kept separate from the DOM/Three renderer so their
 * coordinate and HiDPI contracts can be regression-tested in Node. */

export interface MinimapPoint {
  x: number;
  y: number;
}

/**
 * Projects the horizontal world plane onto a north-up minimap.
 *
 * The simulation defines +Z as north/forward at yaw=0. Canvas Y grows down,
 * so Z must be inverted: +Z lands at the top edge and -Z at the bottom.
 */
export function worldToMinimapPoint(
  worldX: number,
  worldZ: number,
  worldHalfExtent: number,
  logicalSize: number,
): MinimapPoint {
  const worldSize = worldHalfExtent * 2;
  return {
    x: ((worldX + worldHalfExtent) / worldSize) * logicalSize,
    y: ((worldHalfExtent - worldZ) / worldSize) * logicalSize,
  };
}

/** Returns an integer canvas backing-store size while capping runaway DPR. */
export function minimapBackingStoreSize(logicalSize: number, devicePixelRatio: number, maxDpr = 2): number {
  const safeDpr = Number.isFinite(devicePixelRatio) ? Math.max(1, Math.min(maxDpr, devicePixelRatio)) : 1;
  return Math.max(1, Math.round(logicalSize * safeDpr));
}

