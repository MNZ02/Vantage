# Vantage

An original browser tactical FPS prototype — Valorant-like in genre — built with Three.js, a deterministic shared TypeScript simulation, and an authoritative WebSocket server. It includes client prediction/reconciliation, lag compensation, round and economy systems, bots, agents and abilities, audio, and generated 3D assets.

This is an independent learning project. It is not affiliated with or endorsed by Riot Games, and it should not ship Riot-owned names, art, audio, maps, or other assets.

## Requirements

- Node.js 24
- pnpm 11.1.3 (declared in `packageManager`)

## Run locally

```sh
pnpm install
pnpm dev:server
```

In a second terminal:

```sh
pnpm dev
```

Open the URL printed by Vite. For a local match with bots, use `pnpm dev:solo` for the server instead.

Server configuration is supplied through environment variables:

- `PORT` (default `8787`)
- `MODE=match|dm` (default `match`)
- `NUM_PLAYERS` (default `10`, maximum `16`)
- `MIN_PLAYERS` (default `2`)
- `BOTS` or `SOLO=1`
- `ALLOWED_ORIGINS`, a comma-separated allowlist for deployments
- `LAGCOMP=off` to disable lag compensation for diagnostics

When the page is served over HTTPS, the client automatically uses `wss://`. In production, terminate TLS at a reverse proxy and set `ALLOWED_ORIGINS`.

## Quality checks

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

`pnpm check` runs the non-browser static, unit, soak, and build gates. The Playwright smoke test starts the real server and Vite client, checks browser boot/runtime asset responses, and exercises the settings dialog.

## Architecture

The workspace is layered in one direction:

- `@vg/sim`: deterministic rules and fixed-tick state
- `@vg/protocol`: binary messages and transport adapters
- `@vg/server`: authoritative host, reconnects, visibility filtering, bots
- `@vg/client`: prediction, interpolation, rendering, HUD, audio

See [AGENTS.md](AGENTS.md) for development conventions and [assets/README.md](assets/README.md) for the generated asset pipeline.

## Asset storage

Blender sources and exported GLBs are large. Keep canonical sources in `assets/`, commit compressed runtime variants intentionally, and use Git LFS or external artifact storage before the asset set grows further. Avoid committing transient preview renders and backup `.blend1` files.
