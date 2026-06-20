# super-line

Strictly-typed realtime data bus for TypeScript — one contract for every pattern on the wire (requests · events · subscriptions), end-to-end types, no codegen. Same API on one node or a cluster. pnpm monorepo.

## Commands (run from repo ROOT)

```bash
pnpm test         # vitest run — the REAL suite (138 tests). `pnpm -r test` runs NOTHING.
pnpm typecheck    # root tsc — the REAL check. `pnpm -r typecheck` only covers 2 of 18 projects.
pnpm lint         # oxlint (NOT eslint)
pnpm build        # pnpm -r build (tsup)
pnpm docs:dev     # VitePress dev server
pnpm docs:build
```

## Layout

`packages/{core,server,client,react,adapter-redis,adapter-libp2p,control-center}` · `examples/` · `docs/` (VitePress) · `skills/super-line/` (published agent guide for *users* of super-line, not dev-context for this repo).

- `defineContract` lives in `@super-line/core`; `createSuperLineServer` in `/server`, `createSuperLineClient` in `/client`, `createSuperLineHooks` in `/react`. The wire error type is `SuperLineError`.
- `docs/reference/` is typedoc-GENERATED — never hand-edit; it regenerates from source on `docs:build`.

## Gotchas

- **Tests and typecheck only work from root**, not via `pnpm -r` (no package has a `test` script; only 2 have `typecheck`). `pnpm -r test` silently passes while running nothing.
- `packages/server/test/reconnect.integration.test.ts` → "auto-reconnects after an abrupt drop" is timing-flaky under full parallel load; it passes in isolation. Don't chase it as a regression.
- ESM-only packages. Lint/format is oxlint/oxfmt, not ESLint/Prettier.

## Architecture

One contract is the single source of truth (`defineContract`), imported by both server and client, split by direction (`clientToServer`/`serverToClient`) and scoped by role (a `shared` base + per-role blocks). **Server-authoritative**: the server owns rooms/topics, authorizes subscribes, and validates every inbound message; roles are fixed at the WS upgrade (cross-role calls → `NOT_FOUND`). Three wire patterns: requests (req/res), events (server push), topics (client subscribe). Cross-node fan-out goes through a pluggable `Adapter` (in-memory default; Redis + libp2p adapters ship) plus a server-side cluster bus (`server.publish`/`server.subscribe` with local echo).
