# super-line

Strictly-typed realtime data bus for TypeScript — one contract for every pattern on the wire (requests · events · subscriptions), end-to-end types, no codegen. Same API on one node or a cluster. pnpm monorepo.

## Commands (run from repo ROOT)

```bash
pnpm test         # vitest run — the REAL suite (~245 tests). `pnpm -r test` runs NOTHING.
pnpm typecheck    # root tsc — the REAL check. `pnpm -r typecheck` only covers 2 of 18 projects.
pnpm lint         # oxlint (NOT eslint)
pnpm build        # pnpm -r build (tsup)
pnpm docs:dev     # VitePress dev server
pnpm docs:build
```

## Layout

`packages/{core,server,client,react,control-center}` · `packages/transport-{websocket,http,libp2p,loopback}` (pluggable client↔server transports) · `packages/adapter-{redis,libp2p,rabbitmq,zeromq}` (server↔server fan-out) · `examples/` · `docs/` (VitePress) · `skills/super-line/` (published agent guide for *users* of super-line, not dev-context for this repo).

- `defineContract` lives in `@super-line/core`; `createSuperLineServer` in `/server`, `createSuperLineClient` in `/client`, `createSuperLineHooks` in `/react`. The wire error type is `SuperLineError`.
- **Client↔server transport is pluggable.** Server takes `transports: [...]`, client takes `transport:`; `authenticate` receives a normalized `Handshake`. `webSocketServerTransport`/`webSocketClientTransport` (default) live in `@super-line/transport-websocket`; HTTP-SSE/long-poll in `/transport-http`; libp2p in `/transport-libp2p` (bring-your-own node); in-memory `/transport-loopback` for tests. Transport interfaces (`RawConn`/`ServerTransport`/`ClientTransport`/`Handshake`) are in `@super-line/core`. Design + migration notes: `PLAN-transports.md` + `TRANSPORT-MIGRATION-NOTES.md` at repo root.
- `docs/reference/` is typedoc-GENERATED — never hand-edit; it regenerates from source on `docs:build`.

## Gotchas

- **Tests and typecheck only work from root**, not via `pnpm -r` (no package has a `test` script; only 2 have `typecheck`). `pnpm -r test` silently passes while running nothing.
- `packages/server/test/reconnect.integration.test.ts` → "auto-reconnects after an abrupt drop" is timing-flaky under full parallel load; it passes in isolation. Don't chase it as a regression.
- ESM-only packages. Lint/format is oxlint/oxfmt, not ESLint/Prettier.

## Architecture

One contract is the single source of truth (`defineContract`), imported by both server and client, split by direction (`clientToServer`/`serverToClient`) and scoped by role (a `shared` base + per-role blocks). **Server-authoritative**: the server owns rooms/topics, authorizes subscribes, and validates every inbound message; roles are fixed at connect by `authenticate(handshake)` (cross-role calls → `NOT_FOUND`). Three wire patterns: requests (req/res), events (server push), topics (client subscribe). The **client↔server wire is a pluggable transport** (WS/HTTP/libp2p/loopback — see Layout). Separately, **server↔server cross-node fan-out** goes through a pluggable `Adapter` (in-memory default; Redis/libp2p/rabbitmq/zeromq adapters ship) plus a server-side cluster bus (`server.publish`/`server.subscribe` with local echo). Don't confuse the two: transports carry client↔server bytes; adapters carry node↔node fan-out.
