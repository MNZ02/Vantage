/**
 * Manual bot diagnostic (not part of the suite — run with tsx).
 *
 * Runs the same shrunk-timer soak as matchSoak.acceptance and reports why
 * rounds end: how many attackers are alive over time, how close the closest
 * attacker gets to its site, and how the round terminated. Written because
 * "plants dropped to zero" needed a cause, not a guess.
 *
 *   pnpm --filter @vg/server exec tsx test/botDiag.manual.ts
 */
import { createLoopbackPair, createVirtualClock, withLatency } from "@vg/protocol";
import {
  FIXED_DT,
  PHASE_MATCH_END,
  PHASE_ROUND,
  SITE_ZONES,
  SPIKE_CARRIED,
  SPIKE_PLANTED,
  TEAM_ATTACKERS,
} from "@vg/sim";
import { Bot } from "../src/bots.js";
import { ServerHost } from "../src/serverHost.js";

const NUM_BOTS = 10;
const host = new ServerHost({
  numPlayers: NUM_BOTS,
  seed: 42,
  mode: "match",
  minPlayers: NUM_BOTS,
  matchConfig: {
    buyTicks: 120,
    firstRoundBuyTicks: 120,
    roundTicks: 1400,
    spikeTicks: 200,
    plantTicks: 64,
    defuseTicks: 128,
    defuseCheckpointTicks: 64,
    roundEndTicks: 30,
    winTarget: 2,
    halfAtRound: 1,
  },
});
const clock = createVirtualClock();
const bots: Bot[] = [];
for (let slot = 0; slot < NUM_BOTS; slot++) {
  const [rawClient, rawServer] = createLoopbackPair();
  const t = withLatency(rawClient, { delayMs: 20, jitterMs: 5, lossRate: 0.01, seed: 6000 + slot, scheduler: clock.scheduler });
  bots.push(new Bot(t, 8000 + slot));
  host.connect(rawServer);
}

const sites = SITE_ZONES.map((z) => ({
  x: (z.box.minX + z.box.maxX) / 2,
  z: (z.box.minZ + z.box.maxZ) / 2,
}));

let tick = 0;
let lastRound = -1;
let minDistThisRound = Infinity;
let plantSeen = 0;
for (; tick < 20_000; tick++) {
  for (const b of bots) b.tick();
  clock.advance(FIXED_DT * 1000);
  host.step();
  const s = host.getState();
  if (s.matchPhase === PHASE_MATCH_END) break;

  if (s.round !== lastRound) {
    if (lastRound >= 0) {
      console.log(
        `  round ${lastRound}: closest attacker got ${minDistThisRound.toFixed(1)} m from a site`,
      );
    }
    lastRound = s.round;
    minDistThisRound = Infinity;
  }
  if (s.matchPhase !== PHASE_ROUND) continue;
  if (s.spikeState === SPIKE_PLANTED) plantSeen++;

  let atkAlive = 0;
  let defAlive = 0;
  for (let i = 0; i < s.numPlayers; i++) {
    const alive = s.health[i]! > 0;
    if (s.team[i] === TEAM_ATTACKERS) {
      if (alive) atkAlive++;
      if (alive) {
        for (const site of sites) {
          const d = Math.hypot(s.posX[i]! - site.x, s.posZ[i]! - site.z);
          if (d < minDistThisRound) minDistThisRound = d;
        }
      }
    } else if (alive) defAlive++;
  }
  if (tick % 200 === 0) {
    const c = s.spikeCarrier;
    let carrierInfo = "none";
    if (c !== 255 && c < s.numPlayers) {
      const cx = s.posX[c]!;
      const cz = s.posZ[c]!;
      const speed = Math.hypot(s.velX[c]!, s.velZ[c]!);
      const dists = sites.map((site) => Math.hypot(cx - site.x, cz - site.z));
      const inZone = SITE_ZONES.some(
        (z) => cx >= z.box.minX && cx <= z.box.maxX && cz >= z.box.minZ && cz <= z.box.maxZ,
      );
      carrierInfo =
        `#${c} alive=${s.health[c]! > 0} pos=(${cx.toFixed(1)},${cz.toFixed(1)}) ` +
        `dSite=${Math.min(...dists).toFixed(1)} speed=${speed.toFixed(2)} inZone=${inZone} ` +
        `plantProg=${s.plantProgress}`;
    }
    console.log(
      `t=${tick} phase=${s.matchPhase} atk=${atkAlive} def=${defAlive} spike=${s.spikeState} carrier=${carrierInfo}`,
    );
  }
}
console.log(`\nended at tick ${tick}, planted ticks seen = ${plantSeen}`);

console.log("kills:", host.getKills().length);
