# Browser Valorant Clone — Master Plan (v3)

A 5v5 round-based tactical FPS running entirely in the browser, replicating Valorant's
gameplay systems (movement, gunplay, abilities, economy, spike rounds) as faithfully as
the web platform allows.

Revision log:
- **v2:** fixed cross-engine determinism assumption, WebRTC (not WebSocket) fallback,
  added minimap/fog-of-war, tagging, agent select, weapon drop, pings; cut to 6 agents /
  1 map / WebGL2-only; re-based timeline.
- **v3:** restored ADS + sniper scopes (v2 dropped them — Operator without a scope is
  not an Operator); spike as a physical droppable object; browser-reality section
  (tab throttling, refresh/reconnect); ability prediction policy; animation iceberg
  called out; jitter buffer, hit-confirm policy, WebRTC server stack named; visibility-
  culling trade-off stated honestly; WASM decision recorded.

**IP note:** mechanics, formats, and game rules are not copyrightable — art, names, maps,
sounds, and characters are. Replicate *systems* 1:1; original assets, agent names, and
map layouts "inspired by" (not traced from) Riot's. Never ship Riot assets, the name
"Valorant", or recognizable agent likenesses.

---

## 1. Target experience (what "closest replica" means)

| System | Replication target |
|---|---|
| Format | 5v5, first to 13, swap after round 12, OT win-by-2 (full-buy creds each OT round) |
| Pre-match | Agent select (~80 s), no duplicate agents per team |
| Round flow | Buy 30 s (45 s each half's first round — verify vs live) → 100 s round → 45 s spike, 7 s defuse w/ 3.5 s checkpoint |
| Movement | Walk/run/crouch/jump; counter-strafe accuracy deadzone; jump-land accuracy penalty; crouch accuracy bonus; **tagging** (~70 % slow, ~0.5 s) |
| Gunplay | Hitscan, first-shot accuracy, fixed spray + random cone, **ADS with per-weapon zoom/spread/fire-rate changes, Operator-style 2-stage scope**, damage falloff bands, penetration classes, silenced-weapon tracer hiding (Phantom analog) |
| Spike | Physical object: carried (visible on carrier), dropped on death, pickup, team-visible on minimap when dropped/planted |
| Damage | Head/body/leg per weapon (rifle 160/40/34), 100 HP + 25/50 shield; assists; combat report |
| Economy | Start 800; kill 200; plant 300 to all attackers even on loss; loss bonus 1900/2400/2900; win 3000; cap 9000; buy-phase **refunds**; teammate buy requests + drop-for-teammate |
| Ultimates | Ult points from kills/deaths/plant/defuse + map ult orbs |
| Abilities | 4 per agent: 2 purchasable basics, recharging signature, ultimate; equip/cast delays replicated (they also mask netcode latency — see §3.2) |
| Agents | 6 at alpha (§3.5), all four roles covered |
| Maps | 1 at alpha (2-site, mid control, Valorant-scale timings); map 2 post-launch |
| Info game | Minimap w/ team-shared vision cones + fog of war, ping wheel + map pings, killfeed, damage direction indicators |
| Audio | HRTF positional footsteps w/ walk/run audibility radii, directional gunfire, ability cues, announcer |
| Netcode | Server-authoritative 64 tick, prediction, lag comp, server-side visibility culling |

Out of scope v1: ranked MMR, store, voice chat, player-facing replays (input logs
recorded from day 1, §3.7), console/mobile.

## 2. Tech stack

**Client**
- TypeScript; Three.js on **WebGL2 only** (WebGPU is a post-launch spike, not a dual
  path).
- Custom capsule-vs-BVH controller + raycasts shared with server; no physics engine.
- Pointer lock with `unadjustedMovement`; Web Audio HRTF.
- React/Preact DOM for menus & buy screen; in-canvas HUD (crosshair/killfeed/minimap).
- glTF + KTX2, Draco/meshopt; < 60 MB initial, per-map bundles.

**Browser reality (new in v3 — these are everyday events on the web, not edge cases):**
- **Tab backgrounding:** browsers throttle rAF and timers in hidden tabs; an alt-tabbed
  player would stall and time out. Run the network pump + sim heartbeat in a **Web
  Worker** (worker timers are throttled far less); render loop alone lives on rAF.
- **Refresh/crash reconnect:** session token in storage; server holds a disconnected
  player's slot for 90 s; rejoin restores full match state. Browser players *will*
  refresh mid-match — rejoin is an M3 feature, not post-launch polish.
- **Focus/pointer-lock loss** (Esc, OS popups): auto-pause input with on-screen
  re-engage prompt; never leave the player walking into a wall.

**Server**
- Node.js (or Bun) running the same TypeScript sim package as the client.
- **Determinism decision (recorded):** cross-engine bit-exactness is impossible in JS
  (`Math.sin/cos/atan2` are implementation-defined). Options considered:
  (a) TS sim + own math kernel (polynomial trig, seeded PRNG, no `Math.*`
  transcendentals) + drift-tolerant prediction; (b) Rust/AssemblyScript → WASM sim,
  where float ops *are* spec-deterministic. **Choice: (a)** for iteration speed — the
  sim is the most-churned code pre-alpha and TS keeps it hot-reloadable and debuggable.
  Golden-replay tests measure real drift; **if drift exceeds the epsilon budget in
  practice, port the sim to WASM at M4-time** — the pure-function sim boundary is
  designed so this port is mechanical, not a rewrite.
- Prediction tolerates drift: server wins; silent snap under epsilon (~1 mm / 0.01°),
  smoothed correction above.
- **Transport:** WebTransport (H3 datagrams) primary; **WebRTC unreliable DataChannel**
  fallback — not WebSocket (TCP head-of-line blocking turns one lost packet into a
  100 ms stall). Server-side WebRTC via `node-datachannel` (or geckos.io); server has
  public host candidates so no TURN for the common case, but expect a minority of
  corporate/CGNAT users to need a TURN deploy eventually. WebSocket remains only as
  "degraded but playable" + lobby traffic. Both real transports latency-tested at M1.
- **Tick:** 64 Hz sim (Valorant runs 128; at browser input/render jitter levels the
  64→128 hit-reg delta is noise, and it halves CPU + bandwidth). Snapshots 20–30 Hz,
  delta-compressed, quantized (16-bit pos/axis, 12-bit angles).
- **Input handling:** per-client adaptive jitter buffer (1–3 ticks) so late inputs
  don't cause server-side warping; inputs older than the buffer are dropped, not
  replayed (client reconciles).
- Services: matchmaker/lobby (stateless HTTP/WS), one game-server process per match,
  Docker on Fly.io/Hetzner, **multi-region + ping-based region select**, Postgres,
  Redis. Ballpark: a 64 Hz 10-player match fits in well under one vCPU — a €50/mo box
  per region carries dozens of concurrent matches; infra cost is not a v1 risk.

**Repo layout (pnpm monorepo)**
```
packages/
  sim/        # shared simulation + math kernel (pure, portable, WASM-port-ready)
  protocol/   # bit-packed binary message schemas
  client/     # renderer, input, prediction, interpolation, UI, worker net-pump
  server/     # authoritative sim host, lag comp, visibility, jitter buffer
  tools/      # map compiler, spray editor, bot driver, replay player, latency harness
services/
  matchmaker/ web/
```

## 3. Core systems design

### 3.1 Simulation
- Fixed 15.625 ms timestep, pure `tick(state, inputs)`, seeded PRNG in state, custom
  math kernel.
- ECS-lite typed arrays. Movement: run 6.75 m/s, walk 3.6, crouch ~3.4; accuracy
  recovery tuned by feel against reference footage. Accuracy modifiers stack:
  stance (crouch < stand), motion (still < walk < run), airborne/jump-land penalty,
  ADS bonus.
- **ADS:** per-weapon toggle — zoom level, tightened spread, reduced fire rate where
  applicable, tracer suppression on silenced weapons; Operator analog gets 2-stage
  scope with movement-speed penalty while scoped and scope-glint equivalent (audio cue).
- Tagging on hit (load-bearing for "first bullet wins" feel).
- Weapons: data-driven `weapons.json` (damage bands, fire rate, spray table + recovery,
  movement error, ADS block, penetration class, price, refund value). Pin values to one
  reference patch, noted in the file. Weapons + **spike** are world entities:
  drop/pickup/deliberate drop.
- Abilities as scripted sim entities: smokes = sphere occluders (fed to server
  visibility *and* flash LoS tests — you can't be flashed through a smoke), molotov
  DoT zones, flashes = view-angle + LoS raycast with partial-flash falloff, walls =
  temp collision + HP, recon = server sight query → minimap pings.
  **M4a status (recorded gap):** walls DO occlude visibility/flash/reveal LoS checks
  (added to the shared occluder list alongside static level geometry — a solid 0.4 m
  barrier blocks a sightline same as a real wall). Smokes do NOT yet occlude anything
  server-side, despite rendering as opaque spheres client-side: `@vg/sim`'s raycast
  module is AABB-only (no ray-vs-sphere primitive wired into the occlusion path), so
  "you can't be flashed through a smoke" isn't true yet. Deferred to a follow-up pass.

### 3.2 Netcode
- Inputs at 64 Hz upstream; snapshots down; predict self, interpolate others ~100 ms.
- Lag comp: 1 s hitbox ring buffer, rewind to client-perceived time, 200 ms cap.
- **Hit feedback policy:** crosshair hit-confirm and blood VFX are client-predicted
  (instant feel); damage numbers, killfeed, and death are server-confirmed. Mispredicted
  hitmarkers at the 200 ms+ fringe are the accepted cost of crisp feel.
- **Ability prediction policy (new):** predict *only self-mobility* (dash, updraft, TP
  start); everything else is server-confirmed, with Valorant's own equip/cast delays
  doing the latency-masking — this is precisely why Valorant abilities survive netcode,
  and we inherit the trick by replicating the delays.
- **Visibility culling, trade-off stated honestly:** server sends an enemy only when
  sampled raycasts (to hitbox extremes, amortized across ticks, smokes occlude) say
  they're visible or will be within a ~250 ms movement-prediction margin. This kills
  through-the-wall tracking outright, but a wallhacker still gains ~250 ms of early
  info at peek edges — that margin is the price of pop-free peeks at real latency.
  Tune margin per-playtest; it is a slider between cheat-power and pop-in, not a
  solved problem. Same visibility feeds team-shared minimap fog of war.
- Reconciliation: rewind + replay buffered inputs; epsilon snap per §2.

### 3.3 Rendering
- Forward WebGL2, baked lightmaps + few dynamic VFX lights; flat/painterly PBR-lite,
  strong baked AO, team-colored fresnel character outlines.
- Separate viewmodel camera pass; ADS/scope as FOV + overlay pass.
- Smokes: alpha-sphere impostors with opaque core matching server occlusion.
- Minimap: baked top-down image + server-filtered entity layer + client vision cones.
- 144+ fps @1080p mid GPUs, < 300 draw calls, instanced props; integrated-GPU testing
  from M0.

### 3.4 Maps
- Blender modular kit at Valorant metrics (door ~1.1 m, crate 1.2 m, wall 3 m).
- Map compiler: glTF → BVH, spawn/site/plant/orb zones, audio zones, nav mesh.
- Map 1 "Crossing": 2 sites, contestable mid; blockout → timing playtests
  (spawn-to-site 15–20 s) → art pass. Map 2 (3-site) post-launch.

### 3.5 Agents — 6 at alpha, 8 by launch
- **Duelist:** mobility entry (dash + updraft + knives-style ult).
- **Controller:** global smokes + short TP.
- **Initiator:** recon dart + shock darts — the info-game kit gets the most polish.
- **Sentinel A:** tripwires + cam (trap/info).
- **Sentinel B:** heal/wall/res (res is the hairiest ability under lag comp — hence
  second sentinel, not first).
- **Duelist 2:** flash/self-sustain breacher.
- Post-alpha: Initiator 2 (through-wall stuns), Controller 2 (orbital smokes).

### 3.6 The animation iceberg (new in v3 — the most underestimated line item)
Character *animation*, not modeling, is the hidden cost: 3rd-person needs run/strafe
blend spaces, crouch sets, plant/defuse, per-ability casts, deaths; 1st-person needs
arms per weapon (idle/fire/reload/equip/inspect). Plan: 2 shared body rigs, purchased
animation packs retargeted for all locomotion, custom animation *only* for ability
casts and plant/defuse. Commission art early so lead time overlaps M2–M4. Without this
constraint the art budget silently doubles.

### 3.7 Meta systems
- Accounts (guest + upgrade), party of 5, queue-order matchmaker v1, custom lobbies
  w/ room codes, AFK/leaver handling, surrender vote, scoreboard + combat report.
- Comms without voice: ping wheel, map pings, buy-phase request pings, text chat.
  Voice post-launch (SFU — real scope, not smuggled into v1).
- Practice range: targets, spray trainer, bot DM.
- Anti-cheat, honest version: visibility culling vs wallhacks, sanity checks (speed/
  angle/rate/stat outliers) vs rage hacking; subtle aimbots unsolvable in browser —
  position as casual/community + private lobbies.
- **Telemetry from M2:** hit-reg discrepancy metrics (client-predicted vs server-scored
  hits), RTT/loss distributions, fps percentiles — tuning netcode feel on vibes alone
  doesn't converge.

### 3.8 Testing & tooling
- Latency harness (delay/jitter/loss injection) lands with the first netcode commit;
  CI runs headless client-vs-server at 30/80/150 ms on **both transports**.
- Input-log replays (seed + input streams) from day 1: free bug repro + debug replay
  player.
- Bot driver at M1: scripted/recorded-input bots for 10-player load without 10 humans;
  later backfill.
- Sim unit tests (weapon math, economy, round state machine); golden-replay regression
  tests that fail on unintended sim drift — also the tripwire for the WASM-port
  decision (§2).
- **Weekly 10-player playtests from M2 onward** — recruiting a standing tester group is
  a real task on the schedule, not an assumption.

## 4. Milestones

**M0 — Foundation (2–3 wk):** monorepo, sim loop + math kernel, capsule controller,
graybox at 144 fps, pointer lock + worker net-pump skeleton. *Exit: smooth graybox run.*

**M1 — Netplay core (4–5 wk):** WebTransport + WebRTC paths, prediction/reconciliation/
interpolation, jitter buffer, latency harness + bots, 10 clients in graybox. *Exit:
hitscan between two browsers feels crisp at 80 ms simulated ping on both transports.*

**M2 — Gunplay (4 wk):** 6 weapon analogs incl. ADS + Operator scope, spray/counter-
strafe/tagging/jump-land penalties, damage/armor/assists, weapon drop/pickup, killfeed,
buy menu + economy + refunds, hit-reg debug overlay + telemetry. *Exit: deathmatch is
genuinely fun, and measured client/server hit discrepancy < 2 % at 80 ms —
**go/no-go gate for all content work**.*

**M3 — Round structure (3 wk):** spike as world object (carry/drop/plant/defuse),
round/half/OT state machine, cross-round economy incl. OT creds, barriers, team-only
death spectate, minimap + fog of war + pings, **mid-match reconnect**, agent-select
placeholder. *Exit: full 5v5 start-to-finish, surviving a mid-match tab refresh.*

**M4 — Abilities & agents (5–6 wk):** ability framework w/ prediction policy (§3.2),
6 alpha agents, ult points + orbs, agent select screen. *Exit: team comps matter.*

**M5 — Map art + audio (4 wk):** Crossing art pass, baked lighting, retargeted
animation sets integrated, HRTF footsteps w/ walk/run radii + occlusion, gun/ability
audio, announcer. *Exit: looks and sounds like a real game.*

**M6 — Meta & alpha (3–4 wk):** accounts, parties, matchmaker, lobbies, practice range,
settings (sens/crosshair editor/binds), multi-region deploy, closed alpha.

**M7 — Post-launch:** agents 7–8, map 2, rating, spectator, voice, WebGPU spike,
TURN deploy if fallback stats demand it.

**Timeline:** ~9–11 months solo with commissioned art/animation; ~4–6 months for
3 people. (v1 said 5–6 solo; v2 said 8–10; v3 adds ADS/scopes, reconnect, and the
animation reality — the number moves accordingly. Any further scope additions must
name the weeks they cost.)

## 5. Key risks

1. **Netcode feel** — shared sim from day 0, latency harness in CI, M1/M2 hard gates
   with *measured* exit criteria, telemetry from M2.
2. **Transport fragmentation** — WebRTC path first-class at M1; TURN contingency named.
3. **Prediction drift** — math kernel + epsilon snapping + golden replays; WASM port
   as the pre-planned escape hatch, cheap because the sim boundary is pure.
4. **Animation/art budget** — §3.6 constraint (2 rigs, purchased locomotion, custom
   only where identity demands); commission early.
5. **Browser platform quirks** — worker loop, reconnect, pointer-lock UX handled at
   M0–M3, not discovered in alpha.
6. **No real anti-cheat** — culling + sanity checks + community positioning; the 250 ms
   visibility margin is a tunable trade-off, documented, not hidden.
7. **Legal** — original everything; checklist per milestone; "Valorant-like" in public.

## 6. Immediate next steps

1. Scaffold pnpm monorepo (`sim`, `protocol`, `client`, `server`, `tools`).
2. M0: sim loop + math kernel + capsule controller + graybox; worker net-pump skeleton.
3. Latency harness with the first netcode commit.
4. Pin a reference patch and transcribe weapon/economy tables into `weapons.json`;
   flag buy-phase durations and tagging strength for verification against live footage.
5. Start art/animation commissioning conversations now (longest lead time in the plan).
