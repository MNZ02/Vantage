import { describe, expect, it } from "vitest";
import {
  RESPAWN_TICKS,
  SPAWN_HEALTH,
  WEAPONS,
  applyDamage,
  createState,
  defaultInput,
  raycastPlayers,
  tick,
  type Box,
  type SimState,
} from "../src/index.js";

const FLOOR: Box = { minX: -100, minY: -1, minZ: -100, maxX: 100, maxY: 0, maxZ: 100 };
const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

function equip(state: SimState, playerIndex: number): void {
  state.weaponPrimary[playerIndex] = FALCON.id;
  state.activeSlot[playerIndex] = 0;
  state.magPrimary[playerIndex] = 3; // partially spent mag, should be refilled on respawn (DM convenience)
  state.reservePrimary[playerIndex] = FALCON.reserveAmmo;
}

describe("kill/respawn (acceptance criterion 10, sim-level subset)", () => {
  it("a lethal applyDamage marks the player dead, excludes them from raycasts, and respawns them after RESPAWN_TICKS with loadout intact", () => {
    let state = createState(7, 2);
    equip(state, 1);
    state.posX[1] = 0;
    state.posY[1] = 0;
    state.posZ[1] = 10;
    state = tick(state, [defaultInput(0), defaultInput(0)], [FLOOR]).state;

    state = applyDamage(state, 1, 999);
    expect(state.alive[1]).toBe(0);
    expect(state.health[1]).toBe(0);
    expect(state.respawnTick[1]).toBe(state.tick + RESPAWN_TICKS);

    // Dead player must not be hittable/blocking for raycasts.
    const hit = raycastPlayers(state, 0, { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(hit).toBeNull();

    // Frozen in place while dead, inputs ignored.
    const posBefore = { x: state.posX[1], y: state.posY[1], z: state.posZ[1] };
    for (let i = 0; i < 50; i++) {
      state = tick(state, [defaultInput(0), { ...defaultInput(0), forward: 1 }], [FLOOR]).state;
    }
    expect(state.posX[1]).toBe(posBefore.x);
    expect(state.posZ[1]).toBe(posBefore.z);

    // Respawn is evaluated using the tick *entering* tick(), so the call that
    // actually revives the player is the one made while state.tick===respawnAt.
    const respawnAt = state.respawnTick[1]!;
    while (state.tick <= respawnAt) {
      state = tick(state, [defaultInput(0), defaultInput(0)], [FLOOR]).state;
    }
    expect(state.alive[1]).toBe(1);
    expect(state.health[1]).toBe(SPAWN_HEALTH);
    // Loadout intact, mag refilled to full (DM convenience).
    expect(state.weaponPrimary[1]).toBe(FALCON.id);
    expect(state.magPrimary[1]).toBe(FALCON.magSize);

    // Hittable again once alive (aimed straight at wherever the respawn point placed them).
    const hitAfter = raycastPlayers(state, 0, { x: state.posX[1]!, y: 0.9, z: state.posZ[1]! - 10 }, { x: 0, y: 0, z: 1 }, 30);
    expect(hitAfter).not.toBeNull();
    expect(hitAfter!.playerIndex).toBe(1);
  });
});
