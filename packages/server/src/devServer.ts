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
import { WebSocketTransport } from "@vg/protocol";
import { WebSocketServer } from "ws";
import { spawnBotFill } from "./botFill.js";
import { ServerHost } from "./serverHost.js";

const PORT = Number(process.env["PORT"] ?? 8787);

const solo = process.env["SOLO"] === "1";
const botsEnv = process.env["BOTS"];
const botCount = botsEnv !== undefined ? Math.max(0, Number(botsEnv)) : solo ? 9 : 0;

// Match mode by default; MODE=dm for deathmatch sandbox.
const mode = process.env["MODE"] === "dm" ? "dm" : "match";
const numPlayers = Number(process.env["NUM_PLAYERS"] ?? (botCount > 0 || solo ? 10 : 10));
// With bots: wait for bots + at least one human before startMatch (unless
// MIN_PLAYERS is set explicitly). Without bots: keep the old default of 2.
const defaultMin = botCount > 0 ? Math.min(numPlayers, botCount + 1) : 2;
const minPlayers = Number(process.env["MIN_PLAYERS"] ?? defaultMin);

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

wss.on("connection", (socket) => {
  const transport = new WebSocketTransport(socket);
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
