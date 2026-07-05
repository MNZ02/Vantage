import { MessageType, encodeMessage, type InputFrame, type SnapshotMessage, type Transport } from "@vg/protocol";
import type { AuthoritativeSnapshot } from "../src/prediction.js";

/**
 * Mirrors the real client's send cadence: keeps the last <=3 (seq, input)
 * pairs and resends them redundantly each call (see @vg/protocol InputBatch
 * docs). The caller supplies `seq` explicitly (rather than this function
 * maintaining its own counter) so it can be kept in lockstep with whatever
 * sequence numbers a PredictedClient's `queueAndPredict()` is handing out —
 * using two independently-incrementing counters for "the seq on the wire"
 * and "the seq PredictedClient buffers under" would desync the two the
 * moment either side starts before the other (e.g. before Welcome arrives).
 * `viewTick` defaults to 0 (tests that care about lag comp pass it explicitly).
 */
export function createScriptedInputSender(transport: Transport): (seq: number, input: InputFrame, viewTick?: number) => void {
  const history: Array<{ seq: number; input: InputFrame }> = [];
  return (seq: number, input: InputFrame, viewTick = 0) => {
    history.push({ seq, input });
    if (history.length > 3) history.shift();
    const firstSeq = history[0]!.seq;
    transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, viewTick, frames: history.map((h) => h.input) }));
  };
}

/** Maps a wire SnapshotMessage to PredictedClient.reconcile()'s AuthoritativeSnapshot shape. */
export function toAuthoritative(msg: SnapshotMessage): AuthoritativeSnapshot {
  return {
    serverTick: msg.serverTick,
    lastProcessedSeq: msg.lastProcessedSeq,
    players: msg.players.map((pl) => ({
      posX: pl.posX,
      posY: pl.posY,
      posZ: pl.posZ,
      velX: pl.velX,
      velY: pl.velY,
      velZ: pl.velZ,
      yaw: pl.yaw,
      pitch: pl.pitch,
      crouching: pl.crouching,
      grounded: pl.grounded,
      alive: pl.alive,
      activeSlot: pl.activeSlot,
      adsStage: pl.adsStage,
      health: pl.health,
      armor: pl.armor,
      weaponPrimary: pl.weaponPrimary,
      weaponSecondary: pl.weaponSecondary,
      magActive: pl.magActive,
      reserveActive: pl.reserveActive,
      tagTicksLeft: pl.tagTicksLeft,
      credits: pl.credits,
      respawnTicksLeft: pl.respawnTicksLeft,
    })),
  };
}

/** A neutral, all-false InputFrame with the given yaw/pitch. */
export function idleInput(yaw = 0, pitch = 0): InputFrame {
  return {
    forward: 0,
    right: 0,
    yaw,
    pitch,
    jump: false,
    crouch: false,
    walk: false,
    fire: false,
    ads: false,
    reload: false,
    slot1: false,
    slot2: false,
  };
}
