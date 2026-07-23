# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [server-v0.15.0] — 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

## [server-v0.14.1] — 2026-07-23

### Features

- **core:** Report plugin provenance on getContract (ADR-0016) ([fd6270e])

## [server-v0.14.0] — 2026-07-22

### Features

- **auth:** Add connection sessions and member presence ([1dcad5f])
- **adapter-libp2p:** Add Kubernetes DNS discovery ([4ea1b83])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## [server-v0.13.1] — 2026-07-17

### Features

- **core,server,client:** CRDT seams for channel resources — plugin CRDT policies + per-open origin ([b1a7445])

## [server-v0.13.0] — 2026-07-17

### Features

- **collections-sqlite:** Typed per-collection tables (col_<name>) replace the generic row table ([eea2111])
- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])
- **plugin-chat:** Streaming messages Phase 1 — parts-as-rows server core ([7191ce8])

### Bug Fixes

- **collections:** Close two subscribe-time delivery holes (deaf-UI race) ([8ce298b])

### Testing

- Two-lane suite — shared Docker brokers + fast/integration split ([8a76c39])

## [server-v0.12.0] — 2026-07-16

### Bug Fixes

- **client:** Surface a settled subscription's re-subscribe failure ([2f19702])

### Refactor

- **core:** Discriminate CollectionStore on clustering (ADR-0009) ([bfda9f4])
- **server:** Lift the Collection runtime behind an interface ([729c2b6])
- **server:** Give node identity on the wire one home (Cluster) ([335cccc])

### Testing

- **server:** Unit-test the Collection runtime through its seam ([2e20ca7])
- **server:** Characterize cross-node collection relay ([0c10ff6])

## [server-v0.11.2] — 2026-07-13

### Features

- **control-center:** Filter collections by created/updated timestamps ([03aeaa9])
- **control-center:** Filter and sort the Collections view ([708c066])
- **control-center:** Show per-row created/updated in Collections view ([a982431])

## [server-v0.11.1] — 2026-07-13

### Features

- **inspector:** Surface collection & CRDT frames in the Control Center live feed ([72a4767])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## [server-v0.11.0] — 2026-07-09

### Features

- **collections:** Reject→resync for CRDT documents (Phase 1.5) ([1695584])
- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Bug Fixes

- **collections:** Reject→resync rebuilds the CRDT replica from authoritative state ([630ca22])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])

## [server-v0.10.2] — 2026-07-06

### Features

- **core,server:** Contract-fragment plugins + plugin-contributed policies ([df7e72d])
- **collections:** Self-clustering pglite backend + prev-less delete routing ([e252c3b])
- **collections:** Inspector introspection surface (schema graph + row browsing) ([9651940])
- **collections:** Opt-in advisory foreign-key checks ([0624e77])
- **collections:** Durable SQLite backend with IR→SQL snapshot pushdown ([1c29230])
- **collections:** Typed row collections — core IR, memory backend, server routing + policies, client primitive ([d6ac949])

## [server-v0.10.1] — 2026-07-04

### Bug Fixes

- **server:** Distribute HandledKeys over the plugin tuple ([082e38b])

## [server-v0.10.0] — 2026-07-04

### Features

- **stores:** Filtered list(opts) + searchPrincipals across the 5 remaining backends ([e1ef160])
- **store-memory:** Filtered list(opts) + searchPrincipals + ACL index ([fce182e])
- **server:** Forward list(opts)/searchPrincipals through ServerStoreHandle ([86da901])
- **server:** Expose room() on PluginContext ([873f4ba])
- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])
- **adapter-libp2p:** One `discovery` knob + createRelayNode ([70ebdae])
- **server:** Optional origin on ServerStoreHandle.write() ([5649ea7])

### Chores

- **server:** Release 0.9.0 ([e7e845e])

### Documentation

- **plugins:** Guide, Control Center migration, inspector-as-plugin ([c34c0a3])
- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## [server-v0.8.0] — 2026-06-29

### Features

- **store-pglite:** Self-clustering store over Postgres + Electric ([8600432])
- **store:** Cluster-wide deletion fan-out (sdel) across relay stores ([2c8a46f])

## [server-v0.7.1] — 2026-06-26

### Features

- **inspector:** Live-feed columns via InspectorEnvelope ([5113c4a])
- **control-center:** Inspect Store values + ai-canvas docker stack ([ad60902])
- **store:** Server-side reactive co-writer (ServerStore.open) + client delete(path) ([bda00a5])
- **inspector,control-center:** Store.* events + Store live-feed filter (slice 6) ([3667353])
- **server:** Cross-node store relay + self passthrough (slice 5) ([5007dcf])
- **server:** Store wiring — stores option, srv.store(name), ACL, fan-out (slice 3) ([af2e178])
- **core,server:** Store seam interfaces + principal fallback (slice 1) ([7cba426])
- **server:** Thread the client↔server transport onto ConnDescriptor (Phase 1) ([eaf6071])
- **transport-http:** Add SSE + long-poll HTTP transport ([7e4e8f6])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])

### Bug Fixes

- **inspector:** Address review — stable feed keys, pause-gated sort ([8fd4cba])
- **server:** Make createSuperLineServer runnable in-browser ([ce2b3fc])

### Chores

- Bump versions for store-value inspection ([01b2d6c])
- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [server-v0.3.0] — 2026-06-22

### Features

- **adapter-rabbitmq:** Gossip-replicated presence directory (slice 4) ([273afb2])
- **adapter-rabbitmq:** Broker-routed fan-out skeleton + reviewed plan (slice 1) ([5c5e8f0])
- **adapter-libp2p:** Node ownership, identity & transport config (slice 5) ([1b8fc36])
- **adapter-libp2p:** Gossip-replicated presence directory (slice 3) ([a8d2ab1])
- **adapter-libp2p:** Core gossipsub fan-out on one shared topic (slice 1) ([1280d2a])
- **control-center:** Render message traffic in the live feed (T3.3) ([09fc087])
- **inspector:** Tap message traffic to the inspector (T3.1, T3.2) ([2708bc6])
- **control-center:** Resolve connection names in the live feed (T1.3) ([61fad70])
- **inspector:** Friendly nodeName option surfaced through topology (T1.1) ([d2a6805])
- **server:** Remove serverToServer — the cluster bus subsumes it ([c9772c7])
- **server:** Cluster event bus — server.publish/subscribe with local echo ([3eb6a0d])
- **server:** Inspector live events topic — cross-node fan-out (control-center slice 5) ([b00c251])
- **server:** Inspector getConn — safe node-local ctx/data snapshot + redact (control-center slice 4) ([48c5f8a])
- **server:** Inspector getContract — structure + best-effort JSON Schema (control-center slice 3) ([9258e55])
- **server:** Inspector WS channel — auth short-circuit + read-only introspection (control-center slice 2) ([da6cf30])

### Refactor

- Apply SuperLine rename to the rabbitmq adapter ([f51b122])
- Rename Socket* API to SuperLine* brand language ([a2da0ad])

### Testing

- **adapter-rabbitmq:** Cluster-wide inspector events (slice 5) ([cceda5e])
- **adapter-rabbitmq:** Targeted send + cluster event bus cross-process (slice 3) ([69b4304])
- **adapter-rabbitmq:** Reconnect resilience — bindings replay after broker restart (slice 2) ([b49fac4])
- **adapter-zeromq:** Reconnect/self-heal + proxy integration + stable suite (slice 5) ([60597af])
- **server:** Zeromq cross-node parity suite through the full server (slice 4) ([847e539])
- **adapter-libp2p:** Presence liveness, queries + clearNode through the server (slice 4) ([d02285d])
- **adapter-libp2p:** All channel types cross-node over memory transport (slice 2) ([6f1593e])
- **inspector:** Cross-node message events over Redis + docs (T3.5) ([e68a5b7])
- **server:** Redis cross-node coverage for the cluster bus ([01170aa])

## [server-v0.2.0] — 2026-06-15

### Features

- Typed conn.data per-connection state (slice 8) ([f424b4e])
- **server:** Backpressure safeguard against slow consumers (slice 7) ([dccc5cc])
- Server→client request/response, cross-node (slice 6) ([926e753])
- **server:** Targeted cross-node send — toConn/toUser emit + kick (slice 5) ([79228bd])
- **adapter-redis:** Redis presence store with alive-TTL + graceful cleanup (slice 4) ([1041c1c])
- Presence registry + cluster introspection surface (slice 3) ([fa74a7d])
- **server:** Heartbeat with lastPong/lastPing liveness + opt-in reaping (slice 2) ([f6db155])
- **server:** Conn id/connectedAt + local introspection surface (slice 1) ([64815ec])

### Testing

- **server:** Redis coverage for targeted send + server→client req/res (slices 5/6) ([6d2a61d])

### Documentation

- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## [server-v0.1.0] — 2026-06-15

### Features

- **server:** ServerToServer inter-node messaging (slice 6) ([92fdcf9])
- **server,client:** Role-scoped contracts end-to-end (slices 2-5) ([a971e9b])
- Redis pub/sub adapter + cross-process testcontainers tests ([8e281d4])
- Client opt-in inbound validation (drift detection) ([ad69f2f])
- Flat middleware chain + onError hook ([5848144])
- Client auto-reconnect, re-subscribe, in-flight reject, queue flush ([7eec1cf])
- Adapter seam + cross-node fan-out; unify rooms/topics on channels ([c35829b])
- Topics pub/sub (server-only publish, authorize-on-subscribe) ([a281a02])
- Rooms + server-pushed events ([05072c9])
- Auth reject at upgrade + test harness; fix client thenable footgun ([ffc549c])

### Chores

- Add repository/homepage/bugs metadata (origin known) ([fef6c22])
- Scaffold pnpm workspace + req/res vertical slice ([3513dc8])

### Documentation

- **tsdoc:** Document the public API for the generated reference (slice 3) ([36536a8])
- **site:** Generate API reference from source via TypeDoc (slice 2) ([f5683ee])
- README overhaul (hero, TOC, guides, comparison) + MIT LICENSE + package metadata ([d3bb349])


