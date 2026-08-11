// Dev entrypoint: `pnpm --filter @vg/server dev` (or root `pnpm dev:server`).
// Listens on :8787 for both a curl-able health check and the WebSocket
// upgrade, on the same port/http.Server so there's one thing to point at.
//
// Solo / bot fill (local single-player):
//   SOLO=1          — 5v5 match, 9 in-process bots, minPlayers = bots+1 so the
//                     match starts when the human joins (waiting phase until then).
//   BOTS=N          — spawn N in-process bots (overrides SOLO's default 9).
//   NUM_PLAYERS / MIN_PLAYERS / MODE still work as before.
//   Or: `pnpm --filter @vg/server dev:solo` / root `pnpm dev:solo` (server only).
import { createServer } from "node:http";
import { WebSocketTransport, type Transport } from "@vg/protocol";
import { MAX_PLAYERS } from "@vg/sim";
import { WebSocketServer } from "ws";
import { spawnBotFill } from "./botFill.js";
import { ServerHost } from "./serverHost.js";

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], received ${raw ?? String(fallback)}`);
  }
  return value;
}

const PORT = integerEnv("PORT", 8787, 1, 65_535);
const MAX_BUFFERED_BYTES = 1 << 20;

const solo = process.env["SOLO"] === "1";
const numPlayers = integerEnv("NUM_PLAYERS", 10, 1, MAX_PLAYERS);
const botCount = integerEnv("BOTS", solo ? Math.min(9, numPlayers - 1) : 0, 0, Math.max(0, numPlayers - 1));

// Match mode by default; MODE=dm for deathmatch sandbox.
const rawMode = process.env["MODE"] ?? "match";
if (rawMode !== "dm" && rawMode !== "match") throw new RangeError(`MODE must be "dm" or "match", received ${rawMode}`);
const mode = rawMode;
// With bots: wait for bots + at least one human before startMatch (unless
// MIN_PLAYERS is set explicitly). Without bots: keep the old default of 2.
const defaultMin = botCount > 0 ? Math.min(numPlayers, botCount + 1) : Math.min(2, numPlayers);
const minPlayers = integerEnv("MIN_PLAYERS", defaultMin, 1, numPlayers);
const allowedOrigins = new Set(
  (process.env["ALLOWED_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 4096, perMessageDeflate: false });
const host = new ServerHost({ mode, numPlayers, minPlayers });

// Spawn bots BEFORE human clients so free WS slots remain for the player.
// Match stays in PHASE_WAITING until connectedCount >= minPlayers (bots + human).
let botFill: ReturnType<typeof spawnBotFill> | null = null;
if (botCount > 0) {
  botFill = spawnBotFill(host, botCount);
  // eslint-disable-next-line no-console
  console.log(
    `[server] solo/bot-fill: spawned ${botFill.count} in-process bot(s) ` +
      `(slots ${host.connectedCount()}/${numPlayers}, minPlayers=${minPlayers})`,
  );
}

wss.on("connection", (socket, request) => {
  const origin = request.headers.origin;
  if (allowedOrigins.size > 0 && (!origin || !allowedOrigins.has(origin))) {
    socket.close(1008, "origin not allowed");
    return;
  }
  socket.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.warn("[server] websocket error:", error.message);
  });
  const rawTransport = new WebSocketTransport(socket);
  const transport: Transport = {
    send(data) {
      if (socket.readyState !== 1) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        socket.close(1009, "client too slow");
        return;
      }
      rawTransport.send(data);
    },
    onMessage: (cb) => rawTransport.onMessage(cb),
    onClose: (cb) => rawTransport.onClose(cb),
    close: () => rawTransport.close(),
  };
  const playerIndex = host.connect(transport);
  if (playerIndex === -1) {
    // Match mode, no free slot: pending on this transport's first Hello to
    // decide whether it's a valid reconnect (see ServerHost.connect()'s doc
    // comment) — nothing more to log here until that resolves.
    // eslint-disable-next-line no-console
    console.log("[server] client connected -> match full, awaiting reconnect Hello");
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[server] client connected -> player ${playerIndex} ` +
      `(${host.connectedCount()} connected, phase=${host.getState().matchPhase})`,
  );
  socket.on("close", () => {
    // eslint-disable-next-line no-console
    console.log(`[server] player ${playerIndex} disconnected`);
  });
});

host.start();

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[server] listening on :${PORT} (ws:// and GET /health)` +
      (botFill ? ` · solo/bots=${botFill.count}` : "") +
      ` · mode=${mode} · slots=${numPlayers} · minPlayers=${minPlayers}`,
  );
  if (botFill && botFill.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`[server] open the client (pnpm dev) — match starts when a human joins`);
  }
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  host.stop();
  botFill?.stop();
  for (const socket of wss.clients) socket.close(1001, "server shutting down");
  wss.close(() => httpServer.close());
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
