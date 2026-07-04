import { MessageType, encodeMessage, type InputFrame, type Transport } from "@vg/protocol";

/**
 * Mirrors the real client's send cadence: keeps the last <=3 (seq, input)
 * pairs and resends them redundantly each call (see @vg/protocol InputBatch
 * docs). The caller supplies `seq` explicitly (rather than this function
 * maintaining its own counter) so it can be kept in lockstep with whatever
 * sequence numbers a PredictedClient's `queueAndPredict()` is handing out —
 * using two independently-incrementing counters for "the seq on the wire"
 * and "the seq PredictedClient buffers under" would desync the two the
 * moment either side starts before the other (e.g. before Welcome arrives).
 */
export function createScriptedInputSender(transport: Transport): (seq: number, input: InputFrame) => void {
  const history: Array<{ seq: number; input: InputFrame }> = [];
  return (seq: number, input: InputFrame) => {
    history.push({ seq, input });
    if (history.length > 3) history.shift();
    const firstSeq = history[0]!.seq;
    transport.send(encodeMessage({ type: MessageType.InputBatch, firstSeq, frames: history.map((h) => h.input) }));
  };
}
