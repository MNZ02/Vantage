import { MessageType, encodeMessage, type InputSample, type Transport } from "@vg/protocol";

/**
 * Mirrors the real client's send cadence: keeps the last <=3 input samples
 * and resends them redundantly each call (see @vg/protocol InputBatch docs),
 * incrementing the sequence number every call. Shared by the server-package
 * netcode tests that need a scripted "client" without pulling in @vg/client.
 * `viewTick` defaults to 0 (tests that care about lag comp pass it explicitly).
 */
export function createScriptedInputSender(transport: Transport): (sample: InputSample, viewTick?: number) => void {
  let seq = 0;
  const history: InputSample[] = [];
  return (sample: InputSample, viewTick = 0) => {
    history.push(sample);
    if (history.length > 3) history.shift();
    const firstSeq = seq - history.length + 1;
    transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, viewTick, frames: history.slice() }));
    seq++;
  };
}

export function idleInput(): InputSample {
  return {
    forward: 0,
    right: 0,
    yaw: 0,
    pitch: 0,
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
