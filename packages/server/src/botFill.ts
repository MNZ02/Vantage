// In-process bot fill for solo / local play: spawns Bot instances over
// loopback transports (no extra WebSocket connections), ticked at 64 Hz.
// Used by devServer when SOLO=1 or BOTS>0.
import { FIXED_DT } from "@vg/sim";
import { createLoopbackPair } from "@vg/protocol";
import { Bot } from "./bots.js";
import type { ServerHost } from "./serverHost.js";

export interface BotFillHandle {
  readonly bots: readonly Bot[];
  readonly count: number;
  stop(): void;
}

/**
 * Connects up to `count` bots to free slots on `host`. Returns fewer if the
 * lobby fills mid-spawn. Starts a 64 Hz timer that calls bot.tick() for each;
 * call stop() on shutdown (optional — process exit also cleans up).
 */
export function spawnBotFill(host: ServerHost, count: number, seedBase = 10_000): BotFillHandle {
  const bots: Bot[] = [];
  for (let i = 0; i < count; i++) {
    const [clientSide, serverSide] = createLoopbackPair();
    const index = host.connect(serverSide);
    if (index === -1) {
      clientSide.close();
      break;
    }
    bots.push(new Bot(clientSide, seedBase + i));
  }

  const timer = setInterval(() => {
    for (const bot of bots) bot.tick();
  }, FIXED_DT * 1000);
  // Don't keep the process alive solely for bot ticks if everything else stops.
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    bots,
    count: bots.length,
    stop() {
      clearInterval(timer);
      for (const bot of bots) {
        // Bot holds the client-side transport; closing it triggers server disconnect.
        // Access via a no-op close on the loopback by sending nothing — bots don't
        // expose transport. Leave slots held until process exit (dev-only).
        void bot;
      }
    },
  };
}
