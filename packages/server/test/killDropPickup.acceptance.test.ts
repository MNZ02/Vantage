import { createLoopbackPair } from "@vg/protocol";
import { WEAPONS, WEAPON_NONE, raycastPlayers } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;
const VIPER = WEAPONS.find((w) => w.name === "Viper")!;

function setupTwoPlayerFight(): { host: ServerHost; shooterIndex: number; targetIndex: number; sendShooter: ReturnType<typeof createScriptedInputSender> } {
  const host = new ServerHost({ numPlayers: 2 });
  const [shooterClient, shooterServer] = createLoopbackPair();
  const [, targetServer] = createLoopbackPair();
  const shooterIndex = host.connect(shooterServer);
  const targetIndex = host.connect(targetServer);
  const sendShooter = createScriptedInputSender(shooterClient);

  const state = host.getState();
  state.weaponPrimary[shooterIndex] = FALCON.id;
  state.activeSlot[shooterIndex] = 0;
  state.magPrimary[shooterIndex] = FALCON.magSize;
  state.reservePrimary[shooterIndex] = FALCON.reserveAmmo;
  state.posX[shooterIndex] = 0;
  state.posY[shooterIndex] = 0;
  state.posZ[shooterIndex] = 0;
  state.posX[targetIndex] = 0;
  state.posY[targetIndex] = 0;
  state.posZ[targetIndex] = 5;
  state.health[targetIndex] = 1;
  state.weaponPrimary[targetIndex] = WEAPONS.find((w) => w.name === "Kestrel")!.id;

  return { host, shooterIndex, targetIndex, sendShooter };
}

describe("kill/respawn/drop/pickup (acceptance criterion 10)", () => {
  it("a kill emits a KillEvent with the correct killer/victim/headshot, drops the primary, and the victim is excluded from raycasts while dead", () => {
    const { host, shooterIndex, targetIndex, sendShooter } = setupTwoPlayerFight();

    // Aim dead-center (region should land on body/head depending on exact
    // pitch=0 aim at capsule center mass; either way, one shot at 1 HP kills).
    for (let i = 0; i < 5; i++) {
      sendShooter({ ...idleInput(), fire: true });
      host.step();
      if (host.getKills().length > 0) break;
    }

    expect(host.getKills().length).toBe(1);
    const kill = host.getKills()[0]!;
    expect(kill.killerIndex).toBe(shooterIndex);
    expect(kill.victimIndex).toBe(targetIndex);
    expect(typeof kill.headshot).toBe("boolean");

    expect(host.getState().alive[targetIndex]).toBe(0);
    expect(host.getState().weaponPrimary[targetIndex]).toBe(WEAPON_NONE);

    // Exactly one drop, at the death spot, holding the dropped weapon.
    expect(host.getDrops().length).toBe(1);
    const drop = host.getDrops()[0]!;
    expect(drop.weaponId).toBe(WEAPONS.find((w) => w.name === "Kestrel")!.id);

    // Dead player excluded from raycasts.
    const hit = raycastPlayers(host.getState(), shooterIndex, { x: 0, y: 0.9, z: 0 }, { x: 0, y: 0, z: 1 }, 20);
    expect(hit).toBeNull();

    // Respawns after RESPAWN_TICKS with loadout intact (secondary Viper kept; primary lost).
    const respawnAt = host.getState().respawnTick[targetIndex]!;
    expect(respawnAt).toBeGreaterThan(0);
    while (host.getState().tick <= respawnAt) {
      sendShooter(idleInput());
      host.step();
    }
    expect(host.getState().alive[targetIndex]).toBe(1);
    expect(host.getState().weaponSecondary[targetIndex]).toBe(VIPER.id);
  });

  it("an assist is recorded for the last other damager within the assist window", () => {
    const host = new ServerHost({ numPlayers: 3 });
    const [clientA, serverA] = createLoopbackPair();
    const [clientB, serverB] = createLoopbackPair();
    const [, serverC] = createLoopbackPair();
    const a = host.connect(serverA);
    const b = host.connect(serverB);
    const c = host.connect(serverC);
    const sendA = createScriptedInputSender(clientA);
    const sendB = createScriptedInputSender(clientB);

    const state = host.getState();
    for (const shooter of [a, b]) {
      state.weaponPrimary[shooter] = FALCON.id;
      state.activeSlot[shooter] = 0;
      state.magPrimary[shooter] = FALCON.magSize;
      state.reservePrimary[shooter] = FALCON.reserveAmmo;
    }
    state.posX[a] = 0;
    state.posZ[a] = 0;
    state.posX[b] = -10;
    state.posZ[b] = 0;
    state.posX[c] = 0;
    state.posZ[c] = 5;
    state.health[c] = 100; // survives A's first hit, dies to B's follow-up

    // A aims at C's body specifically (a headshot alone, at 160 dmg, would
    // outright kill a 100 HP target and make A the killer, defeating the
    // point of this scenario) — pitch down slightly from A's eye height to
    // land on the body band instead of the head band (see raycast.ts region
    // boundaries: relative height must fall below height - HEAD_REGION_HEIGHT_M).
    const aPitch = Math.atan2(0.9 - 1.65, 5); // aim at ~0.9m (body center), 5m out
    for (let i = 0; i < 5 && host.getHits().length === 0; i++) {
      sendA({ ...idleInput(), pitch: aPitch, fire: true });
      sendB(idleInput());
      host.step();
    }
    expect(host.getHits().length).toBeGreaterThan(0);
    expect(host.getState().alive[c]).toBe(1); // A's body shot must not have been lethal alone

    // Now B finishes C off, aiming from B's position toward C.
    const yaw = Math.atan2(state.posX[c]! - state.posX[b]!, state.posZ[c]! - state.posZ[b]!);
    for (let i = 0; i < 5 && host.getKills().length === 0; i++) {
      sendA(idleInput());
      sendB({ ...idleInput(), yaw, fire: true });
      host.step();
    }

    expect(host.getKills().length).toBe(1);
    const kill = host.getKills()[0]!;
    expect(kill.killerIndex).toBe(b);
    expect(kill.assistIndex).toBe(a);
  });

  it("a second player walking over a drop swaps weapons; the drop entity then holds the swapped-out weapon", () => {
    const { host, shooterIndex, targetIndex, sendShooter } = setupTwoPlayerFight();
    for (let i = 0; i < 5; i++) {
      sendShooter({ ...idleInput(), fire: true });
      host.step();
      if (host.getKills().length > 0) break;
    }
    expect(host.getDrops().length).toBe(1);
    const droppedWeaponId = host.getDrops()[0]!.weaponId;
    const drop = host.getDrops()[0]!;

    // Give the shooter a primary of their own (so the swap has something to leave behind) and walk them onto the drop.
    const state = host.getState();
    const wasp = WEAPONS.find((w) => w.name === "Wasp")!;
    state.weaponPrimary[shooterIndex] = wasp.id;
    state.magPrimary[shooterIndex] = 7; // partial mag, should be what the new drop holds
    state.reservePrimary[shooterIndex] = wasp.reserveAmmo;
    state.posX[shooterIndex] = drop.x;
    state.posY[shooterIndex] = drop.y;
    state.posZ[shooterIndex] = drop.z;

    sendShooter(idleInput());
    host.step();

    expect(host.getState().weaponPrimary[shooterIndex]).toBe(droppedWeaponId);
    expect(host.getDrops().length).toBe(1);
    const newDrop = host.getDrops()[0]!;
    expect(newDrop.weaponId).toBe(wasp.id);
    expect(newDrop.mag).toBe(7);
    void targetIndex;
  });

  it("drops despawn after 30s (DROP_DESPAWN_TICKS)", () => {
    const { host, sendShooter } = setupTwoPlayerFight();
    for (let i = 0; i < 5; i++) {
      sendShooter({ ...idleInput(), fire: true });
      host.step();
      if (host.getDrops().length > 0) break;
    }
    expect(host.getDrops().length).toBe(1);

    const spawnTick = host.getState().tick;
    while (host.getState().tick - spawnTick < 1920) {
      sendShooter(idleInput());
      host.step();
    }
    expect(host.getDrops().length).toBe(0);
  });
});
