import {
  AGENT_LUMEN,
  AGENT_NONE,
  AGENT_SONAR,
  AGENT_UMBRA,
  AGENT_ZEPHYR,
  CROUCH_HEIGHT,
  EYE_HEIGHT_STAND,
  MODE_MATCH,
  PHASE_BUY,
  PHASE_ROUND,
  SITE_ZONES,
  SPIKE_CARRIED,
  SPIKE_PLANTED,
  STAND_HEIGHT,
  TEAM_ATTACKERS,
  WEAPONS,
  createPrngState,
  nextRandom,
} from "@vg/sim";
import { MessageType, decodeMessageSafely, encodeMessage, type InputSample, type ProtocolMessage, type Transport } from "@vg/protocol";

// Bot movement/action lives here (server-side), not sim/src, so it is not
// bound by the sim's purity guard — it's free to use ordinary Math.* — but it
// still drives the connection purely through the wire protocol like any
// other client, so the exact same class works in-process (loopback
// Transport, used by tests) and over a real WebSocket (used by the `bots`
// CLI, see botsCli.ts).
const WAYPOINTS: ReadonlyArray<{ x: number; z: number }> = [
  { x: 12, z: 12 },
  { x: -12, z: 12 },
  { x: -12, z: -12 },
  { x: 12, z: -12 },
  { x: 0, z: 0 },
];

const WAYPOINT_ARRIVE_RADIUS = 1.5;
const SITE_ARRIVE_RADIUS = 2.0;
const DEFUSE_RANGE_M = 1.3; // a hair inside DEFUSE_RADIUS_M so bots don't hover right at the edge
const BURST_LEN_TICKS = 10;
const BURST_GAP_TICKS = 25;
const ENGAGE_RANGE_M = 40;
const AIM_ERROR_RAD = 0.06; // "small error", per spec

/** Site zone centers (2D), derived once from @vg/sim's SITE_ZONES — match-mode bots path to these. */
const SITE_CENTERS: ReadonlyArray<{ x: number; z: number }> = SITE_ZONES.map((zone) => ({
  x: (zone.box.minX + zone.box.maxX) / 2,
  z: (zone.box.minZ + zone.box.maxZ) / 2,
}));

interface KnownOther {
  x: number;
  y: number;
  z: number;
  crouching: boolean;
  alive: boolean;
  connected: boolean;
  team: number;
  health: number;
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
  private others: KnownOther[] = [];

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
        this.hasPrimary = me.weaponPrimary !== 255;
        this.team = me.team;
        this.agentId = me.agentId;
        this.abilityCharges = me.abilityCharges;
        this.ultPoints = me.ultPoints;
      }
      this.others = msg.players
        .filter((_, i) => i !== this.playerIndex)
        .map((p) => ({ x: p.posX, y: p.posY, z: p.posZ, crouching: p.crouching, alive: p.alive, connected: p.connected, team: p.team, health: p.health }));
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
  private nearestEnemy(pos: { x: number; z: number }): KnownOther | null {
    let best: KnownOther | null = null;
    let bestDist = ENGAGE_RANGE_M;
    for (const other of this.others) {
      if (!other.alive || !other.connected) continue;
      if (this.mode === MODE_MATCH && other.team === this.team) continue;
      const dist = Math.hypot(other.x - pos.x, other.z - pos.z);
      if (dist < bestDist) {
        best = other;
        bestDist = dist;
      }
    }
    return best;
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

    this.maybeBuy();

    const enemy = shouldInteract ? null : this.nearestEnemy(pos); // don't get distracted mid-channel
    // Movement heading (toward the OBJECTIVE) and look/aim yaw (toward an
    // enemy, if any) are deliberately decoupled: sim's InputFrame always
    // moves relative to whatever yaw is sent, so if an enemy is in range the
    // bot needs forward/right computed relative to the AIM yaw (not the
    // objective's raw heading), or firing at a target off to the side would
    // otherwise drag it off-course from the site/spike/defuse position.
    let yaw = Math.atan2(dx, dz); // no enemy: look the way we're walking
    let pitch = 0;
    let fire = false;
    if (enemy) {
      const edx = enemy.x - pos.x;
      const edz = enemy.z - pos.z;
      const horizontalDist = Math.max(0.5, Math.hypot(edx, edz));
      const enemyHeight = enemy.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const enemyBodyY = enemy.y + enemyHeight * 0.5;
      const dy = enemyBodyY - EYE_HEIGHT_STAND;
      yaw = Math.atan2(edx, edz) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
      pitch = Math.atan2(dy, horizontalDist) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
      fire = this.rand() < 0.5;
    }

    let forward = 0;
    let right = 0;
    if (!shouldInteract && !arrived && dist > 1e-6) {
      // Decompose the world-space wish direction (toward `target`) into
      // forward/right components relative to `yaw` (see movement.ts's
      // wishDirection(): forward = (sin(yaw), cos(yaw)), right = (cos(yaw), -sin(yaw))).
      const wishX = dx / dist;
      const wishZ = dz / dist;
      forward = wishX * Math.sin(yaw) + wishZ * Math.cos(yaw);
      right = wishX * Math.cos(yaw) - wishZ * Math.sin(yaw);
    }

    this.evaluateAbilityHeuristics(pos, enemy);
    this.send({
      forward,
      right,
      yaw,
      pitch,
      jump: false,
      crouch: false,
      walk: false,
      fire,
      ads: false,
      reload: false,
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

    // Bot aim: point at the nearest other player's last-known (interpolated,
    // from its perspective) position with small error, per spec — falls
    // back to the waypoint-wander heading when no enemy is in range.
    const enemy = this.nearestEnemy(pos);
    let yaw = wanderYaw;
    let pitch = 0;
    if (enemy) {
      const edx = enemy.x - pos.x;
      const edz = enemy.z - pos.z;
      const horizontalDist = Math.max(0.5, Math.hypot(edx, edz));
      const enemyHeight = enemy.crouching ? CROUCH_HEIGHT : STAND_HEIGHT;
      const enemyBodyY = enemy.y + enemyHeight * 0.5;
      const dy = enemyBodyY - EYE_HEIGHT_STAND;
      yaw = Math.atan2(edx, edz) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
      pitch = Math.atan2(dy, horizontalDist) + (this.rand() * 2 - 1) * AIM_ERROR_RAD;
    }

    // Burst-fire while wandering: alternate short firing bursts with gaps,
    // rather than a flat per-tick fire probability, so soaks exercise real
    // mag/reload/spray cycling instead of isolated single shots. Bots only
    // open fire when an enemy is actually in range.
    let fire = false;
    if (this.burstTicksLeft > 0) {
      fire = enemy !== null;
      this.burstTicksLeft--;
    } else if (this.ticksUntilNextBurst > 0) {
      this.ticksUntilNextBurst--;
    } else if (enemy && this.rand() < 0.6) {
      this.burstTicksLeft = BURST_LEN_TICKS;
      this.ticksUntilNextBurst = BURST_GAP_TICKS + this.randInt(40);
      fire = true;
      this.burstTicksLeft--;
    } else if (this.rand() < 0.15) {
      this.burstTicksLeft = BURST_LEN_TICKS;
      this.ticksUntilNextBurst = BURST_GAP_TICKS + this.randInt(40);
      fire = false; // no enemy in range: burst window still consumes, but stays silent
      this.burstTicksLeft--;
    } else {
      this.ticksUntilNextBurst = 5 + this.randInt(20);
    }

    this.evaluateAbilityHeuristics(pos, enemy);
    this.send({
      forward: 1,
      right: 0,
      yaw,
      pitch,
      jump: this.rand() < 0.01,
      crouch: this.rand() < 0.03,
      walk: false,
      fire,
      ads: false,
      reload: this.rand() < 0.01,
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
