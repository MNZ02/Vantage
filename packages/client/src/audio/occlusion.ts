// M5 audio: wall-occlusion decision for positional sounds. Pure geometry
// (raycastBoxes against LEVEL_BOXES) — the actual BiquadFilter/gain node
// wiring lives in engine.ts (not unit-testable), but the DECISION of
// "is there a wall between listener and source" is, and that's what's tested.
import { raycastBoxes, type Box, type Vec3Like } from "@vg/sim";

/** Lowpass cutoff applied to an occluded 3D sound (spec: "~800 Hz"). */
export const OCCLUSION_LOWPASS_HZ = 800;
/** Gain reduction (dB) applied to an occluded 3D sound (spec: "-9 dB"). */
export const OCCLUSION_GAIN_DB = -9;

/** Small pull-back from the exact source distance so the raycast doesn't spuriously clip the source's own box (e.g. a wall-mounted emitter). */
const EPSILON_M = 0.05;

export interface OcclusionResult {
  occluded: boolean;
}

/** True iff `boxes` blocks a straight line from `listenerPos` to `sourcePos`. */
export function computeOcclusion(boxes: readonly Box[], listenerPos: Vec3Like, sourcePos: Vec3Like): OcclusionResult {
  const dx = sourcePos.x - listenerPos.x;
  const dy = sourcePos.y - listenerPos.y;
  const dz = sourcePos.z - listenerPos.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-6) return { occluded: false };
  const dir = { x: dx / dist, y: dy / dist, z: dz / dist };
  const hit = raycastBoxes(boxes, listenerPos, dir, Math.max(0, dist - EPSILON_M));
  return { occluded: hit !== null };
}
