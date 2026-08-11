import {
  AGENT_LUMEN,
  AGENT_NONE,
  AGENT_SONAR,
  AGENT_UMBRA,
  AGENT_ZEPHYR,
  CROUCH_HEIGHT,
  EYE_HEIGHT_STAND,
  LEVEL_BOXES,
  MODE_MATCH,
  NORTH_WALL_Z,
  PHASE_BUY,
  PHASE_ROUND,
  SITE_LINE_Z,
  SITE_ZONES,
  SOUTH_WALL_Z,
  SPIKE_CARRIED,
  SPIKE_PLANTED,
  STAND_HEIGHT,
  TEAM_ATTACKERS,
  WEAPONS,
  createPrngState,
  nextRandom,
  raycastBoxes,
} from "@vg/sim";
import { MessageType, decodeMessageSafely, encodeMessage, type InputSample, type ProtocolMessage, type Transport } from "@vg/protocol";

// Bot movement/action lives here (server-side), not sim/src, so it is not
// bound by the sim's purity guard — it's free to use ordinary Math.* — but it
// still drives the connection purely through the wire protocol like any
// other client, so the exact same class works in-process (loopback
// Transport, used by tests) and over a real WebSocket (used by the `bots`
// CLI, see botsCli.ts).
// DM wander loop: one stop per district (both mains, mid lane, both sites,
// mid courtyard), each in open floor with straight-line reachability to its
// neighbors in list order (bots steer straight — no pathfinding).
const WAYPOINTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: -30, z: 0 }, // A main
  { x: -24, z: 18 }, // A site
  { x: 0, z: 24 }, // mid courtyard
  { x: 24, z: 18 }, // B site
  { x: 30, z: 0 }, // B main
  { x: 0, z: 0 }, // mid lane
];

const WAYPOINT_ARRIVE_RADIUS = 1.5;
const SITE_ARRIVE_RADIUS = 2.0;
const DEFUSE_RANGE_M = 1.3; // a hair inside DEFUSE_RADIUS_M so bots don't hover right at the edge
const BURST_LEN_TICKS = 10;
const BURST_GAP_TICKS = 25;
const ENGAGE_RANGE_M = 40;
const AIM_ERROR_RAD = 0.06; // baseline at mid range for a mid-skill bot

// ---- Perception model. Bots used to acquire any enemy within range + LOS
// instantly, including directly behind them — omniscient within 40 m. Now an
// enemy has to enter the bot's forward vision cone (or get close enough to be
// heard), stay unobstructed, and survive a human-ish reaction delay before the
// bot can open fire. All deterministic: geometry + the bot's own PRNG.
/** Half-angle of the forward vision cone (about the last yaw the bot SENT). */
const VISION_HALF_ANGLE_RAD = 1.05; // ≈60° each side, 120° cone
/** Inside this range, footsteps give the enemy away regardless of facing (LOS still required — hearing is not a wallhack). */
const HEARING_RADIUS_M = 9;
/** How long a lost target stays in memory (bot keeps watching the last-seen spot instead of instantly forgetting). */
const TARGET_MEMORY_TICKS = 96; // 1.5 s @ 64 Hz

/**
 * Below this health a bot breaks off instead of trading: it stops advancing on
 * the objective and holds/backs off. Bots used to push a site at 5 HP and feed.
 */
const LOW_HEALTH = 35;
/**
 * Distance at which a bot plants its feet to shoot rather than walking and
 * spraying. Movement spread scales with speed as a fraction of RUN_SPEED, so a
 * walking bot's shots go nowhere; standing still restores first-bullet
 * accuracy the same way it does for a player.
 */
const STOP_TO_SHOOT_RANGE_M = 32;
/** Rough magazine proxy — snapshots carry no ammo, so bots count their own shots. */
const SHOTS_BEFORE_RELOAD = 24;

/** Site zone centers (2D), derived once from @vg/sim's SITE_ZONES — match-mode bots path to these. */
const SITE_CENTERS: ReadonlyArray<{ x: number; z: number }> = SITE_ZONES.map((zone) => ({
  x: (zone.box.minX + zone.box.maxX) / 2,
  z: (zone.box.minZ + zone.box.maxZ) / 2,
}));

// ---- Corridor router for the "Crossing" v2 layout (see @vg/sim levels.ts's
// map diagram). Bots steer in straight lines, so crossing the map's walled
// z-bands (spawn strips / lanes / sites) needs waypoints through the wall
// gaps. nextNavPoint() is STATELESS — recomputed every tick from the current
// position — so there's no route-leg bookkeeping to desync: each call just
// answers "which gap (or the goal itself) should I walk toward right now?".
// Gap x-centers per boundary wall, west/mid/east (must match levels.ts's
// wall-segment gaps).
const SOUTH_GAP_X = [-24, 0, 24] as const;
const SITE_LINE_GAP_X = [-25, 0, 25] as const;
const NORTH_GAP_X = [-22, 0, 22] as const;
/** Cross-lane link gap through the lane dividers (x=±12), z in [-6,-1]. */
const LANE_LINK_Z = -3.5;
/** Site link gap through the site inner walls (x=±10), z in [14,20]. */
const SITE_LINK_Z = 17;
/** How far past a wall to place the through-gap waypoint (so "almost there" hands off to the next leg naturally). */
const GAP_OVERSHOOT = 1.5;

/** 0=S spawn strip, 1=lanes, 2=sites/courtyard, 3=N spawn strip. */
function bandOf(z: number): 0 | 1 | 2 | 3 {
  if (z < SOUTH_WALL_Z) return 0;
  if (z < SITE_LINE_Z) return 1;
  if (z < NORTH_WALL_Z) return 2;
  return 3;
}

/** -1=west, 0=mid, 1=east. Divider walls sit at x=±12 (band 1) / ±10 (band 2); ±11 splits both safely. */
function laneOf(x: number): -1 | 0 | 1 {
  return x < -11 ? -1 : x > 11 ? 1 : 0;
}

/** The point to steer toward RIGHT NOW to eventually reach `goal` — either the goal itself or the next wall gap en route. */
function nextNavPoint(pos: { x: number; z: number }, goal: { x: number; z: number }): { x: number; z: number } {
  const posBand = bandOf(pos.z);
  const goalBand = bandOf(goal.z);
  const goalLane = laneOf(goal.x);

  if (posBand === goalBand) {
    const posLane = laneOf(pos.x);
    if (posLane === goalLane || posBand === 0 || posBand === 3) return goal; // spawn strips are open east-west
    // Cross-lane hop within a walled band: through the divider link gap toward the goal's side.
    const dividerX = posLane === -1 || goalLane === -1 ? (posBand === 1 ? -12 : -10) : posBand === 1 ? 12 : 10;
    const towardGoal = goal.x > dividerX ? GAP_OVERSHOOT : -GAP_OVERSHOOT;
    return { x: dividerX + towardGoal, z: posBand === 1 ? LANE_LINK_Z : SITE_LINK_Z };
  }

  // Different band: cross the nearest boundary wall in the goal's direction,
  // through the gap of the CURRENT lane (band 1/2 lanes are walled off from
  // each other — lane changes happen via the same-band branch above once the
  // lane mismatch is what remains).
  const dir = goalBand > posBand ? 1 : -1;
  const boundaryBand = dir === 1 ? posBand : posBand - 1; // 0=south wall, 1=site line, 2=north wall
  const boundaryZ = boundaryBand === 0 ? SOUTH_WALL_Z : boundaryBand === 1 ? SITE_LINE_Z : NORTH_WALL_Z;
  const gapXs = boundaryBand === 0 ? SOUTH_GAP_X : boundaryBand === 1 ? SITE_LINE_GAP_X : NORTH_GAP_X;
  // From the open spawn strips any gap is reachable — pick the goal's lane;
  // inside the walled bands, stay in the current lane.
  const laneForGap = posBand === 0 || posBand === 3 ? goalLane : laneOf(pos.x);
  return { x: gapXs[laneForGap + 1]!, z: boundaryZ + dir * GAP_OVERSHOOT };
}

interface KnownOther {
  /** Server player index — stable identity for the perception memory. */
  index: number;
  x: number;
  y: number;
  z: number;
  crouching: boolean;
  alive: boolean;
  connected: boolean;
  team: number;
  health: number;
}

/** Per-enemy sighting record (ticks are server ticks from snapshots). */
interface Sighting {
  /** When the current unbroken period of visibility began (reaction timer base). */
  firstVisibleTick: number;
  /** Last tick the enemy was actually visible (memory expiry base). */
  lastVisibleTick: number;
  /** Last position seen — what the bot aims/looks toward after losing sight. */
  x: number;
  y: number;
  z: number;
  crouching: boolean;
}

/** What the perception pass hands the behavior code each tick. */
interface Target {
  /** Currently-visible enemy to shoot at, or null (never set through a wall). */
  live: KnownOther | null;
  /** Where to point the camera: the live enemy, or a remembered last-seen spot. */
  aim: { x: number; y: number; z: number; crouching: boolean } | null;
  /** True once the reaction delay since first sight has elapsed. */
  canFire: boolean;
}

/** Ability-cast probability per tick when a heuristic condition is met (kept low — spec: "occasionally cast", not every tick). */
const ABILITY_CAST_CHANCE = 0.02;
const HURT_TEAMMATE_HEALTH_THRESHOLD = 70;
const MEND_RANGE_M = 15; // a bit under Mend's 20m cast range, so the bot is reliably in range when it presses the button

export class Bot {
  private prngState: number;
  private seq = 0;
  private waypointIndex: number;
  private history: InputSample[] = [];
  private playerIndex: number | null = null;
  private lastKnownPos: { x: number; z: number } | null = null;
  private lastKnownServerTick = 0;
  private credits = 0;
  private alive = true;
  private hasPrimary = false;
  private burstTicksLeft = 0;
  private ticksUntilNextBurst = 0;
  private boughtOnce = false;
  private health = 100;
  private shotsSinceReload = 0;
  private reloadTicksLeft = 0;
  private others: KnownOther[] = [];
  /** Facing actually sent last tick — the vision cone points where the bot is looking, not where it wishes it were. */
  private lastSentYaw = 0;
  /** Sighting memory, keyed by server player index. */
  private readonly sightings = new Map<number, Sighting>();
  /**
   * Per-bot skill in [0,1), drawn once from the seed. Scales aim error and
   * reaction time so a lobby has sharp bots and sloppy bots instead of ten
   * clones of one flat constant.
   */
  private readonly skill: number;
  /** Ticks between first sighting and being allowed to fire (from skill: ~125–405 ms). */
  private readonly reactionTicks: number;

  // ---- M3 match awareness (only populated when the server runs mode: "match") ----
  private mode = 0; // MODE_DM by default
  private matchPhase = 0;
  private team = 255;
  private spikeState = 0;
  private spikeCarrier = 255;
  private spikeX = 0;
  private spikeZ = 0;
  /** Which of the two sites this bot commits to (stable per-instance so a squad naturally splits). */
  private readonly assignedSiteIndex: number;

  // ---- M4a ability awareness ----
  private agentId = AGENT_NONE;
  private abilityCharges: readonly [number, number, number, number] = [0, 0, 0, 0];
  private ultPoints = 0;
  /** Set once per tick when a cast heuristic fires; consumed by the send() call at the end of that tick's tick(). */
  private wantCast: { ability1: boolean; ability2: boolean; signature: boolean; ult: boolean } = {
    ability1: false,
    ability2: false,
    signature: false,
    ult: false,
  };

  constructor(
    private readonly transport: Transport,
    seed: number,
  ) {
    this.prngState = createPrngState(seed);
    this.waypointIndex = this.randInt(WAYPOINTS.length);
    this.assignedSiteIndex = this.randInt(Math.max(1, SITE_CENTERS.length));
    this.ticksUntilNextBurst = this.randInt(60);
    this.skill = this.rand();
    this.reactionTicks = 8 + Math.round((1 - this.skill) * 18); // 8..26 ticks
    transport.onMessage((data) => {
      const msg = decodeMessageSafely(data);
      if (msg !== null) this.handleMessage(msg);
    });
  }

  private rand(): number {
    const r = nextRandom(this.prngState);
    this.prngState = r.nextState;
    return r.value;
  }

  private randInt(maxExclusive: number): number {
    return Math.floor(this.rand() * maxExclusive);
  }

  private handleMessage(msg: ProtocolMessage): void {
    if (msg.type === MessageType.Welcome) {
      this.playerIndex = msg.playerIndex;
      this.lastKnownServerTick = msg.serverTick;
      this.mode = msg.mode;
      this.team = msg.team;
    } else if (msg.type === MessageType.Snapshot && this.playerIndex !== null) {
      this.lastKnownServerTick = msg.serverTick;
      this.mode = msg.mode;
      this.matchPhase = msg.matchPhase;
      this.spikeState = msg.spikeState;
      this.spikeCarrier = msg.spikeCarrier;
      this.spikeX = msg.spikeX;
      this.spikeZ = msg.spikeZ;
      const me = msg.players[this.playerIndex];
      if (me) {
        this.lastKnownPos = { x: me.posX, z: me.posZ };
        this.credits = me.credits;
        this.alive = me.alive;
        this.health = me.health;
        if (!me.alive) {
          // fresh magazine, clean burst state and empty sighting memory on
          // respawn — a dead bot should not wake up mid-reaction to a target
          // it saw in its previous life
          this.shotsSinceReload = 0;
          this.reloadTicksLeft = 0;
          this.burstTicksLeft = 0;
          this.sightings.clear();
        }
        this.hasPrimary = me.weaponPrimary !== 255;
        this.team = me.team;
        this.agentId = me.agentId;
        this.abilityCharges = me.abilityCharges;
        this.ultPoints = me.ultPoints;
      }
      this.others = msg.players
        .map((p, i) => ({ index: i, x: p.posX, y: p.posY, z: p.posZ, crouching: p.crouching, alive: p.alive, connected: p.connected, team: p.team, health: p.health }))
        .filter((p) => p.index !== this.playerIndex);
    }
  }

  /**
   * Simple per-agent cast heuristics, evaluated once per tick (spec: bots
   * "occasionally cast" — shock darts at enemies, smokes at sites, Lumen
   * heals hurt teammates, dash for the duelist bot). Deliberately scripted,
   * not combat-aware AI: enough to exercise every kit in the soak, no more.
   * `enemy`/`pos` are whatever this tick's movement logic already computed.
   */
  private evaluateAbilityHeuristics(pos: { x: number; z: number }, enemy: KnownOther | null): void {
    this.wantCast = { ability1: false, ability2: false, signature: false, ult: false };
    if (!this.alive || this.agentId === AGENT_NONE) return;

    if (this.agentId === AGENT_SONAR) {
      // Shock dart at a spotted enemy.
      if (enemy && this.abilityCharges[0] > 0 && this.rand() < ABILITY_CAST_CHANCE) this.wantCast.ability1 = true;
      if (this.ultPoints >= 8 && this.rand() < ABILITY_CAST_CHANCE * 0.3) this.wantCast.ult = true;
    } else if (this.agentId === AGENT_UMBRA) {
      // Smoke (signature/shroud) roughly at a site while pushing/holding.
      if (this.abilityCharges[2] > 0 && this.rand() < ABILITY_CAST_CHANCE) this.wantCast.signature = true;
    } else if (this.agentId === AGENT_LUMEN) {
      const hurtTeammateNearby = this.others.some(
        (o) => o.alive && o.team === this.team && o.health > 0 && o.health < HURT_TEAMMATE_HEALTH_THRESHOLD && Math.hypot(o.x - pos.x, o.z - pos.z) <= MEND_RANGE_M,
      );
      if (hurtTeammateNearby && this.abilityCharges[2] > 0 && this.rand() < ABILITY_CAST_CHANCE * 2) this.wantCast.signature = true;
    } else if (this.agentId === AGENT_ZEPHYR) {
      // Dash while actually moving somewhere (signature).
      if (this.abilityCharges[2] > 0 && this.rand() < ABILITY_CAST_CHANCE) this.wantCast.signature = true;
      if (this.ultPoints >= 7 && enemy && this.rand() < ABILITY_CAST_CHANCE * 0.3) this.wantCast.ult = true;
    }
  }

  /**
   * Nearest connected, alive other player within ENGAGE_RANGE_M of `pos`, or
   * null. In match mode, "enemy" means it (teammates are filtered out) —
   * getting this wrong was a real bug: without the team filter, bots would
   * usually lock onto the nearest TEAMMATE (who's headed to the same
   * objective) and "fight" them, which friendly-fire-off makes harmless but
   * pointless, starving the soak of any actual cross-team engagements.
   */
  /**
   * Perception pass + target selection, replacing the old nearestEnemy().
   *
   * An enemy becomes VISIBLE when it is inside the forward vision cone (about
   * the yaw actually sent last tick) or inside HEARING_RADIUS_M, AND has clear
   * line of sight. Visibility starts a reaction timer; only after
   * `reactionTicks` may the bot fire. Losing sight keeps the enemy in memory
   * for TARGET_MEMORY_TICKS — the bot keeps watching the last-seen spot — but
   * memory never licenses firing: `live` (and therefore shooting) is strictly
   * present-tense visibility.
   */
  private acquireTarget(pos: { x: number; z: number }): Target {
    const now = this.lastKnownServerTick;
    const visible = new Set<number>();
    for (const other of this.others) {
      if (!other.alive || !other.connected) continue;
      if (this.mode === MODE_MATCH && other.team === this.team) continue;
      const dx = other.x - pos.x;
      const dz = other.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= ENGAGE_RANGE_M) continue;
      if (dist > HEARING_RADIUS_M) {
        // outside earshot: must be in the cone the bot is actually facing
        let diff = Math.atan2(dx, dz) - this.lastSentYaw;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        if (Math.abs(diff) > VISION_HALF_ANGLE_RAD) continue;
      }
      if (!this.hasLineOfSight(pos, other)) continue;
      visible.add(other.index);
      const rec = this.sightings.get(other.index);
      if (rec) {
        rec.lastVisibleTick = now;
        rec.x = other.x;
        rec.y = other.y;
        rec.z = other.z;
        rec.crouching = other.crouching;
      } else {
        this.sightings.set(other.index, {
          firstVisibleTick: now,
          lastVisibleTick: now,
          x: other.x,
          y: other.y,
          z: other.z,
          crouching: other.crouching,
        });
      }
    }
    // expire stale memories (and records of the now-dead/disconnected)
    for (const [idx, rec] of this.sightings) {
      const other = this.others.find((o) => o.index === idx);
      const gone = !other || !other.alive || !other.connected;
      if (gone || now - rec.lastVisibleTick > TARGET_MEMORY_TICKS) this.sightings.delete(idx);
    }

    // live target: nearest currently-visible enemy
    let live: KnownOther | null = null;
    let bestDist = Infinity;
    for (const other of this.others) {
      if (!visible.has(other.index)) continue;
      const dist = Math.hypot(other.x - pos.x, other.z - pos.z);
      if (dist < bestDist) {
        live = other;
        bestDist = dist;
      }
    }
    if (live) {
      const rec = this.sightings.get(live.index)!;
      return { live, aim: live, canFire: now - rec.firstVisibleTick >= this.reactionTicks };
    }
    // no live target: keep eyes on the freshest memory, if any
    let mem: Sighting | null = null;
    for (const rec of this.sightings.values()) {
      if (!mem || rec.lastVisibleTick > mem.lastVisibleTick) mem = rec;
    }
    return { live: null, aim: mem, canFire: false };
  }

  /**
   * Aim error grows with distance and shrinks with skill (flat AIM_ERROR_RAD
   * before). Curve anchored so a mid-skill bot at ~13 m matches the old flat
   * error: Crossing's lane fights sit at 20-40 m, and a first draft that
   * doubled the error there dropped the whole-match kill count to 5 and
   * zeroed the killfeed soak.
   */
  private aimErrorRad(dist: number): number {
    return AIM_ERROR_RAD * (1.35 - 0.7 * this.skill) * (0.7 + dist / 45);
  }

  /**
   * Clear shot from this bot's eye to an enemy's centre of mass?
   *
   * Without this, target selection was pure distance, so bots locked onto and
   * fired at enemies through solid walls — burning magazines into geometry,
   * standing still to "fight" someone two rooms away, and never engaging the
   * opponent actually in front of them. LEVEL_BOXES is static level data the
   * server already owns, and it's used here only to RESTRICT behaviour.
   */
  private hasLineOfSight(pos: { x: number; z: number }, other: KnownOther): boolean {
    const height = other.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
    const ox = pos.x;
    const oy = EYE_HEIGHT_STAND;
    const oz = pos.z;
    const dx = other.x - ox;
    const dy = other.y + height * 0.5 - oy;
    const dz = other.z - oz;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-3) return true;
    const hit = raycastBoxes(
      LEVEL_BOXES,
      { x: ox, y: oy, z: oz },
      { x: dx / dist, y: dy / dist, z: dz / dist },
      dist - 0.15, // stop short of the body so the target itself never counts
    );
    return hit === null;
  }

  /**
   * Burst-fire state machine, shared by both modes. Match bots previously used
   * a flat `rand() < 0.5`, i.e. ~32 trigger pulls a second held down forever —
   * no recoil discipline, no reload window, and nothing resembling how the
   * weapon is meant to be fired. Returns whether to hold fire this tick.
   */
  private updateBurst(enemy: KnownOther | null): boolean {
    if (this.burstTicksLeft > 0) {
      this.burstTicksLeft--;
      if (enemy) {
        this.shotsSinceReload++;
        return true;
      }
      return false;
    }
    if (this.ticksUntilNextBurst > 0) {
      this.ticksUntilNextBurst--;
      return false;
    }
    if (enemy && this.rand() < 0.6) {
      this.burstTicksLeft = BURST_LEN_TICKS - 1;
      this.ticksUntilNextBurst = BURST_GAP_TICKS + this.randInt(40);
      this.shotsSinceReload++;
      return true;
    }
    this.ticksUntilNextBurst = 5 + this.randInt(20);
    return false;
  }

  /** Occasionally buys a random affordable weapon (bot economy, so combat soaks exercise weapon variety). */
  private maybeBuy(): void {
    if (!this.alive) return;
    // Buy once early, then only rarely re-buy (e.g. after losing a primary on death).
    if (this.boughtOnce && this.hasPrimary) return;
    if (this.rand() > 0.02) return;

    const affordable = WEAPONS.filter((w) => w.price > 0 && w.price <= this.credits);
    if (affordable.length === 0) return;
    const pick = affordable[this.randInt(affordable.length)]!;
    this.transport.send(encodeMessage({ type: MessageType.BuyCmd, itemId: pick.id }));
    this.boughtOnce = true;
  }

  /** Produces and sends exactly one tick's worth of scripted input (call at 64 Hz). */
  tick(): void {
    if (this.mode === MODE_MATCH) {
      this.tickMatch();
    } else {
      this.tickDeathmatch();
    }
  }

  private send(sample: InputSample): void {
    this.lastSentYaw = sample.yaw; // the vision cone tracks what was actually sent
    this.history.push(sample);
    if (this.history.length > 3) this.history.shift();
    const firstSeq = this.seq - this.history.length + 1;

    this.transport.send(
      encodeMessage({
        type: MessageType.InputBatch,
        firstSeq,
        viewTick: this.lastKnownServerTick,
        frames: this.history.slice(),
      }),
    );
    this.seq++;
  }

  private idleSample(yaw = 0): InputSample {
    return {
      forward: 0,
      right: 0,
      yaw,
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

  /**
   * M3 match-aware behavior: buy at buy phase; attackers path the spike
   * carrier toward a site and hold interact to plant once there; other
   * attackers push toward the same site; defenders roam between sites and
   * hold interact to defuse once the spike is planted and they're in range.
   * Deliberately simple/scripted (spec: "keep it simple/scripted; must
   * produce plants+defuses in the soak"), not a full combat-aware AI.
   */
  private tickMatch(): void {
    const pos = this.lastKnownPos ?? { x: 0, z: 0 };

    if (this.matchPhase === PHASE_BUY) {
      this.maybeBuy();
      this.send(this.idleSample(0));
      return;
    }

    if (this.matchPhase !== PHASE_ROUND) {
      this.send(this.idleSample(0));
      return;
    }

    const isAttacker = this.team === TEAM_ATTACKERS;
    const isCarrier = this.spikeCarrier === this.playerIndex && this.spikeState === SPIKE_CARRIED;
    const spikePlanted = this.spikeState === SPIKE_PLANTED;
    /**
     * Who is on a clock and must keep moving through contact, rather than
     * stopping to duel: attackers until the spike is down, defenders once it
     * is. That also happens to be the right read of each side's job — attackers
     * execute, defenders hold angles, and the roles swap on the plant.
     *
     * Gating this on the carrier alone was not enough: when the carrier died,
     * every remaining attacker stopped at the first sightline, nobody
     * retrieved the dropped spike, and the soak went from reliable plants to
     * zero.
     */
    const objectiveCritical = isAttacker ? !spikePlanted : spikePlanted;

    let target: { x: number; z: number };
    let arriveRadius = SITE_ARRIVE_RADIUS;
    let shouldInteract = false;

    if (isAttacker) {
      target = SITE_CENTERS[this.assignedSiteIndex % Math.max(1, SITE_CENTERS.length)] ?? { x: 0, z: 0 };
      if (isCarrier) {
        const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
        shouldInteract = dist <= arriveRadius;
      }
    } else if (spikePlanted) {
      target = { x: this.spikeX, z: this.spikeZ };
      arriveRadius = DEFUSE_RANGE_M;
      const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
      shouldInteract = dist <= arriveRadius;
    } else {
      // Patrol between sites while nothing is planted.
      target = SITE_CENTERS[this.waypointIndex % Math.max(1, SITE_CENTERS.length)] ?? { x: 0, z: 0 };
      const dist = Math.hypot(target.x - pos.x, target.z - pos.z);
      if (dist < WAYPOINT_ARRIVE_RADIUS) this.waypointIndex = (this.waypointIndex + 1) % Math.max(1, SITE_CENTERS.length);
    }

    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    const arrived = dist <= arriveRadius;

    // Steer toward the corridor router's next gap waypoint (which is `target`
    // itself once no walls remain between here and there); arrival/interact
    // distances above stay measured against the FINAL objective.
    const nav = nextNavPoint(pos, target);
    const navDx = nav.x - pos.x;
    const navDz = nav.z - pos.z;
    const navDist = Math.hypot(navDx, navDz);

    this.maybeBuy();

    // don't get distracted mid-channel
    const t = shouldInteract ? { live: null, aim: null, canFire: false } : this.acquireTarget(pos);
    const enemy = t.live;
    // Movement heading (toward the OBJECTIVE) and look/aim yaw (toward an
    // enemy, if any) are deliberately decoupled: sim's InputFrame always
    // moves relative to whatever yaw is sent, so if an enemy is in range the
    // bot needs forward/right computed relative to the AIM yaw (not the
    // objective's raw heading), or firing at a target off to the side would
    // otherwise drag it off-course from the site/spike/defuse position.
    let yaw = Math.atan2(navDx, navDz); // no enemy: look the way we're walking
    let pitch = 0;
    let fire = false;
    let crouch = false;
    let holdPosition = false;
    let enemyDist = Infinity;
    if (t.aim) {
      // Aim at the live enemy, or keep watching a remembered spot after
      // losing sight (instead of instantly snapping back to the objective).
      const edx = t.aim.x - pos.x;
      const edz = t.aim.z - pos.z;
      enemyDist = Math.hypot(edx, edz);
      const horizontalDist = Math.max(0.5, enemyDist);
      const enemyHeight = t.aim.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const enemyBodyY = t.aim.y + enemyHeight * 0.5;
      const dy = enemyBodyY - EYE_HEIGHT_STAND;
      const err = this.aimErrorRad(enemyDist);
      yaw = Math.atan2(edx, edz) + (this.rand() * 2 - 1) * err;
      pitch = Math.atan2(dy, horizontalDist) + (this.rand() * 2 - 1) * err;
    }
    // Fire only at a LIVE, reaction-cleared target — never at a memory.
    fire = this.updateBurst(t.canFire ? enemy : null);
    if (enemy && t.canFire) {
      // Stop-and-pop: plant the feet only for the ticks actually spent firing,
      // then move again during the burst gap. Movement spread scales with
      // ground speed, so a walking bot's bursts go nowhere — but holding still
      // for the whole engagement is worse. Stopping outright for any visible
      // enemy made defenders holding angles unbeatable: they killed every
      // attacker before a site was reached and the soak produced zero plants.
      holdPosition = !objectiveCritical && fire && enemyDist <= STOP_TO_SHOOT_RANGE_M;
      crouch = holdPosition && enemyDist > 8;
    }

    // Reload out of contact rather than dry-firing into the next fight.
    let reload = false;
    if (this.reloadTicksLeft > 0) {
      this.reloadTicksLeft--;
      reload = true;
    } else if (this.shotsSinceReload >= SHOTS_BEFORE_RELOAD && !fire) {
      reload = true;
      this.reloadTicksLeft = 8;
      this.shotsSinceReload = 0;
    }

    // Hurt bots in contact back off instead of trading. Expressed as a
    // backpedal rather than a "stand still when hurt" rule, which would freeze
    // a wounded bot in the open indefinitely and never resolve.
    const wounded = this.health > 0 && this.health < LOW_HEALTH;
    const retreat = wounded && enemy !== null && !objectiveCritical;

    let forward = 0;
    let right = 0;
    if (!shouldInteract && retreat) {
      forward = -1; // yaw already faces the enemy, so this walks straight back
    } else if (!shouldInteract && !arrived && !holdPosition && navDist > 1e-6) {
      // Decompose the world-space wish direction (toward the nav waypoint)
      // into forward/right components relative to `yaw` (see movement.ts's
      // wishDirection(): forward = (sin(yaw), cos(yaw)), right = (-cos(yaw), sin(yaw))).
      const wishX = navDx / navDist;
      const wishZ = navDz / navDist;
      forward = wishX * Math.sin(yaw) + wishZ * Math.cos(yaw);
      right = -wishX * Math.cos(yaw) + wishZ * Math.sin(yaw);
    }

    this.evaluateAbilityHeuristics(pos, enemy);
    this.send({
      forward,
      right,
      yaw,
      pitch,
      jump: false,
      crouch,
      walk: false,
      fire,
      ads: false,
      reload,
      slot1: false,
      slot2: false,
      interact: shouldInteract,
      ping: false,
      ability1: this.wantCast.ability1,
      ability2: this.wantCast.ability2,
      signature: this.wantCast.signature,
      ult: this.wantCast.ult,
    });
  }

  private tickDeathmatch(): void {
    const target = WAYPOINTS[this.waypointIndex]!;
    const pos = this.lastKnownPos ?? { x: 0, z: 0 };
    const dx = target.x - pos.x;
    const dz = target.z - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist < WAYPOINT_ARRIVE_RADIUS) {
      this.waypointIndex = (this.waypointIndex + 1) % WAYPOINTS.length;
    }
    // Sim convention (see movement.ts wishDirection): yaw=0 faces +Z, and the
    // world-space forward direction is (sin(yaw), cos(yaw)) — so facing
    // (dx, dz) is yaw = atan2(dx, dz).
    const wanderYaw = Math.atan2(dx, dz);

    this.maybeBuy();

    // Bot aim: point at the current perceived target (live enemy, or the
    // remembered last-seen spot) with distance/skill-scaled error — falls
    // back to the waypoint-wander heading when nothing is perceived.
    const t = this.acquireTarget(pos);
    const enemy = t.live;
    let yaw = wanderYaw;
    let pitch = 0;
    if (t.aim) {
      const edx = t.aim.x - pos.x;
      const edz = t.aim.z - pos.z;
      const dist = Math.hypot(edx, edz);
      const horizontalDist = Math.max(0.5, dist);
      const enemyHeight = t.aim.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const enemyBodyY = t.aim.y + enemyHeight * 0.5;
      const dy = enemyBodyY - EYE_HEIGHT_STAND;
      const err = this.aimErrorRad(dist);
      yaw = Math.atan2(edx, edz) + (this.rand() * 2 - 1) * err;
      pitch = Math.atan2(dy, horizontalDist) + (this.rand() * 2 - 1) * err;
    }

    // Burst-fire while wandering: alternate short firing bursts with gaps,
    // rather than a flat per-tick fire probability, so soaks exercise real
    // mag/reload/spray cycling instead of isolated single shots. Bots only
    // open fire at a live, reaction-cleared target — never at a memory.
    const fire = this.updateBurst(t.canFire ? enemy : null);

    // Same out-of-contact reload rule the match bots use.
    let reload = false;
    if (this.reloadTicksLeft > 0) {
      this.reloadTicksLeft--;
      reload = true;
    } else if (this.shotsSinceReload >= SHOTS_BEFORE_RELOAD && !fire) {
      reload = true;
      this.reloadTicksLeft = 8;
      this.shotsSinceReload = 0;
    }

    this.evaluateAbilityHeuristics(pos, enemy);
    this.send({
      // Stop to shoot, same as match mode — a walking bot's spread is wide
      // enough that its bursts are mostly wasted. Keep moving while the
      // reaction timer runs so bots don't freeze before they can even fire.
      forward: enemy && t.canFire ? 0 : 1,
      right: 0,
      yaw,
      pitch,
      jump: this.rand() < 0.01,
      crouch: enemy !== null && t.canFire && this.rand() < 0.4,
      walk: false,
      fire,
      ads: false,
      reload,
      slot1: false,
      slot2: false,
      interact: false,
      ping: false,
      ability1: this.wantCast.ability1,
      ability2: this.wantCast.ability2,
      signature: this.wantCast.signature,
      ult: this.wantCast.ult,
    });
  }
}
