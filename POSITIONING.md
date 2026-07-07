# super-line — positioning brief

Outcome of a grilling session (2026-06-20). Replaces the "typesafe WebSocket library" framing across **README**, **docs home** (`docs/index.md`), and **introduction** (`docs/guide/introduction.md`). Write the positioning **once**, express it at **three depths**.

## Identity (what it is — the honest scope line)

> An opinionated, strictly-typed realtime library: **transport, event-emitter, pub/sub, req/res** over one connection.

This is the reassurance line, **not** the headline. It tells an engineer the exact shape of the thing.

## Strategy

- **Voice:** pain-promise. The headline names the spec (engineer register), the pain lands immediately below.
- **Spine (the villain):** the **assembly tax** — today you bolt together `ws` (transport) + an `EventEmitter`/Socket.IO (events) + hand-wired Redis pub/sub (fan-out) + custom ack code (req/res), none of it typed across the wire, re-glued every project. super-line is that whole assembly as one library.
- **Proof A (credibility):** strict typing end to end + runtime validation. The contract is the source of truth.
- **Proof B (the big story):** scaling/the **cluster event bus** — the same code runs from one node to a cluster; the bus does cross-node fan-out. This is where the new feature gets its spotlight — as the *scaling payoff*, not the identity.
- **Character (what "opinionated" cashes out as):** **server-authoritative — trust nothing on the wire; the contract and the server are in charge.** The three foregrounded opinions:
  1. One contract object both sides import — types can't drift or get misordered.
  2. Every inbound message is validated at runtime, always.
  3. The server owns rooms and authorizes topics; clients can't self-join anything.
- **Not doctrine:** "every client→server is req/res" is a **roadmap gap** (Status → "not yet"), never marketed as a principle.

## Hero (final copy — shipped)

> # The strictly typed, opinionated data bus for TypeScript.
> One contract for every pattern on the wire — requests, events, and subscriptions — with end-to-end types and zero codegen. The same API on a single server or a cluster of nodes.

**Identity shift (user steer, 2026-06-20):** the headline is now **"the strictly typed, opinionated data bus for TypeScript"** — supersedes the earlier "one library / four primitives (transport, events, pub/sub, req/res)" framing. The body still uses the assembly-tax spine; just frame patterns as **requests · events · subscriptions** (3 patterns) consistently, not "four primitives."

Hero code sample = **assembly-collapse**: one small contract that declares a **request + an event + a topic**, then ~2 lines of server and ~2 of client, types visibly flowing both ways. Reuse the *already-verified* quickstart contract (`send` request + `message` event + `presence` topic) trimmed down — do **not** invent new API; confirm calls against `packages/server` before shipping. The reader must *see* "three of the four primitives from one contract, typed."

## Evidence mode (every proof section)

**Recognizable situation → one-line fix → real example.** No protagonist, no narrative fluff; the pain is *felt*, the fix is *one line*, the proof is a real example in the repo.

## Body arc (replaces the 6-card grid — delete it)

1. **Hero** — C2 headline + assembly-collapse snippet.
2. **The assembly tax, shown** — the stack you hand-glue today vs. one contract.
3. **Proof — the contract is the law** *(opinions 1+2)*: rename a payload → an untyped client ships it and crashes at runtime; with super-line the client won't compile, and the server validates every inbound message so even an untyped peer can't sneak past.
4. **Proof — it works on one node, then you add a second** *(the bus)*: node-A/node-B miss → pass an adapter, the *same* `publish` now hits in-process subscribers (local echo, no network hop) **and** every other node across the backbone; `meta.from` tells you the origin. Real: `examples/bus-cluster`.
5. **Control Center** *(observability)*: `inspector: true` + `npx @super-line/control-center` — live topology, connections + `ctx`, the running contract, a live event feed, cluster-wide. On the home it's a stylized topology mock (cyan dashed bus spine + node cards + `Adapter · bus` pill); swap for a clean screenshot later.
6. **Character — server-authoritative** *(opinion 3 + roles)*: server owns rooms, authorizes topics, roles fixed at the upgrade (cross-role → `NOT_FOUND`).
7. **Reassurance** — pattern recap (requests · events · subscriptions), the comparison table, install, honest Status.

The 13-feature soup is gone: each feature becomes *evidence inside a section*, or it drops.

## Adapters — stay neutral (user steer, 2026-06-20)

Do **not** center Redis. The adapter is a pluggable interface: **the in-memory default plus Redis, libp2p, RabbitMQ, and ZeroMQ all ship and publish today** (`@super-line/adapter-{redis,libp2p,rabbitmq,zeromq}`). Frame the cross-node story as "pass an adapter / a pub/sub backbone," name Redis as *an* option, and say "libp2p, RabbitMQ, ZeroMQ, or your own drops in."

## Comparison lanes

Keep Socket.IO / tRPC / raw `ws`, **add the distributed-emitter lane** (`demitter`/`emittery`-style). Purpose: win it and walk away — "yes, it's a typed distributed emitter, *and also* req/res, rooms, presence, and a server that's in charge." Axes to show super-line's breadth: typed contract (one SSOT) · runtime validation · req/res (both directions) · events + rooms · topics (pub/sub) · cross-node fan-out · per-role contracts · presence/introspection · server-authoritative. The distributed-emitter column is strong only on pub/sub + cross-node and empty elsewhere — that's the point.

## Per-surface depth (one positioning, three depths)

- **docs home (`index.md`)** — teaser + CTA. Drop the VitePress `features:` array (it *is* the 6-card grid); the arc becomes custom sections. Hook fast, proof teasers, "Get started."
- **README** — the full self-contained pitch in one scroll: hook → condensed proofs → install → quickstart → comparison → honest Status.
- **introduction (`Why super-line`)** — the deep argument: the assembly tax in depth, the three opinions, the comparison reasoning. No install/quickstart.

Same hero copy and section titles across all three; only depth changes.

## Successor pillars (added 2026-06-29)

Two subsystems landed after this brief and now share the spotlight. Fold each into the proof arc in the same evidence-mode voice (recognizable pain → one-line fix → real example); neither replaces the hero.

- **Pluggable client↔server transports.** WebSocket is the *default*, never the identity — do not write "WebSocket library." The server takes `transports: [...]`, the client a `transport:`; `authenticate` receives a normalized `Handshake`. WS ships as `@super-line/transport-websocket`; HTTP-SSE/long-poll, libp2p (bring-your-own node), and an in-memory loopback (for tests) ship alongside. Same contract, swap the wire. Real: `examples/transports`, `examples/react-chat-transports`.
- **Stores — persisted + synced state (the fourth pattern).** Beyond requests · events · subscriptions, super-line now persists server-authoritative state addressed by `name.id`: opened as a reactive `ResourceHandle` client-side (`set`/`update`/`delete` + a `deleted` signal) and a `ServerReplica` server-side (`srv.store(ns).open(id)`). Two consistency models (LWW · CRDT) × two clustering modes — **`relay`** (node-local replicas; changes fan out over the Adapter) vs **`self`** (a central backend + per-node replica; no Adapter). Five backends ship: in-memory (`store-memory` / `store-sync`), durable (`store-sqlite`), and self-clustering (`store-pglite`, `store-sync-pglite` over Postgres + Electric). Deletes fan out cluster-wide (`srv.store(ns).delete(id)` → the `deleted` signal). The durable-`relay` CRDT store (`store-sync-libsql`) has folded into a CRDT document collection (ADR-0007). Real: `examples/store`, `examples/advanced-chat-app`, `examples/ai-canvas-pglite`.

This makes the on-the-wire pattern list **four** — requests · events · subscriptions · **synced state** — but the spotlight stays on the assembly-tax spine and the cluster bus; stores and transports are proof sections, not the headline.

## Side flag (not messaging — quick win)

The live docs hero renders in VitePress's default **indigo**, while the mark is **cyan** (`#22d3ee` / `#0891b2`). The wordmark clashes with the logo. One-line theme override to apply the cyan brand color — separate from this brief, but worth doing alongside.
