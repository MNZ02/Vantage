# Contributing

Use pnpm and preserve the package dependency direction documented in `AGENTS.md`. Simulation changes must remain deterministic and should include focused tests. Protocol shape changes require a protocol-version bump plus encode/decode coverage.

Before opening a change, run:

```sh
pnpm check
pnpm test:e2e
```

Do not commit third-party proprietary game assets. Generated binaries should have reproducible source scripts or documented provenance in `assets/README.md`.
