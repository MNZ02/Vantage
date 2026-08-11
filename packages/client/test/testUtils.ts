import { MessageType, encodeMessage, type SnapshotMessage, type Transport } from "@vg/protocol";
import type { InputFrame } from "@vg/sim";
import type { AuthoritativeSnapshot, PredictedClient } from "../src/prediction.js";

/** Opaque read for state assigned by synchronous transport callbacks (which TypeScript cannot model in outer-loop flow analysis). */
export function observePrediction(prediction: PredictedClient | null): PredictedClient | null {
  return prediction;
}

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

/**
 * Maps a wire SnapshotMessage to PredictedClient.reconcile()'s
 * AuthoritativeSnapshot shape. Includes the M3 match section whenever the
 * snapshot's mode says match (mode 1) — DM-mode snapshots (mode 0) omit it,
 * matching net.ts's own real-client behavior.
 */
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
      team: pl.team,
      agentId: pl.agentId,
      ultPoints: pl.ultPoints,
      flashedTicksLeft: pl.flashedTicksLeft,
      flashIntensity: pl.flashIntensity,
      abilityCharges: pl.abilityCharges,
    })),
    abilityEntities: msg.abilityEntities.map((e) => ({
      slot: e.slot,
      entType: e.entType,
      owner: e.owner,
      abilityId: e.abilityId,
      x: e.x,
      y: e.y,
      z: e.z,
      velX: e.velX,
      velY: e.velY,
      velZ: e.velZ,
      ageTicks: e.ageTicks,
      endTicksLeft: e.endTicksLeft,
      param: e.param,
    })),
    match:
      msg.mode === 1
        ? {
            mode: msg.mode,
            matchPhase: msg.matchPhase,
            phaseTicksLeft: msg.phaseTicksLeft,
            roundNumber: msg.roundNumber,
            scoreTeam0: msg.scoreTeam0,
            scoreTeam1: msg.scoreTeam1,
            spikeState: msg.spikeState,
            spikeCarrier: msg.spikeCarrier,
            spikeX: msg.spikeX,
            spikeY: msg.spikeY,
            spikeZ: msg.spikeZ,
            spikePlantedTicksLeft: msg.spikePlantedTicksLeft,
            activePlantProgress: msg.activePlantProgress,
            planterIndex: msg.planterIndex,
            activeDefuseProgress: msg.activeDefuseProgress,
            defuserIndex: msg.defuserIndex,
          }
        : undefined,
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
    interact: false,
    ping: false,
    ability1: false,
    ability2: false,
    signature: false,
    ult: false,
  };
}
