# Vantage

A browser tactical FPS (Valorant-like) built on Three.js with a deterministic
shared simulation and authoritative-server netcode (client prediction +
server reconciliation).

## Stack & tooling

- **pnpm workspace** (`pnpm@11.1.3`) — always use pnpm, never npm/yarn.
- **ESM everywhere** (`"type": "module"`), **TypeScript 5.6**, strict via
  `tsconfig.base.json` which each package extends.
- **Vitest** for tests, **Vite** for the client, **tsx** for the server.

## Packages (`packages/*`) and their dependency layering

Build/knowledge flows one way: `sim` → `protocol` → `server` / `client`.

- **`@vg/sim`** — deterministic game simulation, zero runtime deps. Movement,
  damage, raycast, PRNG, match state, levels, abilities, math. The
  authoritative rules; must stay deterministic (same inputs → same state).
- **`@vg/protocol`** — wire messages, transport, latency sim, virtual clock.
  Depends on `sim`.
- **`@vg/server`** — authoritative host (`serverHost.ts`), dev WS server
  (`devServer.ts`, `tsx watch`), bots (`bots.ts` / `botsCli.ts`), jitter/ring
  buffers. Depends on `protocol` + `sim`, uses `ws`.
- **`@vg/client`** — Three.js renderer + netcode. Entry `src/main.ts`
  (Vite, `index.html`). Prediction, interpolation, hitreg, networking,
  materials/vfx/viewmodel/playerModel, audio, settings. Depends on
  `protocol` + `sim`, uses `three`.

## Commands (run from repo root)

- `pnpm dev` — client dev server (Vite). `pnpm dev:server` — game server.
- `pnpm build` — builds libs in order, then the client.
- `pnpm test` — builds libs, then runs vitest across all packages.
- `pnpm typecheck` — builds libs, then `tsc --noEmit` across all packages.
- `pnpm --filter @vg/<pkg> <script>` to target one package.

**Important:** `sim`/`protocol`/`server` are consumed from their built
`dist/`. After changing one of those, rebuild libs (`pnpm build:libs`, or the
`build`/`test`/`typecheck` root scripts which do it for you) before the client
or server will see the change.

## Conventions

- Match the surrounding module's style; keep simulation code deterministic and
  side-effect-free (no `Date.now()`/`Math.random()` in `sim` — use the PRNG
  and virtual clock).
- Keep client rendering concerns out of `sim`/`protocol`.
- Run `pnpm typecheck` and relevant tests before considering a change done.

## Assets

3D assets live in `assets/` (Blender sources in `assets/blender`, exported
`.glb` in `assets/models/`), loaded client-side via `src/assets.ts`.
