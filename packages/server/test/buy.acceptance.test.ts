import { createLoopbackPair, MessageType, encodeMessage } from "@vg/protocol";
import { MAX_CREDITS, WEAPONS } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";
import { createScriptedInputSender, idleInput } from "./testUtils.js";

const MARSHAL6 = WEAPONS.find((w) => w.name === "Marshal-6")!;
const FALCON = WEAPONS.find((w) => w.name === "Falcon")!;

describe("buy (acceptance criterion 11)", () => {
  it("BuyCmd with sufficient credits grants the weapon and deducts exactly price", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);
    const state = host.getState();
    state.credits[index] = 1000;

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: MARSHAL6.id }));
    host.step();

    expect(host.getState().credits[index]).toBe(1000 - MARSHAL6.price);
    expect(host.getState().weaponSecondary[index]).toBe(MARSHAL6.id);
    expect(host.getState().magSecondary[index]).toBe(MARSHAL6.magSize);
  });

  it("BuyCmd with insufficient credits changes nothing", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);
    const state = host.getState();
    state.credits[index] = 100; // less than Marshal-6's 800 price
    const priorSecondary = state.weaponSecondary[index];

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: MARSHAL6.id }));
    host.step();

    expect(host.getState().credits[index]).toBe(100);
    expect(host.getState().weaponSecondary[index]).toBe(priorSecondary);
  });

  it("armor purchase sets armor and never stacks above its own value", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);
    host.getState().credits[index] = 2000;

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: 201 })); // heavy armor
    host.step();
    expect(host.getState().armor[index]).toBe(50);
    const creditsAfterHeavy = host.getState().credits[index]!;

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: 201 })); // buy heavy again
    host.step();
    expect(host.getState().armor[index]).toBe(50); // no stacking above 50
    expect(host.getState().credits[index]).toBe(creditsAfterHeavy - 1000); // still charged each time
  });

  it("dead players can't buy", () => {
    const host = new ServerHost({ numPlayers: 1 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);
    const state = host.getState();
    state.credits[index] = 5000;
    state.alive[index] = 0;
    state.respawnTick[index] = 100000;

    client.send(encodeMessage({ type: MessageType.BuyCmd, itemId: MARSHAL6.id }));
    host.step();

    expect(host.getState().credits[index]).toBe(5000);
    expect(host.getState().weaponSecondary[index]).not.toBe(MARSHAL6.id);
  });

  it("a kill adds exactly KILL_REWARD credits, capped at MAX_CREDITS", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [shooterClient, shooterServer] = createLoopbackPair();
    const [, targetServer] = createLoopbackPair();
    const shooterIndex = host.connect(shooterServer);
    const targetIndex = host.connect(targetServer);
    const sendShooter = createScriptedInputSender(shooterClient);

    const state = host.getState();
    state.credits[shooterIndex] = MAX_CREDITS - 50; // near the cap, so the +200 reward must clamp
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
    state.health[targetIndex] = 1; // one shot kills

    for (let i = 0; i < 5; i++) {
      sendShooter({ ...idleInput(), fire: true });
      host.step();
      if (host.getKills().length > 0) break;
    }

    expect(host.getKills().length).toBe(1);
    const kill = host.getKills()[0]!;
    expect(kill.killerIndex).toBe(shooterIndex);
    expect(kill.victimIndex).toBe(targetIndex);
    expect(host.getState().credits[shooterIndex]).toBe(MAX_CREDITS);
  });
});
