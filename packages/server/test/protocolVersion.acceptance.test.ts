import { MessageType, PROTOCOL_VERSION, createLoopbackPair, encodeMessage } from "@vg/protocol";
import { describe, expect, it } from "vitest";
import { ServerHost } from "../src/serverHost.js";

describe("Hello protocol-version enforcement", () => {
  it("a Hello announcing a mismatched protocolVersion gets the connection closed, without crashing", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);
    expect(host.isConnected(index)).toBe(true);

    let closed = false;
    client.onClose(() => {
      closed = true;
    });

    expect(() => client.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION + 1 }))).not.toThrow();

    expect(closed).toBe(true);
    expect(host.isConnected(index)).toBe(false);
  });

  it("a Hello announcing the matching protocolVersion is a no-op — connection stays open", () => {
    const host = new ServerHost({ numPlayers: 2 });
    const [client, server] = createLoopbackPair();
    const index = host.connect(server);

    client.send(encodeMessage({ type: MessageType.Hello, protocolVersion: PROTOCOL_VERSION }));

    expect(host.isConnected(index)).toBe(true);
    expect(() => host.step()).not.toThrow();
  });
});
