import { MessageType, createLoopbackPair, decodeMessage, type SnapshotMessage } from "@vg/protocol";
import { TEAM_ATTACKERS, TEAM_DEFENDERS, type Box } from "@vg/sim";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";

function latestSnapshot(messages: SnapshotMessage[]): SnapshotMessage {
  const snapshot = messages.at(-1);
  if (!snapshot) throw new Error("expected a snapshot");
  return snapshot;
}

describe("recipient-specific snapshot visibility", () => {
  it("freezes an occluded enemy at its last known position and restores exact state once visible", () => {
    const wall: Box = { minX: -1, maxX: 1, minY: -1, maxY: 4, minZ: 4, maxZ: 5 };
    const host = new ServerHost({ numPlayers: 2, minPlayers: 2, mode: "match", boxes: [wall], snapshotEveryNTicks: 1 });
    const [attackerClient, attackerServer] = createLoopbackPair();
    const [, defenderServer] = createLoopbackPair();
    const snapshots: SnapshotMessage[] = [];
    attackerClient.onMessage((bytes) => {
      const msg = decodeMessage(bytes);
      if (msg.type === MessageType.Snapshot) snapshots.push(msg);
    });
    const attacker = host.connect(attackerServer);
    const defender = host.connect(defenderServer);
    const state = host.getState();
    expect(state.team[attacker]).toBe(TEAM_ATTACKERS);
    expect(state.team[defender]).toBe(TEAM_DEFENDERS);

    state.posX[attacker] = 0;
    state.posY[attacker] = 0;
    state.posZ[attacker] = 0;
    state.yaw[attacker] = 0;
    state.posX[defender] = 0;
    state.posY[defender] = 0;
    state.posZ[defender] = 10;
    state.health[defender] = 73;
    state.credits[defender] = 4200;
    (host as unknown as { updateVisibility(): void }).updateVisibility();
    host.step();

    const hidden = latestSnapshot(snapshots);
    expect(hidden.visibleEnemyMask & (1 << defender)).toBe(0);
    expect(hidden.players[defender]!.posZ).not.toBe(10);
    expect(hidden.players[defender]!.velX).toBe(0);
    expect(hidden.players[defender]!.health).toBe(0);
    expect(hidden.players[defender]!.credits).toBe(0);

    // Move the enemy around the side of the wall and face it directly.
    host.getState().posX[defender] = 10;
    host.getState().posZ[defender] = 10;
    host.getState().yaw[attacker] = Math.PI / 4;
    (host as unknown as { updateVisibility(): void }).updateVisibility();
    host.step();

    const visible = latestSnapshot(snapshots);
    expect(visible.visibleEnemyMask & (1 << defender)).not.toBe(0);
    expect(visible.players[defender]!.posX).toBeCloseTo(10, 5);
    expect(visible.players[defender]!.posZ).toBeCloseTo(10, 5);
    expect(visible.players[defender]!.health).toBe(73);
    expect(visible.players[defender]!.credits).toBe(4200);
  });
});
