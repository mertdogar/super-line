---
title: cloudflare-workers
labels: [wayfinder:map]
created: 2026-10-14
---

# cloudflare-workers — a super-line node inside a Durable Object

## Destination

Cloudflare Workers support **built, tested, documented and release-staged**: one Durable Object instance *is* one super-line node (single-node; no cluster adapter), reached through a new `@super-line/transport-cloudflare` WebSocket transport that is **hibernation-aware** (sockets survive DO eviction and the server resumes topics / collection subscriptions / open docs transparently via a new per-connection snapshot/restore seam in core); `plugin-auth` / `plugin-inspector` / `plugin-chat` / `plugin-queue` run there (off `node:crypto` where `nodejs_compat` does not cover it); durable rows and CRDT docs on Durable Object SQLite via `@super-line/collections-cloudflare` + `@super-line/collections-crdt-cloudflare` (typed tables ported from `collections-sqlite`); a third test lane `pnpm test:workers` on `@cloudflare/vitest-pool-workers`; `examples/cloudflare` that deploys with `wrangler`. Push/publish only on the user's go.

## Notes

- **Execution override**: this map carries execution (charted 2026-10-14) — build tickets do the work, not just decide it.
- Tracker: local markdown (this directory). A ticket is CLAIMED by writing your session into `assignee:`; CLOSED by `status: closed` + a `## Resolution` section appended to its body. Frontier = open tickets whose `blocked-by` ids are all closed and whose `assignee` is empty.
- On close: append the one-line gist to **Decisions so far** below; graduate any fog the answer sharpened; new tickets get the next T-number (create, then wire `blocked-by`).
- Skills per ticket type: `grilling` + `domain-modeling` for HITL tickets; `research` for research tickets; `prototype` for prototype tickets; `tdd` for build tickets; `cloudflare:durable-objects`, `cloudflare:workers-best-practices`, `cloudflare:wrangler` for anything touching the DO/Workers API. Read the docs (Context7 / Cloudflare docs) — never guess at the DO API.
- Repo norms live in CLAUDE.md — mind: tests/typecheck only from root, serial lanes, "public-surface change isn't done until skills/super-line/ is updated" (all four files), no ADR/plan citations in published material, peer-dep ranges hand-written (never `workspace:^` peers), releases per the changelog/tag rules, **no PRs — ff to local main, ASK before any commit, push or publish**.
- Facts established at charting: `core` and `server` import no `node:*` at all (server uses `globalThis.crypto.randomUUID`, a `setInterval` heartbeat, and an optional `process.env.SUPER_LINE_NODE_NAME`). Node coupling lives in `transport-websocket` (`ws` + `http.Server` upgrade), `transport-http` (`IncomingMessage`/`ServerResponse`), `plugin-auth/src/crypto.ts` + `assertions.ts` (`node:crypto` scrypt/randomBytes/timingSafeEqual), `plugin-inspector` (createHash/timingSafeEqual), `plugin-chat/src/server.ts` (randomUUID). `collections-memory` / `collections-crdt-memory` are pure JS; sqlite/pglite/libsql are native.
- Research findings land in `assets/research-*.md` in this directory (untracked scratch, so no research branch is needed).

## Decisions so far

From the charting session (2026-10-14, all recommendations accepted):

- Destination is built + release-staged code, not a plan.
- **The Durable Object is the node.** Stateless Worker hosting is out of scope.
- Full surface in scope: core + server + transport + the four plugins + durable rows AND CRDT docs on DO SQLite.
- **Hibernation-aware from the start**, with **transparent resumption** (the client never notices a wake). Forced-reconnect-on-wake is rejected except as an internal fallback.
- Per-connection snapshot/restore becomes a new seam in core/server. Where the snapshot lives (socket attachment vs DO SQLite keyed by connection id) is decided after research on the attachment size limit; expectation is DO SQLite because subscription-heavy connections overflow an attachment.
- Three packages, one per seam: `transport-cloudflare`, `collections-cloudflare`, `collections-crdt-cloudflare`.
- DO SQLite rows backend **ports typed tables** from `collections-sqlite`; extract-vs-copy of the SQL layer is decided by prototype.
- Timers become pluggable: the Cloudflare transport supplies socket-level liveness instead of the server's `setInterval` heartbeat (required for hibernation to ever happen). Queue cron on DO alarms is fog; meanwhile a node running queues is documented as non-hibernating.
- Test lane: `pnpm test:workers` on `@cloudflare/vitest-pool-workers`, plus fast-lane unit tests of the transport against a fake DO API.
- `examples/cloudflare` must actually deploy with `wrangler`.

<!-- closed tickets append below -->

- [Research: Durable Object WebSocket Hibernation API](tickets/T01-research-do-hibernation.md) — **RESOLVED**: attachment limit 16 KiB → snapshots go in DO SQLite keyed by conn id, attachment holds only the id; hibernation after 10 s idle, timers/in-flight promises/non-hibernated sockets block it (server heartbeat must go); ping + auto-response (2 KiB) answered without waking; constructor reruns before the handler on wake (`blockConcurrencyWhile` ≤ 30 s); 32 768 sockets/DO, 32 MiB message, 1 alarm/DO at-least-once. Undocumented → verify in the workers lane: eviction close code, message-vs-constructor interleave, alarm-wakes-hibernated-DO. [findings](assets/research-do-hibernation.md)
- [Research: nodejs_compat coverage and testing under workerd](tickets/T02-research-nodejs-compat-and-testing.md) — **RESOLVED**: `node:crypto` is fully supported under `nodejs_compat` (scrypt with N/r/p options, randomBytes, createHash, timingSafeEqual, hkdfSync, Buffer) → the crypto-port ticket is verification-only; `ws` cannot be the DO transport (no `node:http` upgrade) → separate implementation; `setInterval` works but blocks hibernation. ⚠ `@cloudflare/vitest-pool-workers` is DEPRECATED → `@cloudflare/vitest-plugin` needs vitest ≥ 4.1, repo is on 2.1.9 → new decision ticket [Decide: upgrade vitest repo-wide or pin the deprecated workers pool](tickets/T14-vitest-upgrade-vs-pinned-pool.md). Hibernation IS forceable in tests (`evictDurableObject`; DO WS tests need `--max-workers=1 --no-isolate`). [findings](assets/research-nodejs-compat-and-testing.md)
- [Research: Durable Object SQLite storage API](tickets/T03-research-do-sqlite.md) — **RESOLVED**: 10 GB/DO, 2 MB per row/value; atomic multi-statement via `transactionSync` (raw `BEGIN`/`SAVEPOINT` rejected, nested `transactionSync` undocumented → `conditionalApply`'s nested tx needs reshaping); **100 bound params + 100 columns per table** max → the port must chunk `IN (...)` lists in `rowMeta`/filter compiler and refuse >~98-field collections; no `prepare`/`close`, `journal_mode`/`synchronous` pragmas denied; a throw inside `blockConcurrencyWhile` resets the DO → drift refusal becomes a permanently failing object (fog sharpened, see T09); `new_sqlite_classes` only provisions, tables are created in code; SQLite ≈ 3.53 (undocumented) — `RETURNING`/`NULLS LAST`/partial indexes expected but verify on a real deploy. [findings](assets/research-do-sqlite.md)

## Not yet specified

- **Queue cron on DO alarms** — `plugin-queue` polls on timers; an alarm-driven schedule tick would let a queue-running node hibernate. Graduates after the rows backend lands and the timer seam exists.
- **Typed-table drift vs DO storage migrations** — `col_meta` fingerprints refuse to boot on incompatible drift; inside a DO "refuse to boot" means every request fails. Needs a story once the rows backend's shape is known.
- **Control Center against a DO node** — the inspector's reserved connection should ride the same transport, but a Worker-hosted node has no `process` to introspect and no stable public URL for the CC to dial outside a deploy. Revisit after the transport exists.
- **Client reconnect interplay** — if a wake ever has to fall back to closing sockets, which close code the client treats as "reconnect silently". Revisit after the snapshot seam prototype.
- **DO id routing** — how the Worker picks the DO instance (one named singleton per deployment vs an id from the URL/host for multi-tenant). Likely a transport option; sharpen at plan lock.

## Out of scope

- **Stateless Worker hosting** (no DO) — the server holds connection state; not viable with its design.
- **Multi-DO clustering / a Cloudflare-native `Adapter`** — single node is the destination; a fresh effort if wanted.
- **HTTP (SSE / long-poll) transport on Workers** — WebSockets are first-class on DOs; HTTP would need its own hibernation story.
- **Forced reconnect as the wake strategy** — rejected in favor of transparent resumption.
