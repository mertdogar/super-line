---
id: T12
title: Docs and skills teach the Cloudflare target
labels: [wayfinder:task]
status: closed
assignee: session_01CAGnLSs3WJLSaww41tSX5T (2026-10-15)
blocked-by: [T11]
---

## Question

Published docs: a how-to for Workers/DO hosting (choose transport, hibernation semantics the user must know, which backends, limits), the backends guide updated, package READMEs for the three new packages, root README/positioning mention. All four `skills/super-line/` files. No ADR/plan citations in any of it. Full `docs:build` green.

> Graduated from fog at T09 — **schema changes on a deployed object**: a non-additive change makes that collection fail its operations (`INTERNAL`, names the collection and the fix) while the rest of the object works; additive optional fields ALTER in. Teach the host the two ways out — rename the collection (new table, old rows orphaned) or migrate `col_<name>` and its `col_meta` row in code before the store opens — plus the limits (98 fields per collection, 2 MB per row, a filter over > 98 values scans in JS). Skills already carry the short form (T09).

> From T10: skills already name `crdtCloudflareCollections`. The how-to should state: docs load on first touch after a wake; edits reach storage 250 ms later (a deploy inside that window loses them; hibernation never does); a doc over 2 MB is refused with a readable error — split big content across docs. README for `collections-crdt-cloudflare`.

> From T11: the how-to needs the deploy gotchas in T11's resolution — route only the socket path (every request wakes the object), the constructor and `onConnection` re-run on every wake, `pnpm run deploy`, strong inspector passwords (query-string log redaction is heuristic), `Unknown Event` in `wrangler tail`. Still unobserved: the platform's error text for a row over 2 MB on a real deploy (the client sees `INTERNAL` either way) — probe it if T12 deploys, otherwise document the ceiling without the text. `examples/cloudflare/README.md` exists; link it.

## Resolution

**Done.** The Cloudflare target is taught in published docs, the three package READMEs, the root README, and all four skill files. No ADR / plan / CONTEXT citation in any of it (grepped). `pnpm docs:build` green (VitePress fails on dead links; the 9 deep anchors used were checked in the built HTML).

- **New how-to** `docs/how-to/cloudflare-durable-objects.md` ("Host a node on Cloudflare Durable Objects", sidebar → Transports): wrangler config (`nodejs_compat`, `new_sqlite_classes`), `createDurableNode` + `routeToNode` with only `/ws` forwarded, the client with `keepalive`, run/deploy (`pnpm run deploy` gotcha; a deploy drops sockets → ordinary reconnect), what a wake keeps vs loses (table; `ctx`/`env` must be JSON-serializable), the socket-open `resubscribe` end, writing the factory for re-runs (seed in `blockConcurrencyWhile`, idempotent `onConnection`, the example's code), what keeps a node awake (table, incl. `ctx.hold()` and the 70–140 s eviction), presence on a hibernating node, storage (owned tables `_sl_conn`/`col_*`/`col_meta`/`_sl_crdt`, row limits, **schema change on a deployed object — rename, or migrate `col_<name>` + its `col_meta` row in the factory before creating the server**, CRDT first-touch load / 250 ms window / 2 MB), plugins (strong inspector password via `wrangler secret put`; new node id per wake is cosmetic), a hand-written DO class with `cloudflareServerTransport`, `wrangler tail` quirks (`Unknown Event`, log attaches to the triggering event), limits table.
- **Updated**: `choose-a-transport` (row + link), `concepts/transports-and-adapters` (fifth transport; "no session resume" qualified), `concepts/reconnection-delivery` (client `keepalive` section; `resubscribe` without a drop), `concepts/plugins` (`hold()` row; `setup` re-runs on each wake), `choose-a-collection-backend` + `collections/backends` (both Cloudflare backends in every table + factory sections), `auth-sessions-roles-keys` + `plugin-chat` (presence caveat), `examples/index`, `how-to/index`, root README (feature row, install, examples, packages table, status).
- **READMEs**: `transport-cloudflare`, `collections-cloudflare`, `collections-crdt-cloudflare`.
- **Skills**: RECIPES' Cloudflare recipe forwarded EVERY path to the node (T11 showed that wakes it) → now `/ws` only, client URL `/ws`, plus the seed-in-`blockConcurrencyWhile` / idempotent-`onConnection` pattern; REFERENCE prose gains re-runs, JSON-safe `ctx`/`env`, plugin-auth presence; SKILL + AGENTS gain one Cloudflare gotcha bullet each.

Checks: `pnpm docs:build` green, `pnpm lint` 0/0, `pnpm typecheck` clean, fast lane 855/855 (docs-only change; heavy and workers lanes not re-run).

**Not done**: the platform's error text for a row over 2 MB — no deploy this session (it costs an outward action; the client sees `INTERNAL` either way), so the ceiling is documented without the text.

**Found (→ new ticket [plugin-auth sessions and presence survive a wake](T16-plugin-auth-presence-on-wake.md), by reading, not yet reproduced)**: plugin-auth's `setup` closes every unfinished session for its `nodeKey` as crash recovery; on a Durable Object `setup` runs on every wake with a stable `nodeKey`, so each wake ends every live session and `userPresence` reads users offline while their sockets are adopted and live. With `lastSeenAt` never refreshed (no heartbeat), presence on this host is wrong twice over. The docs state the limitation today; T16 fixes it (or the user rules it unsupported) and updates those lines. T13 now also waits on T16.
