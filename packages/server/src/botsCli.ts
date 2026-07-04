// Bot driver CLI: `pnpm --filter @vg/server bots -- --count 8 --url ws://localhost:8787`
// Connects `count` bots as normal clients over a real WebSocket transport and
// drives each with the same Bot class the in-process tests use.
import { FIXED_DT } from "@vg/sim";
import { WebSocketTransport } from "@vg/protocol";
import WebSocket from "ws";
import { Bot } from "./bots.js";

function parseArgs(argv: string[]): { count: number; url: string } {
  let count = 8;
  let url = "ws://localhost:8787";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--count" && argv[i + 1]) count = Number(argv[++i]);
    else if (argv[i] === "--url" && argv[i + 1]) url = argv[++i]!;
  }
  return { count, url };
}

const { count, url } = parseArgs(process.argv.slice(2));

// eslint-disable-next-line no-console
console.log(`[bots] connecting ${count} bot(s) to ${url}`);

let started = 0;
for (let i = 0; i < count; i++) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  socket.on("open", () => {
    const transport = new WebSocketTransport(socket);
    const bot = new Bot(transport, 1000 + i);
    setInterval(() => bot.tick(), FIXED_DT * 1000);
    started++;
    // eslint-disable-next-line no-console
    console.log(`[bots] bot ${i} connected (${started}/${count} up)`);
  });
  socket.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`[bots] bot ${i} error:`, err);
  });
}
