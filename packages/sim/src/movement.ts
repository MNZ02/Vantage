import {
  AIR_ACCEL,
  AIR_SPEED_CAP,
  CAPSULE_RADIUS,
  CROUCH_HEIGHT,
  CROUCH_SPEED,
  GROUND_ACCEL,
  GROUND_FRICTION,
  GROUND_PROBE_EPSILON,
  GRAVITY,
  JUMP_SPEED,
  MAX_STEP_HEIGHT,
  RUN_SPEED,
  SKIN_WIDTH,
  STAND_HEIGHT,
  STOP_SPEED,
  WALK_SPEED,
} from "./constants.js";
import { cosApprox, sinApprox, length2D } from "./math.js";
import type { Box, InputFrame, SimState } from "./state.js";

function capsuleHeight(crouching: boolean): number {
  return crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
}

function wishSpeedFor(input: InputFrame): number {
  if (input.crouch) return CROUCH_SPEED;
  if (input.walk) return WALK_SPEED;
  return RUN_SPEED;
}

/** World-space wish direction (unit vector, y=0) from local forward/right + yaw. */
function wishDirection(input: InputFrame): { x: number; z: number } {
  const fx = sinApprox(input.yaw);
  const fz = cosApprox(input.yaw);
  // right-hand: right = forward rotated -90 deg about Y
  const rx = cosApprox(input.yaw);
  const rz = -sinApprox(input.yaw);

  let x = fx * input.forward + rx * input.right;
  let z = fz * input.forward + rz * input.right;
  const len = length2D(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

function applyFriction(velX: number, velZ: number, dt: number): { x: number; z: number } {
  const speed = length2D(velX, velZ);
  if (speed < 1e-6) return { x: 0, z: 0 };
  const control = speed < STOP_SPEED ? STOP_SPEED : speed;
  const drop = control * GROUND_FRICTION * dt;
  const newSpeed = Math.max(0, speed - drop);
  const scale = newSpeed / speed;
  return { x: velX * scale, z: velZ * scale };
}

function applyAccelerate(
  velX: number,
  velZ: number,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): { x: number; z: number } {
  const currentSpeed = velX * wishX + velZ * wishZ;
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return { x: velX, z: velZ };
  let accelSpeed = accel * dt * wishSpeed;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;
  return { x: velX + accelSpeed * wishX, z: velZ + accelSpeed * wishZ };
}

// Whether the capsule's central axis is directly over/through a box's XZ
// footprint. Used to decide "am I standing on / bumping the underside of this
// box" (a vertical concern) as opposed to merely brushing past its side
// within the capsule radius (a horizontal-only concern) — a tall wall the
// player is walking toward would otherwise look "vertically embedded" the
// moment it enters the radius, well before it's actually a wall hit.
//
// TODO: this gates on the capsule's center point only, not its radius, so a
// player standing right at a platform's edge (center just outside, but the
// capsule disc overlapping it) won't be considered "on" it — noted, not fixed,
// per reviewer triage (deferred as optional for M0's graybox geometry).
function columnCenterInsideFootprint(box: Box, x: number, z: number): boolean {
  return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
}

/**
 * Resolves vertical collisions (floor/ceiling) for a vertical-cylinder
 * approximation of the capsule, using the previous and new feet Y to detect
 * crossings so we don't tunnel through thin boxes in one 15.625 ms step.
 */
function resolveVertical(
  prevFeetY: number,
  newFeetY: number,
  height: number,
  x: number,
  z: number,
  velY: number,
  boxes: readonly Box[],
): { feetY: number; velY: number; grounded: boolean } {
  let feetY = newFeetY;
  let outVelY = velY;
  let grounded = false;

  for (const box of boxes) {
    if (!columnCenterInsideFootprint(box, x, z)) continue;

    const prevHeadY = prevFeetY + height;
    const newHeadY = feetY + height;

    // Falling/standing onto a box top.
    if (velY <= 0 && prevFeetY >= box.maxY - 1e-6 && feetY <= box.maxY) {
      if (feetY <= box.maxY && newHeadY > box.minY) {
        feetY = box.maxY;
        outVelY = 0;
        grounded = true;
        continue;
      }
    }
    // Rising into a box's underside.
    if (velY > 0 && prevHeadY <= box.minY + 1e-6 && newHeadY >= box.minY) {
      feetY = box.minY - height;
      outVelY = 0;
      continue;
    }
    // Already embedded vertically (e.g. spawned overlapping) — push out to
    // whichever face is closer.
    const embeddedTop = feetY < box.maxY && newHeadY > box.minY && feetY >= box.minY;
    if (embeddedTop) {
      const pushUp = box.maxY - feetY;
      const pushDown = newHeadY - box.minY;
      if (pushUp <= pushDown) {
        feetY = box.maxY;
        if (outVelY < 0) outVelY = 0;
        grounded = true;
      } else {
        feetY = box.minY - height;
        if (outVelY > 0) outVelY = 0;
      }
    }
  }

  // Ground probe: even with velY ~ 0 (resting), confirm a surface is within a
  // small epsilon directly below and snap to it, so standing still on a flat
  // floor reports grounded=true every tick instead of only on the landing tick.
  if (!grounded && outVelY <= 0) {
    for (const box of boxes) {
      if (!columnCenterInsideFootprint(box, x, z)) continue;
      if (feetY >= box.maxY - GROUND_PROBE_EPSILON && feetY <= box.maxY + GROUND_PROBE_EPSILON) {
        feetY = box.maxY;
        outVelY = 0;
        grounded = true;
        break;
      }
    }
  }

  return { feetY, velY: outVelY, grounded };
}

/**
 * Resolves horizontal collisions (walls) for the cylinder approximation via
 * closest-point push-out, iterated across all boxes a few times so corners
 * settle, and removes the into-surface velocity component so the remaining
 * tangential velocity produces sliding rather than sticking.
 */
function resolveHorizontal(
  x: number,
  z: number,
  feetY: number,
  height: number,
  velX: number,
  velZ: number,
  boxes: readonly Box[],
): { x: number; z: number; velX: number; velZ: number; penetration: number } {
  let px = x;
  let pz = z;
  let vx = velX;
  let vz = velZ;
  let maxPenetration = 0;

  const iterations = 4;
  for (let iter = 0; iter < iterations; iter++) {
    for (const box of boxes) {
      const headY = feetY + height;
      if (headY <= box.minY || feetY >= box.maxY) continue; // no vertical overlap

      const closestX = Math.min(box.maxX, Math.max(box.minX, px));
      const closestZ = Math.min(box.maxZ, Math.max(box.minZ, pz));
      const dx = px - closestX;
      const dz = pz - closestZ;
      const distSq = dx * dx + dz * dz;

      if (distSq > 1e-12 && distSq < CAPSULE_RADIUS * CAPSULE_RADIUS) {
        const dist = Math.sqrt(distSq);
        const nx = dx / dist;
        const nz = dz / dist;
        const pen = CAPSULE_RADIUS - dist + SKIN_WIDTH;
        px += nx * pen;
        pz += nz * pen;
        if (pen > maxPenetration) maxPenetration = pen;
        const into = vx * nx + vz * nz;
        if (into < 0) {
          vx -= nx * into;
          vz -= nz * into;
        }
      } else if (distSq <= 1e-12) {
        // Center is inside the box footprint: push out along the nearest side.
        const pushLeft = px - box.minX;
        const pushRight = box.maxX - px;
        const pushBack = pz - box.minZ;
        const pushFwd = box.maxZ - pz;
        const min = Math.min(pushLeft, pushRight, pushBack, pushFwd);
        let nx = 0;
        let nz = 0;
        if (min === pushLeft) nx = -1;
        else if (min === pushRight) nx = 1;
        else if (min === pushBack) nz = -1;
        else nz = 1;
        const pen = CAPSULE_RADIUS + SKIN_WIDTH;
        px += nx * pen;
        pz += nz * pen;
        if (pen > maxPenetration) maxPenetration = pen;
        const into = vx * nx + vz * nz;
        if (into < 0) {
          vx -= nx * into;
          vz -= nz * into;
        }
      }
    }
  }

  return { x: px, z: pz, velX: vx, velZ: vz, penetration: maxPenetration };
}

/** Highest box top at or below `atOrBelowY` whose footprint contains (x, z), or null if none. */
function findFloorBelow(x: number, z: number, atOrBelowY: number, boxes: readonly Box[]): number | null {
  let best: number | null = null;
  for (const box of boxes) {
    if (!columnCenterInsideFootprint(box, x, z)) continue;
    if (box.maxY <= atOrBelowY + 1e-6 && (best === null || box.maxY > best)) {
      best = box.maxY;
    }
  }
  return best;
}

export interface MovementResult {
  posX: number;
  posY: number;
  posZ: number;
  velX: number;
  velY: number;
  velZ: number;
  grounded: boolean;
  /** Max horizontal push-out applied this tick; exposed for penetration tests. */
  penetration: number;
}

/** Advances a single player's capsule by one fixed timestep. Pure: reads only its arguments.
 * `speedMultiplier` folds in gunplay-driven movement modifiers (tagging, ADS)
 * computed by the caller from *last* tick's state — see tick.ts. */
export function movePlayer(
  state: SimState,
  index: number,
  input: InputFrame,
  boxes: readonly Box[],
  dt: number,
  speedMultiplier = 1,
): MovementResult {
  const wasGrounded = state.grounded[index] === 1;
  const height = capsuleHeight(input.crouch);

  let velX = state.velX[index]!;
  let velY = state.velY[index]!;
  let velZ = state.velZ[index]!;

  const wishSpeed = wishSpeedFor(input) * speedMultiplier;
  const wish = wishDirection(input);

  if (wasGrounded) {
    const f = applyFriction(velX, velZ, dt);
    velX = f.x;
    velZ = f.z;
    const a = applyAccelerate(velX, velZ, wish.x, wish.z, wishSpeed, GROUND_ACCEL, dt);
    velX = a.x;
    velZ = a.z;
  } else {
    const cappedWishSpeed = wishSpeed * AIR_SPEED_CAP;
    const a = applyAccelerate(velX, velZ, wish.x, wish.z, cappedWishSpeed, AIR_ACCEL, dt);
    velX = a.x;
    velZ = a.z;
  }

  // Gravity, then jump overrides vertical velocity outright for a crisp launch.
  velY -= GRAVITY * dt;
  if (wasGrounded && input.jump) {
    velY = JUMP_SPEED;
  }

  const prevFeetY = state.posY[index]!;
  const newFeetYUnresolved = prevFeetY + velY * dt;
  const newX = state.posX[index]! + velX * dt;
  const newZ = state.posZ[index]! + velZ * dt;

  const vertical = resolveVertical(prevFeetY, newFeetYUnresolved, height, newX, newZ, velY, boxes);
  const horizontal = resolveHorizontal(newX, newZ, vertical.feetY, height, velX, velZ, boxes);

  let finalFeetY = vertical.feetY;
  let finalHorizontal = horizontal;
  let finalGrounded = vertical.grounded;
  let finalVelY = vertical.velY;

  // Grounded step-up (stairs/curbs/low ledges): if we were blocked moving
  // horizontally, retry the same move with the feet raised by MAX_STEP_HEIGHT.
  // Re-running resolveHorizontal at that height also re-checks for a ceiling
  // there (any box overlapping the raised capsule still blocks it the same
  // way), so "is there headroom to step up" falls out of the same collision
  // test rather than needing a separate check.
  if (wasGrounded && horizontal.penetration > 1e-6) {
    const raisedFeetY = vertical.feetY + MAX_STEP_HEIGHT;
    const stepped = resolveHorizontal(newX, newZ, raisedFeetY, height, velX, velZ, boxes);
    const blockedDist = Math.hypot(newX - horizontal.x, newZ - horizontal.z);
    const steppedDist = Math.hypot(newX - stepped.x, newZ - stepped.z);
    if (steppedDist < blockedDist - 1e-4) {
      const floorY = findFloorBelow(stepped.x, stepped.z, raisedFeetY, boxes);
      if (floorY !== null && floorY >= vertical.feetY - 1e-6 && floorY - vertical.feetY <= MAX_STEP_HEIGHT + 1e-6) {
        finalFeetY = floorY;
        finalHorizontal = stepped;
        finalGrounded = true;
        finalVelY = 0;
      }
    }
  }

  return {
    posX: finalHorizontal.x,
    posY: finalFeetY,
    posZ: finalHorizontal.z,
    velX: finalHorizontal.velX,
    velY: finalVelY,
    velZ: finalHorizontal.velZ,
    grounded: finalGrounded,
    penetration: finalHorizontal.penetration,
  };
}
