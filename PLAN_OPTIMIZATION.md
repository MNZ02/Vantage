# Optimization & Netcode-Integrity Plan

Execution plan derived from a full-codebase performance/architecture review
(2026-07-07). Each task below is written to be executable **standalone by an
implementer who has not read the rest of this file or the review** — every task
carries its own context, exact anchors, constraints, and acceptance criteria.

## Ground rules (read before ANY task — these override convenience)

1. **The sim must stay deterministic.** Nothing in `packages/sim/src` may call
   `Date.now()`, `Math.random()`, `performance.now()`, or `Math.sin/cos/atan2`
   (use `math.ts`'s `sinApprox`/`cosApprox` and `prng.ts`). Same
   `(state, inputs, boxes)` in → same state out, always. `packages/sim/test/purity.test.ts`
   enforces some of this; do not weaken it.
2. **Do not change the wire format** (`packages/protocol/src/messages.ts`)
   unless the task explicitly says so. If you do, bump `PROTOCOL_VERSION`.
3. **`sim`/`protocol`/`server` are consumed from built `dist/`.** After editing
   any of them, run `pnpm build:libs` (or just use the root `pnpm test` /
   `pnpm typecheck`, which do it for you) or the client/server will silently
   run stale code.
4. **Every task ends with:** `pnpm typecheck && pnpm test` green, plus the
   task's own acceptance criteria. If a task has a "measure" step, record the
   before/after numbers in the PR description.
5. **Don't bundle tasks.** One task = one branch/PR unless a task explicitly
   lists another as a prerequisite.
6. Match surrounding code style. Doc comments in this repo explain *why*;
   keep that convention.

## How to measure (used by several tasks)

- Run the game: `pnpm dev:server` in one terminal, `pnpm dev` in another,
  open the printed Vite URL. Bots: `pnpm --filter @vg/server bots` if needed
  (see `packages/server/src/botsCli.ts`).
- Frame timing / GC: Chrome DevTools → Performance panel, record 20s of play.
  Allocation churn: Memory panel → Allocation instrumentation on timeline.
- Draw calls: after Task 2 lands, read the debug HUD; before that,
  `renderer.info.render.calls` in a console probe.

---

## Task 0 — Perf instrumentation in the debug HUD

**Priority: first. Everything else cites numbers this produces. Small, low risk.**

**Context.** The client already has a debug HUD: `createFpsCounter()` in
`packages/client/src/render.ts` (~line 124) shows `fps:` plus extra lines fed
from `fpsCounter.updateExtra([...])` in `packages/client/src/main.ts` (~line
730), which currently shows rtt / snapshot age / corrections/s / interp
starvation / hitreg agreement. We want the rendering/memory equivalents.

**Change.** In `main.ts`'s `frame()` loop, compute and append three lines to
the existing `updateExtra` array:

1. `draw calls: N` — `renderer.info.render.calls` (read after
   `renderer.render(...)`; `renderer` is in scope). Also show
   `renderer.info.render.triangles`.
2. `frame p99: X.Xms` — keep a rolling buffer of the last 240 values of
   `frameSeconds * 1000` (a plain preallocated `Float64Array(240)` + write
   index; no per-frame allocation), and every 30 frames recompute p99 by
   copying into a scratch array and sorting. Sorting 240 numbers every 30
   frames is fine.
3. `heap: X.X MB (+Y.Y/s)` — `performance.memory.usedJSHeapSize` where
   available (Chrome only; feature-detect, omit the line otherwise), with a
   delta-per-second computed over a 5s window. The *growth rate between GCs*
   is the allocation-pressure signal Tasks 3–6 will cite.

Throttle the whole `updateExtra` call (and the existing `fpsCounter.update`)
to ~4 Hz — per-frame `textContent` writes are themselves overhead (see Task
5); a `lastHudUpdateMs` timestamp check suffices.

**Do NOT** add any per-frame allocations in the process (no `.map`, no array
literals inside `frame()` — build the lines array only inside the 4 Hz branch).

**Accept when:** HUD shows the new lines in both online and offline mode;
recording a Performance profile shows no new recurring allocation from the HUD
code; typecheck/test green.

---

## Task 1 — Server-side enemy-position culling (anti-wallhack)

**Priority: highest impact. Medium size, medium risk. Server-only; no wire
format change needed.**

**Context.** Every snapshot currently sends every player's exact position to
every client. In `packages/server/src/serverHost.ts`, `broadcastSnapshot()`
builds ONE shared `players` array (loop ending ~line 1304) and sends it to all
recipients in the per-client loop at ~line 1330. The only per-recipient field
is `visibleEnemyMask` (used by the client minimap). A cheating client can read
all enemy positions from any snapshot = wallhack/ESP. PLAN.md §"Netcode"
promises server-side visibility culling. The server already computes a
per-team visibility mask — find `getVisibilityMask` and the visibility update
logic (`updateVisibility`, ~line 912 region) — so line-of-sight machinery
exists and this task mostly *applies* it to the snapshot payload.

**Change.** In `broadcastSnapshot()`, for each recipient build the effective
`players` array by starting from the shared one and **masking hidden enemies**:

- A player `i` is *visible to recipient r* if any of: same team as `r`
  (`state.team`); `r`'s team mask bit set (`getVisibilityMask(recipientTeam) & (1 << i)`);
  `i` is dead (death positions are public info — killfeed/death markers
  already reveal them); mode is DM (`!isMatch`); or `i === r`'s own index.
- **Grace period:** keep sending a player for `VISIBILITY_GRACE_TICKS = 16`
  (~250 ms) after they were last visible, so a peeker doesn't pop into
  existence mid-peek on the victim's screen. Track
  `lastVisibleTick[recipientTeam][playerIndex]` (a small 2×MAX_PLAYERS
  Int32Array on the host, updated where the visibility mask is recomputed).
- For a *masked* player, do not drop them from the array (the wire format and
  client index-by-position assume a full array). Send the row with:
  `connected: true, alive: true` BUT positions frozen at their **last visible
  position** (store per-team last-visible x/y/z; initialize to spawn), and
  yaw/pitch/vel zeroed. Rationale: a vanishing/0,0,0 player would teleport
  audio/visuals; a frozen last-known position degrades gracefully and is
  exactly the information the recipient legitimately has.
- Fields that leak nothing positional (health, team, agentId, weapon ids…)
  may pass through unchanged.

**Client side:** no change required to render (frozen pose just looks like a
standing player at their last seen spot). BUT check
`packages/client/src/main.ts` `syncRemoteProxies()` (~line 336) and the
footstep tracker wiring — footsteps for a frozen pose produce zero stride, so
they're naturally silent; verify, don't assume.

**Perf note:** build the per-recipient array without re-allocating 10 player
objects per recipient per snapshot — reuse the shared row object for visible
players and only allocate a replacement row for masked ones (or keep one
scratch masked-row per player, mutated in place).

**Tests.** Add `packages/server/test/visibility-culling.test.ts` (mirror
existing server test setup — they drive `ServerHost.step()` directly with
loopback transports): (a) enemy behind a wall arrives with frozen position;
(b) enemy in open line-of-sight arrives with true position; (c) teammate
always true; (d) after breaking LOS, true position persists ≤ grace window
then freezes; (e) dead enemy true position. Use `LEVEL_BOXES` walls or spawn
positions with a known occluder.

**Accept when:** tests above pass; existing server tests still pass; playing
2-client locally shows enemies through walls standing frozen at last-seen
spots (verify with `?server=` two tabs); hitreg agreement % in the debug HUD
doesn't regress (lag comp uses server state, not snapshots — it must not
change).

---

## Task 2 — Merge static level geometry + instanced props

**Priority: high. Client-only. Medium size, low risk.**

**Context.** `buildGrayboxMeshes()` in `packages/client/src/render.ts` (~line
97) creates one `THREE.Mesh` + one `BoxGeometry` per collision box (~50+
boxes), and `buildLevelDressing()` in `packages/client/src/graybox.ts` adds
more. Each mesh = a draw call. Combined with per-part player models, the scene
runs hundreds of tiny draw calls. Target: single-digit draw calls for all
static level geometry.

**Change.**
- In `buildGrayboxMeshes`, group boxes by their resolved material (see
  `materialForSurface`, `render.ts` ~line 110 — materials come from
  `MaterialSet`, keyed by surface kind × zone). For each group, build the
  translated `BoxGeometry`s (apply `geometry.translate(cx, cy, cz)` instead of
  setting mesh position) and merge with `mergeGeometries` from
  `three/examples/jsm/utils/BufferGeometryUtils.js`. One `THREE.Mesh` per
  material group.
- Keep the no-materials fallback path (used by tests / materials-less boot)
  working — per-box color means per-box material there; either leave that
  path unmerged (fine — it's a fallback) or merge by color.
- In `buildLevelDressing` (`graybox.ts`), find repeated props (crates,
  barrels, etc.). For each repeated geometry+material pair with ≥3 instances,
  use `THREE.InstancedMesh` with per-instance matrices instead of individual
  meshes. Leave one-offs as-is.
- UVs: the zone-tinted materials use textures; merged geometry keeps each
  box's own UVs, which is fine. Do NOT attempt lightmap UV2 generation in
  this task (that belongs to the future map/bake pass) — but leave a short
  comment noting merged-static-geometry is where UV2 will attach.

**Constraint.** Only *static, never-moving, never-disposed* geometry may be
merged. Anything with per-frame position/scale updates (ability entities,
player models, spike, drops) is out of scope — don't touch those systems.

**Accept when:** debug HUD (Task 0) draw calls drop substantially (record
before/after in the PR; expect level geometry to go from ~dozens to ≤ ~6);
the level looks pixel-identical from spawn (screenshot compare by eye);
typecheck/tests green.

---

## Task 3 — Sim allocation diet: tick-into-scratch + prediction history pool

**Priority: high. Touches `sim` + client. Largest task here; do it carefully.
Prerequisite for none, but land AFTER Task 0 so gains are measurable.**

**Context.** `tick()` in `packages/sim/src/tick.ts` (~line 47) begins with
`cloneState(state)` — `cloneState` (`packages/sim/src/state.ts` ~line 477)
`.slice()`s ~90 typed arrays. Cost centers:

- Client forward prediction: 64 ticks/s → 64 clones/s
  (`PredictedClient.queueAndPredict`, `packages/client/src/prediction.ts`
  ~line 208).
- Client reconciliation: every 32 Hz snapshot, `reconcile()` (~line 258)
  clones a base then **re-ticks every buffered input** (loop ~line 437) —
  at 100 ms RTT that's ~6-8 more clones per snapshot → ~200+ clones/s extra.
- `stateHistory` retains up to `HISTORY_RETENTION = 512` full states
  (~line 24) ≈ 8 s of history; realistic need is < 2 s.
- Server: 64 clones/s in its own `step()`.

Result: thousands of typed-array allocations/sec → GC pauses → frame-time
spikes. The fix keeps `tick()` pure *observationally* (never mutates its
input) while eliminating steady-state allocation.

**Change, in three independent commits:**

**(a) `tickInto` — clone-into-scratch.**
- In `state.ts`, add `copyStateInto(src: SimState, dst: SimState): void`
  that copies every field of `src` into `dst`'s existing arrays via
  `dst.posX.set(src.posX)` etc. — mirror `cloneState` field-for-field (ALL
  ~90 fields; missing one causes silent nondeterminism — cross-check against
  `serializeState`'s field list, same file ~line 585, which is the canonical
  complete enumeration). Scalars (`tick`, `prngState`, `mode`, spike fields,
  …) assigned directly; `config` assigned by reference (it's readonly).
  Precondition-check `dst.numPlayers === src.numPlayers`, throw otherwise.
- In `tick.ts`, add
  `tickInto(state, inputs, boxes, scratch: SimState): TickResult` where the
  body is today's `tick()` with `const next = cloneState(state)` replaced by
  `copyStateInto(state, scratch); const next = scratch;`. Reimplement
  `tick()` as `tickInto(state, inputs, boxes, cloneState(state))`… careful:
  that double-copies. Cleaner: extract the post-clone body into an internal
  `tickCore(state, next, inputs, boxes)`; `tick` = `tickCore(state,
  cloneState(state), …)`, `tickInto` = `copyStateInto(state, scratch);
  tickCore(state, scratch, …)`.
- Export `tickInto` and `copyStateInto` from `packages/sim/src/index.ts`.
- **Determinism test (mandatory):** in `packages/sim/test/`, add a test that
  runs 1000 ticks of mixed random-ish input (seeded, deterministic) through
  `tick()` and through `tickInto()` with two ping-pong scratch states, and
  asserts `serializeState` equality at every 100th tick.

**(b) Use it in `PredictedClient` with a pooled history ring.**
- In `prediction.ts`: replace `stateHistory: Map<number, SimState>` +
  per-tick `cloneState` retention with a preallocated pool of
  `HISTORY_RETENTION` states created lazily (`createState`/`createMatchState`
  shape must match — allocate via `cloneState(this.state)` on first use).
  Reduce `HISTORY_RETENTION` 512 → 192 (3 s @ 64 Hz — still generous over
  any playable RTT + jitter buffer; keep the constant + doc comment).
- Ring indexing: `seq % HISTORY_RETENTION` → slot; store `seq` alongside to
  detect stale slots on lookup (`reconcile` looks up
  `snapshot.lastProcessedSeq` — if the stored seq doesn't match, fall back to
  current behavior `?? this.state`, which the code already handles, ~line 264-265).
- `queueAndPredict` (~line 208): step via `tickInto` into the ring slot for
  this seq, then set `this.state` to that slot. **Watch the aliasing:**
  today `this.state` and `stateHistory.get(seq)` alias the same object and
  nothing mutates states after creation, so aliasing a pool slot is equally
  safe — but `reconcile`'s replay loop also writes slots (~line 448); it must
  write into the ring the same way (via `tickInto` into the slot for each
  replayed seq). The `base` in `reconcile` still needs ONE real `cloneState`
  (it's mutated field-by-field before replay) — keep that, or use a single
  reusable `reconcileScratch` state on the class (`copyStateInto` into it).
- The existing test `packages/client/test/prediction-under-fire.test.ts` is
  the safety net for this file — it must pass unmodified. Also run the whole
  client suite; interpolation/hitreg tests exercise adjacent code.

**(c) Server `step()`:** in `serverHost.ts`, replace its per-tick `tick(...)`
call with `tickInto` using two ping-pong scratch states owned by the host
(the host's `StateRingBuffer` for lag comp — see `ringbuffer.ts` — stores
its own copies; check whether it clones on push (it must, now that states
get reused) — if it stores by reference today, give it a pooled
`copyStateInto` too).

**Accept when:** determinism test (a) passes; full `pnpm test` green with NO
test modified except new ones; Task 0's heap-growth line during active online
play drops by an order of magnitude vs. the recorded pre-task baseline
(record both numbers in the PR); hitreg agreement % unchanged.

---

## Task 4 — Memoize `RemoteInterpolator.sample()` and pose churn

**Priority: medium. Client-only. Small.**

**Context.** `RemoteInterpolator.sample()` in
`packages/client/src/interpolation.ts` (~line 136) allocates a fresh array of
fresh `RemotePose` objects (via `lerpPose`, ~line 69) on every call. It's
called several times per frame: `net.ts` `getRemotePoses()` is hit from
`syncRemoteProxies()`, `updateHud()`'s minimap block, kill-event handlers, and
once per fixed tick inside `sendInput`'s cosmetic-hit block. ~10 poses × ~4+
calls × 60 fps = thousands of short-lived objects/sec.

**Change.**
- Memoize by time: cache `lastSampleResult` keyed on
  `getCurrentTargetTick()`'s value (a float; changes every frame but NOT
  between same-frame calls). If the target tick equals the cached key,
  return the cached array. This alone collapses N-calls-per-frame to 1
  allocation set per frame.
- Then remove the per-frame allocation too: keep a persistent
  `scratchPoses: RemotePose[]` (poses as mutable objects, reused), and make
  `lerpPose` write into the scratch entry instead of returning a literal.
  The public return type stays `readonly RemotePose[]`; document that the
  array contents are valid until the next `sample()` call. **Check every
  consumer for retention across frames** before doing this: known consumers
  are `syncRemoteProxies` (reads immediately), minimap block in `updateHud`
  (reads immediately), `buildCosmeticState` in `net.ts` (~line 232, copies
  immediately), kill-event death-marker lookup in `main.ts` (~line 268, reads
  immediately), spectate camera block (reads immediately). `remoteLastWeapon`
  in `main.ts` stores *copied primitives*, fine. If you find a consumer that
  retains the pose object, copy at that consumer.
- `interpolation.test.ts` exists — it must pass; if it asserts fresh-object
  identity semantics, adjust the test only with a comment explaining the new
  contract.

**Accept when:** tests green; heap-growth line (Task 0) drops further; remote
players still glide (no visual stepping) with 2 tabs + `?fakelag=80`.

---

## Task 5 — HUD: write-on-change only, kill per-frame garbage

**Priority: medium. Client-only. Mechanical.**

**Context.** Several HUD paths do per-frame work that only needs to happen on
change (`packages/client/src/main.ts` `updateHud()` ~line 485, and widget
implementations in `packages/client/src/render.ts`):

1. `combatHud.update(...)` writes `el.textContent` every frame
   (`render.ts` ~line 592) — layout invalidation 60×/s for values that change
   a few times/s. Same for `matchHud.update` top bar (~line 707).
2. `purchasedItemIds(state, localIndex)` allocates a `Set` every frame
   (`main.ts` ~line 630) feeding `buyMenu.setMatchState`.
3. Agent-select block allocates `Array.from(state.agentId)` +
   `Array.from(state.team)` every frame while in waiting phase
   (`main.ts` ~line 528-530).
4. `teamPings.map(...)` allocates per frame for the minimap (~line 612), and
   minimap `update` redraws canvas every frame even when nothing moved
   (leave the redraw — it's cheap canvas — just fix the `.map` by passing
   `teamPings` + `nowMs` and computing age inside, or reusing an array).
5. Ability HUD: `ABILITIES.filter().sort()` + `AGENT_INFO.find()` every frame
   (`render.ts` ~line 1080-1081). Precompute once at module scope:
   `abilitiesByAgent: Map<number, AbilityDef[]>` (already sorted).
6. Ability entity renderer: `ABILITIES.find(...)` per smoke/slow-zone per
   frame (`render.ts` ~line 1245, 1257). Precompute `abilityById` lookup
   (array indexed by id or Map) at module scope.

**Change pattern for (1):** inside each widget, keep the last-written values;
compare-and-skip identical writes (compose the string only after the cheap
numeric comparisons pass — the template literal itself is the allocation).
For (2)/(3): compute only when inputs can have changed — e.g. gate (3) on a
`picksChanged` check against small copied arrays, or simply run those blocks
at 10 Hz via a timestamp gate (agent select and buy menu are menus; 10 Hz is
imperceptible there). Do NOT throttle crosshair/hitmarker/flash overlays.

**Accept when:** tests green; recording a Performance profile during play
shows `updateHud` no longer allocating every frame; all HUD elements still
update visibly correctly (ammo count while firing, credits after buy, agent
picks while selecting, spike/plant bars).

---

## Task 6 — Pool tracers inside vfx.ts

**Priority: low-medium. Client-only. Small.**

**Context.** `spawnTracer()` (`packages/client/src/render.ts` ~line 218)
allocates a `BufferGeometry` + `LineBasicMaterial` + `Line` per shot and runs
a private `requestAnimationFrame` fade loop per tracer, disposing at the end.
A rifle at ~10 shots/s across 10 players = constant churn + up to dozens of
concurrent stray rAF loops. The repo already has the right pattern:
`packages/client/src/vfx.ts` has pre-allocated pools
(`createMuzzleFlashPool`, `createImpactSparksPool`, …) with a stated
no-per-frame-allocation budget and a single `update(now)` driven from the
main frame loop — mirror it exactly.

**Change.** Add `createTracerPool(scene, capacity = 32)` to `vfx.ts`:
capacity `Line` objects created up-front sharing ONE geometry each
(2-vertex position attribute, updated via
`setFromPoints`-free direct `attribute.array` writes + `needsUpdate`) and ONE
shared material *per tracer* (opacity animates per-tracer, so material can't
be shared across all — allocate `capacity` materials up-front, reuse
forever). `spawn(from, to, lifetimeMs)` claims the oldest-free (or steals the
oldest-live) slot; `update(nowMs)` fades and hides expired ones. Wire
`tracerPool.update(now)` into `frame()` in `main.ts` next to the other pools,
replace both `spawnTracer` call sites (`fireLocalTracersAndHitmarkers`
~line 434 and the remote-shot heuristic in `syncRemoteProxies` ~line 376),
then delete `spawnTracer` from `render.ts`.

**Accept when:** tests green; firing shows tracers identical to before
(100 ms fade local, remote too); no `spawnTracer` remains; sustained fire
adds zero heap growth (Task 0 line).

---

## Task 7 — Render-scale setting (fill-rate knob)

**Priority: medium (biggest *user-facing* perf lever on 4K/retina). Small.**

**Context.** `createScene()` (`packages/client/src/render.ts` ~line 49) does
`renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))` with
`antialias: true` — on a retina laptop that's 4× the pixels of 1× rendering.
There is an existing settings overlay:
`packages/client/src/settingsOverlay.ts` + persisted settings in
`packages/client/src/audio/settings.ts` (volume-focused today), wired in
`main.ts` ~line 93-105.

**Change.**
- Extend the persisted settings shape with `renderScale: number` (allowed
  values 0.5 / 0.75 / 1.0 / native-capped-2; default 1.0). Follow the exact
  load/save/versioning pattern the volume settings use (localStorage,
  defaults on missing/corrupt).
- Add a "Render scale" row to the settings overlay (match its existing row
  style — sliders/selects, whatever it uses).
- Apply: `renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale)`
  and re-call `renderer.setSize(window.innerWidth, window.innerHeight)`
  on change. The resize listener (`render.ts` ~line 73) must keep applying
  the current scale — thread the current value in rather than duplicating
  state (e.g. `createScene` exposes `setRenderScale(s)` on `SceneHandle`).
- HUD/DOM overlays are unaffected (they're DOM, not canvas). The in-canvas
  crosshair… is DOM (`Hitmarker`), so nothing to do.

**Accept when:** changing the setting visibly changes sharpness immediately
and persists across reload; fps rises at 0.5 on a retina display; window
resize preserves the chosen scale; tests green.

---

## Task 8 — Cache the per-tick boxes array in `tick()`

**Priority: low. Sim. Tiny — good warm-up task.**

**Context.** `tick.ts` ~line 60:
`const boxesWithWalls = wallBoxes.length > 0 ? [...boxes, ...wallBoxes] : boxes;`
re-spreads the full level box array (~50 entries) every tick while any Lumen
wall is alive, on server and on every predicting client.

**Change.** Keep it pure — no module-level cache (that's ambient state).
Instead make `liveWallBoxes` (`packages/sim/src/abilities/entities.ts`)
cheap-checkable: add `hasLiveWallBoxes(state): boolean` (scan `entType` for
`ENT_WALL_BOX`, no allocation) and only build `wallBoxes` + the merged array
when true. That eliminates the allocation in the *common* case (no walls),
which is ~95% of ticks. Leave the spread in the has-walls case; it's rare and
bounded. (A caller-provided scratch array would save the rest but complicates
the `tick` signature — explicitly not worth it.)

Also check: does `liveWallBoxes` itself allocate an array every tick even when
empty? If it returns `[]` fresh each time, return a shared frozen
`EMPTY_BOXES` constant instead.

**Accept when:** sim tests green (`pnpm --filter @vg/sim test`); no behavior
change (this is allocation-only).

---

## Task 9 — Dead-code cleanup in net.ts onClose

**Priority: trivial. Bundle with any other client task's PR.**

`packages/client/src/net.ts` ~line 539: inside `t.onClose`, the branch
`if (!settled) { if (settled) return; ... }` contains an inner `if (settled)
return;` that is unreachable. Delete the inner check only; behavior identical.

---

## Task 10 — Real RTT measurement (protocol change)

**Priority: medium-low. Touches protocol + server + client. Do NOT bundle.**

**Context.** The debug HUD's `rtt` is fake: `net.ts` ~line 330 sets
`rttEstimateMs = now - lastSendAt` when any snapshot arrives — that measures
snapshot cadence + queueing, not round trip. Real RTT matters for tuning the
jitter buffer, lag comp windows, and `INTERP_DELAY_TICKS`.

**Change (echo pattern, no clock sync needed).**
- `messages.ts`: add `clientTimeMs: number // f64` to `InputBatchMessage`,
  and `echoClientTimeMs: number // f64` + `echoDelayMs: number // u16
  (server hold time between receiving that input and sending this snapshot)`
  to `SnapshotMessage`. Bump `PROTOCOL_VERSION` 4 → 5. Update
  `encodeMessage`/`decodeMessage` for both (fixed-size fields; follow the
  existing DataView little-endian style exactly) and any message-size
  constants/tests. `packages/protocol/test/` has round-trip tests — extend
  them for the new fields.
- Server (`serverHost.ts`): on `InputBatch`, store per-client
  `{ lastClientTimeMs, receivedAtMs: nowMs() }`. In `broadcastSnapshot`, set
  `echoClientTimeMs = lastClientTimeMs` and
  `echoDelayMs = clamp(nowMs() - receivedAtMs, 0, 65535)`.
- Client (`net.ts`): stamp `clientTimeMs: performance.now()` in `sendInput`'s
  `encodeMessage` call; in `onSnapshot`, if `echoClientTimeMs > 0`, compute
  `rtt = performance.now() - echoClientTimeMs - echoDelayMs`, smooth with
  EMA (`rtt = 0.9 * prev + 0.1 * new`), replace the old estimate. Delete
  `lastSendAt` bookkeeping.
- `withLatency` fake-lag wrapper delays both directions, so `?fakelag=50`
  must produce `rtt ≈ 100ms ± jitter` — that's the acceptance test.

**Accept when:** protocol round-trip tests updated + green; with
`?fakelag=50` the HUD reads ~100 ms (was: whatever cadence noise before);
with no fake lag on localhost it reads low single-digit ms.

---

## Deferred (do NOT do yet — recorded so nobody "helpfully" starts them)

- **Spatial grid / BVH for boxes** (movement + raycast are linear scans over
  ~50 boxes — fine at this size). Revisit when the dressed map or map 2
  raises box counts; must be deterministic (static build order) and measured
  before/after.
- **Worker net pump + WebTransport** — planned in PLAN.md (M-items), large,
  and interacts with input redundancy; separate design pass.
- **Lightmap/UV2 bake** — part of the art pass, not this plan (Task 2 leaves
  the attachment point).
- **Snapshot delta compression** — bandwidth is fine at 10 players/32 Hz;
  revisit only if WebTransport datagram MTU forces it.

## Suggested execution order

0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → (8, 9 anytime) → 10.
Task 0 first (measurement), Task 1 next (integrity, hardest to retrofit),
then the allocation/draw-call series in descending impact.
