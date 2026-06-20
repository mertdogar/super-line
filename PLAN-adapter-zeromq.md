# PLAN — `@super-line/adapter-zeromq`

A third cross-node adapter alongside Redis (central broker) and libp2p (decentralized
gossip). ZeroMQ is a socket library, not a broker or a discovery mesh, so the adapter
owns the topology. Two configurable modes, gossip-based presence, at-most-once delivery.

## Agreed design (grill outcome)

- **Modes (configurable at creation):**
  - `mesh` — brokerless full mesh. Each node `bind`s one PUB and `connect`s a SUB to every
    *other* peer. Config `{ mode: 'mesh', bind, peers, sendHighWaterMark? }`. Static peer
    list (like libp2p `bootstrap`); leans on ZeroMQ's native lazy connect + auto-reconnect.
  - `proxy` — central XPUB/XSUB forwarder. Config `{ mode: 'proxy', frontendUrl, backendUrl }`.
    We ship the forwarder: `createZeroMqProxy({ frontendUrl, backendUrl })` + an `npx` bin.
- **BYO escape hatch:** pass `{ pub, sub }` pre-wired sockets; adapter uses them as-is and
  does NOT own their lifecycle (`close()` leaves them running). Sidesteps mode entirely.
- **Subscription model:** native per-channel SUB filtering (Redis-style, NOT libp2p flood).
  Send multipart `[channel-utf8, payload]`; `subscribe`/`unsubscribe` map to ZeroMQ subs.
- **Payload framing:** Buffer-always, no kind byte. `serializer.decode` accepts `Uint8Array`
  and Redis already delivers `Buffer`, so the string/binary distinction need not survive.
  Coerce string payloads to `Buffer` on send; deliver frame 1 as-is.
- **Local delivery:** explicit in-process loopback in `publish()` (SUB connects to *others*
  only), matching the libp2p adapter.
- **Presence:** gossip-based in both modes (no central store; proxy is a dumb forwarder).
  **Copy** `GossipPresence` from the libp2p branch into this package (`presence.ts`) — unify
  into `@super-line/core` later if/when libp2p lands. Reserved channel `\x00sl:presence`.
  Defaults: snapshot 10s, liveness TTL 30s (driven by the server heartbeat's `beat`).
- **Delivery guarantee:** at-most-once (parity with Redis/libp2p). Reliable delivery (B)
  explicitly deferred — the last hop (node→client WS) is at-most-once anyway, so per-link
  reliability buys little for a lot of divergent machinery.
- **"Stable" = operationally stable:** clean reconnect across peer restarts, no crash on
  transport errors, presence self-heals via snapshot. One tuning knob: `sendHighWaterMark`
  (generous default) to avoid silent HWM drops.
- **Runtime/packaging:** `zeromq` v6 (native addon, Node-only), ESM-only, mirror the
  `adapter-libp2p` scaffolding (tsup, typedoc, README shape). Verify v6 API at impl time.
- **Names:** package `@super-line/adapter-zeromq`; `createZeroMqAdapter`, `createZeroMqProxy`.

## TDD slices

1. **Core mesh adapter.** Package scaffold + `createZeroMqAdapter` mesh mode: multipart
   pub/sub, `subscribe`/`unsubscribe`/`publish`/`onMessage`/`close`, explicit loopback,
   `sendHighWaterMark`. Tests: 2-node send/receive over real `tcp://127.0.0.1:<ephemeral>`,
   binary payload round-trips as `Buffer`, per-channel filtering (non-subscribed dropped).
2. **Proxy mode + forwarder + BYO.** `createZeroMqProxy` (XSUB⇄XPUB) + bin; proxy-mode
   adapter wiring; BYO `{ pub, sub }` path. Tests: fan-out through the forwarder; BYO sockets.
3. **Presence.** Copy `presence.ts` (`GossipPresence`) + its `presence.reconcile` unit test.
   Wire into the adapter (broadcast to reserved channel, route incoming to `receive`).
4. **Server-side parity suite.** `zeromq-cluster.ts` harness (N-node mesh) + integration
   tests: cross-node room fan-out, topic fan-out, cluster bus, presence
   (`list/byUser/roomMembers/topology/count` + liveness expiry).
5. **Stability + proxy integration.** Kill/restart a peer → fan-out resumes + presence
   self-heals (the explicit "stable" ask). One proxy-mode integration test end-to-end.
6. **Examples + docs.** `examples/scaling-zeromq` (3-node mesh + Caddy, Docker). 
   `examples/react-chat-cluster-zeromq` — seed from `react-chat-cluster`, drop the `redis`
   service, swap to `createZeroMqAdapter` mesh, 3 nodes, env-driven `ZMQ_BIND`/`ZMQ_PEERS`,
   Control Center unchanged. README framed as the "delete your broker" before/after.
   Docs: package README, `scaling-adapters` guide (Redis=central / libp2p=gossip /
   ZeroMQ=mesh-or-forwarder + the O(N²)/static-list honesty note), root README, typedoc.
