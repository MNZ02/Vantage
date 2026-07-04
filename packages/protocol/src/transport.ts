// Minimal transport abstraction. WebSocket (Node `ws` server-side, native
// browser WebSocket client-side) is the only concrete implementation this
// milestone, but netcode logic (client prediction, server tick loop, jitter
// buffer, latency harness) only ever talks to this interface so a future
// WebTransport/WebRTC transport can be dropped in without touching it.
export interface Transport {
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

// The two socket shapes we adapt: Node's `ws` package (EventEmitter-style
// `.on(...)`) and the browser's native WebSocket (`addEventListener`). We
// accept either without a hard dependency on either package's types so
// @vg/protocol stays runtime-dependency-free.
interface NodeLikeSocket {
  send(data: Uint8Array): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  close(): void;
}

interface BrowserLikeSocket {
  binaryType: string;
  send(data: ArrayBufferLike | ArrayBufferView): void;
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", cb: () => void): void;
  close(): void;
}

type AnySocket = NodeLikeSocket | BrowserLikeSocket;

function isBrowserSocket(socket: AnySocket): socket is BrowserLikeSocket {
  return typeof (socket as BrowserLikeSocket).addEventListener === "function";
}

/** Normalizes whatever a socket hands back for a binary message into a Uint8Array. */
function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data; // covers Node Buffer too (Buffer extends Uint8Array)
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new Error(`WebSocketTransport: unsupported message payload type: ${Object.prototype.toString.call(data)}`);
}

/** Adapts a Node `ws` socket or a browser `WebSocket` to the `Transport` interface. */
export class WebSocketTransport implements Transport {
  private readonly messageCbs: Array<(data: Uint8Array) => void> = [];
  private readonly closeCbs: Array<() => void> = [];
  private readonly socket: AnySocket;

  constructor(socket: AnySocket) {
    this.socket = socket;
    if (isBrowserSocket(socket)) {
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", (ev) => {
        const bytes = toBytes(ev.data);
        for (const cb of this.messageCbs) cb(bytes);
      });
      socket.addEventListener("close", () => {
        for (const cb of this.closeCbs) cb();
      });
    } else {
      socket.on("message", (data) => {
        const bytes = toBytes(data);
        for (const cb of this.messageCbs) cb(bytes);
      });
      socket.on("close", () => {
        for (const cb of this.closeCbs) cb();
      });
    }
  }

  send(data: Uint8Array): void {
    this.socket.send(data);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.messageCbs.push(cb);
  }

  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Two Transports wired directly to each other in-process, no socket at all —
 * used by tests and by bots that don't need a real network hop.
 */
export function createLoopbackPair(): [Transport, Transport] {
  const aMessageCbs: Array<(data: Uint8Array) => void> = [];
  const bMessageCbs: Array<(data: Uint8Array) => void> = [];
  const aCloseCbs: Array<() => void> = [];
  const bCloseCbs: Array<() => void> = [];
  let closed = false;

  const a: Transport = {
    send(data: Uint8Array) {
      if (closed) return;
      for (const cb of bMessageCbs) cb(data);
    },
    onMessage(cb) {
      aMessageCbs.push(cb);
    },
    onClose(cb) {
      aCloseCbs.push(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const cb of aCloseCbs) cb();
      for (const cb of bCloseCbs) cb();
    },
  };

  const b: Transport = {
    send(data: Uint8Array) {
      if (closed) return;
      for (const cb of aMessageCbs) cb(data);
    },
    onMessage(cb) {
      bMessageCbs.push(cb);
    },
    onClose(cb) {
      bCloseCbs.push(cb);
    },
    close() {
      a.close();
    },
  };

  return [a, b];
}
