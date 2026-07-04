// Dev entrypoint: `pnpm --filter @vg/server dev` (or root `pnpm dev:server`).
// Listens on :8787 for both a curl-able health check and the WebSocket
// upgrade, on the same port/http.Server so there's one thing to point at.
import { createServer } from "node:http";
import { WebSocketTransport } from "@vg/protocol";
import { WebSocketServer } from "ws";
import { ServerHost } from "./serverHost.js";

const PORT = Number(process.env["PORT"] ?? 8787);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer });
const host = new ServerHost();

wss.on("connection", (socket) => {
  const transport = new WebSocketTransport(socket);
  const playerIndex = host.connect(transport);
  // eslint-disable-next-line no-console
  console.log(`[server] client connected -> player ${playerIndex} (${host.connectedCount()} connected)`);
  socket.on("close", () => {
    // eslint-disable-next-line no-console
    console.log(`[server] player ${playerIndex} disconnected`);
  });
});

host.start();

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on :${PORT} (ws:// and GET /health)`);
});
