# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Chores

- Add VS Code debug configs for tsx examples ([0293788])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])

## 2026-07-23

### Features

- **control-center:** Join plugin-auth identity onto connections ([5e1621e])
- **control-center:** Surface plugins as a first-class dimension ([dc7fe3a])
- **core:** Report plugin provenance on getContract (ADR-0016) ([fd6270e])
- **auth:** Split bearer assertions into signed and sealed ([785a839])
- **example:** Demonstrate JWT auth and getToken ([73ba14b])

### Refactor

- **example:** Port react-chat-transports to plugin-auth + plugin-chat ([afea616])

### Documentation

- Cover plugin provenance and the Control Center identity lens ([3cf1cb5])

## 2026-07-22

### Features

- **auth:** Add connection sessions and member presence ([1dcad5f])

### Bug Fixes

- **example:** Resolve websocket transport source ([2a15093])

### Documentation

- Plan auth connection sessions and presence ([2ccaaeb])

## 2026-07-21

### Features

- **plugin-chat:** Publish the resource access resolvers on chatKit ([466812e])

## 2026-07-20

### Features

- **adapter-libp2p:** Add Kubernetes DNS discovery ([4ea1b83])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## 2026-07-20

### Bug Fixes

- **react:** Read collections/docs through useSyncExternalStore, guard stale responses ([fb68c72])
- **plugin-chat,control-center:** Reset history during render + keyboard-reachable rows ([4a02fae])
- **react,control-center,examples:** Render-purity + explicit button types ([a07e688])

## 2026-07-19

### Features

- **examples,plugin-chat:** Showcase 0.6.0 features in chat examples ([d8fe270])
- **plugin-chat:** 0.6.0 — the OMMA-findings train ([57238b6])

### Documentation

- **plugin-chat:** Add 0.5 migration guide ([8dc01bf])

## 2026-07-19

### Features

- **plugin-chat:** Adopt durable generic stream architecture ([dce8ec1])

### Documentation

- **plugin-chat:** Thin-glue tail — PLAN amendment + skill memory recipe ([a23227a])

## 2026-07-18

### Features

- **examples:** Chat-supervisor terminal cockpit — OpenTUI TUI + headless shell ([d6541b1])

### Refactor

- **plugin-chat:** MastraEngine is thin glue — drop maxSteps mirrors, memory via Agent defaultOptions ([33827ca])

### Chores

- **examples:** Retire store-sync-json — superseded by the CRDT-collections examples ([0148d3f])

### Documentation

- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])
- **examples:** Chat-supervisor TUI demo recording — vhs tape + GIF hero ([4fa1c01])

## 2026-07-18

### Bug Fixes

- **collections-pglite:** Quote the Electric shape table param — camelCase collections 400'd at boot ([22a646f])

## 2026-07-18

### Features

- **examples:** Chat-supervisor — human + agent collaborate on channel resources ([8ea086b])

### Bug Fixes

- **deps:** Core (and client) become peerDependencies in plugin-inspector, plugin-auth, tanstack-db ([f2a5cd5])
- **docs:** Two broken links that failed the Deploy docs workflow ([d1fda1e])

### Chores

- Ignore .env at repo root ([1a00bb5])

### Documentation

- Brighten channel resources — Tutorial 6, examples catalog, skill/reference, reframed example ([2a6493f])

## 2026-07-17

### Features

- **plugin-chat:** Channel resources — kind registry, owned/linked lifecycle, acked writes, /ai tools, presence ([0f979e4])
- **core,server,client:** CRDT seams for channel resources — plugin CRDT policies + per-open origin ([b1a7445])

### Documentation

- **chat-resources:** PLAN + how-to guide + runnable example + README/skill tail ([c81b57e])

## 2026-07-17

### Features

- **collections-pglite:** Typed per-collection tables over N Electric shapes (Phase 2b) ([a2431d9])
- **collections-sqlite:** Typed per-collection tables (col_<name>) replace the generic row table ([eea2111])
- **core:** PlanColumns — Zod→column introspection for typed per-collection tables ([c042278])
- **examples:** Stream agent reasoning — extended thinking via Agent defaultOptions ([47a9d2d])
- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])
- **plugin-chat:** OnChatMessage bot loop + provisionChatBot (PLAN-chat-mastra Phase B) ([3e82f04])
- **plugin-chat:** /mastra subpath — mastraEngine wires plain Mastra Agents to streamed messages ([05373d3])
- **examples/chat-supervisor:** Channels sidebar — every channel a conversation ([87ca71a])
- **examples:** Chat-supervisor — Mastra supervisor/subagent on plugin-chat, no harness ([030cd7b])
- **examples/collections-chat:** Mobile-friendly layout ([b3e1cf2])
- **plugin-chat:** Streaming Phase 3 — pipeUIMessageStream + a live streaming agent ([f90400a])
- **plugin-chat:** Streaming Phase 2 — client writer + one assembled feed ([8bf554f])
- **plugin-chat:** Streaming messages Phase 1 — parts-as-rows server core ([7191ce8])
- **plugin-chat:** AI SDK agent toolset — /ai subpath (PLAN decision 17) ([89ca8f6])
- **plugin-chat:** Client/react halves + collections-chat rewrite with a live LLM agent (Phase 2) ([39beca1])
- **plugin-chat:** Chat backbone plugin — Phase 1 core (contract fragment + hookable server kit) ([52836b9])
- **plugin-auth:** Imperative users/apiKeys management + soft-delete (plugin-chat Phase 0) ([373130c])

### Bug Fixes

- **plugin-chat:** Review fixes — bot-name hijack, self-delegation, chain teardown ([611925d])
- **collections:** Close two subscribe-time delivery holes (deaf-UI race) ([8ce298b])
- **docs:** Also build plugin-auth before the docs build ([fb4ea2c])
- **docs:** Build collections-memory + plugin-chat before the docs build ([967b364])

### Refactor

- **examples:** Both bots onto the plugin-chat helpers; docs for /mastra + the bot loop ([3b8e3cf])

### Testing

- **collections-pglite:** Real-Electric integration harness for LWW rows (Phase 2a) ([d209f62])
- Move the in-process PGlite suite to the serial lane ([03cef1f])
- Two-lane suite — shared Docker brokers + fast/integration split ([8a76c39])

### Chores

- Server to 0.0.0.0 ([3e04cb3])
- Add LICENSE files to plugin-auth + plugin-chat for publish ([150a9ce])
- Ignore .agents folder ([198382e])

### Documentation

- Typed-table factory signatures across docs, skills, READMEs, CLAUDE.md ([5df22b4])
- **plugin-chat:** Split into core/streaming/bots guides + Tutorial 5 ([ce19886])
- **plan:** PLAN-chat-mastra status → BUILT ([3178bad])
- **home:** Make the chat showcase a real interactive in-browser instance ([1c1d4d4])
- **home:** Showcase the chat plugin with a live human + AI-agent demo ([a98db17])
- **plugins:** Document full authKit + chatKit method surfaces ([201a4be])
- **plugins:** Add plugin-auth README, expand plugin-chat README ([b48371a])
- **plugin-chat:** Document the /ai agent toolset ([baacde5])
- **plugin-chat:** Tutorial 4, close doc gaps, fix imperative-kit snippet ([f23ac20])

## 2026-07-16

### Bug Fixes

- **client:** Surface a settled subscription's re-subscribe failure ([2f19702])

### Refactor

- **core:** Discriminate CollectionStore on clustering (ADR-0009) ([bfda9f4])
- **server:** Lift the Collection runtime behind an interface ([729c2b6])
- **server:** Give node identity on the wire one home (Cluster) ([335cccc])

### Testing

- **crdt:** Pin removeAtPath's merge behaviour — and retract a false finding ([43770ea])
- **collections:** Specify the CollectionStore seam in tests, not prose ([c1cb594])
- **server:** Unit-test the Collection runtime through its seam ([2e20ca7])
- **server:** Characterize cross-node collection relay ([0c10ff6])

### Documentation

- **context:** Name Cluster, local delivery, and the relay-sync invariant ([d28ce56])

## 2026-07-13

### Security

- Surface collection/CRDT live-feed events; de-stale ai-canvas & CC READMEs ([203ea74])

### Features

- **control-center:** Filter collections by created/updated timestamps ([03aeaa9])
- **control-center:** Filter and sort the Collections view ([708c066])
- **control-center:** Show per-row created/updated in Collections view ([a982431])

## 2026-07-13

### Features

- **inspector:** Surface collection & CRDT frames in the Control Center live feed ([72a4767])

### Bug Fixes

- **docs:** Unify landing install commands ([9409c93])
- **docs:** Repair landing page funnel ([aa1dc6a])

### CI

- **docs:** Check links in built site ([18f663f])

### Documentation

- Add plugin catalog ([5d557a2])
- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## 2026-07-09

### Features

- **collections:** CRDT self-clustering tier — collections-crdt-pglite (Phase 2) ([2f32b8c])
- **collections:** Reject→resync for CRDT documents (Phase 1.5) ([1695584])
- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Bug Fixes

- **examples:** Ai-canvas-pglite — tolerant CRDT schema fixes the sync-wedge ([a299d3f])
- **collections:** Reject→resync rebuilds the CRDT replica from authoritative state ([630ca22])
- **collections:** Guard the pglite op-log feed against partial-column re-sync rows ([d0acf92])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])
- **examples:** Ai-canvas-pglite uses the libp2p adapter's mDNS discovery ([2f97f8b])
- **examples:** Delete the 4 LWW-store examples (superseded by collections) ([4705058])
- **examples:** Migrate CRDT-store examples to CRDT document collections ([a0c72ac])

### Documentation

- **skill:** Retire store, promote collections + add auth/plugins/composition ([26c2121])
- **adr:** ADR-0008 (validate the write, not the document) + compaction-safety rule ([ae85fbc])
- **skill:** CRDT document collections + purge deleted store-sync-libsql ([4efe219])
- Purge deleted store-sync-libsql from live docs ([136cea3])

## 2026-07-06

### Security

- **plugin-auth:** Guide + sidebar + CLAUDE.md architecture note ([a12db88])
- **examples:** Collections-chat — a Slack-like app on Collections ([ebecffd])
- **examples:** Collections — messages⊕users join over the TanStack DB adapter ([9f585c5])

### Features

- **examples:** Collections-chat — real auth via @super-line/plugin-auth ([96fa319])
- **plugin-auth:** React binding (/react) + displayName in the identity ([2f93561])
- **plugin-auth:** API keys, JWT, revoke-and-kick, password reset ([422ca01])
- **plugin-auth:** First-party authentication as a paired plugin ([2fe2df2])
- **core,server:** Contract-fragment plugins + plugin-contributed policies ([df7e72d])
- **collections:** Self-clustering pglite backend + prev-less delete routing ([e252c3b])
- **control-center:** Collections view — schema panel + row browser ([acd0203])
- **collections:** Inspector introspection surface (schema graph + row browsing) ([9651940])
- **collections:** Opt-in advisory foreign-key checks ([0624e77])
- **collections:** Durable SQLite backend with IR→SQL snapshot pushdown ([1c29230])
- **collections:** TanStack DB adapter + react useCollection ([c43c1ee])
- **collections:** Typed row collections — core IR, memory backend, server routing + policies, client primitive ([d6ac949])

### Bug Fixes

- **tanstack-db:** Guard the sync engine against cancellation before ready ([670c47b])

### Chores

- **collections:** Deprecate the LWW store-* family in favor of collections-* ([b137122])

### Documentation

- **collections:** Guide, skill, and positioning for typed collections ([d8cf0b5])
- **collections:** PLAN + ADR-0006 for typed row collections ([43b1740])

## 2026-07-04

### Features

- **examples:** Chat-moderation — authoring a paired plugin ([40b274f])

### Bug Fixes

- **server:** Distribute HandledKeys over the plugin tuple ([082e38b])

### Testing

- **core:** Add searchPrincipals to the InspectorContract surface assertion ([5fa7cbf])

## 2026-07-04

### Features

- **control-center:** Filter/sort/paginate the store view ([7687bda])
- **stores:** Filtered list(opts) + searchPrincipals across the 5 remaining backends ([e1ef160])
- **store-memory:** Filtered list(opts) + searchPrincipals + ACL index ([fce182e])
- **plugin-inspector:** Serve filtered listResources + searchPrincipals ([498a229])
- **core:** Reshape InspectorContract for filtered listResources + searchPrincipals ([517fe16])
- **server:** Forward list(opts)/searchPrincipals through ServerStoreHandle ([86da901])
- **core:** Reshape ServerStore.list(opts) + required searchPrincipals ([f87e55a])
- **server:** Expose room() on PluginContext ([873f4ba])
- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])
- **adapter-libp2p:** One `discovery` knob + createRelayNode ([70ebdae])
- **control-center:** Brand lockup with status-EKG pulse mark ([5a10426])
- **control-center:** Export the live feed as JSON / JSONL / CSV ([b6fc329])
- **core:** DefineSurface + mergeSurfaces — contract composition over namespaces (ADR-0004) ([0af6f5d])
- **server:** Optional origin on ServerStoreHandle.write() ([5649ea7])

### Bug Fixes

- **store-pglite:** Swallow 42710 in the create-table-if-not-exists race ([540644a])

### Testing

- **store-sync-pglite:** E2e co-writer convergence over real Electric ([26bcbb1])

### Chores

- **store-pglite:** Release 0.1.1 ([c161fdb])
- **control-center:** Release 0.8.0 ([0604e8d])
- **core:** Release 0.9.0 ([94a5af2])
- **server:** Release 0.9.0 ([e7e845e])
- Impeccable skill update (v3.8.x detector + reference tweaks) ([12c9229])

### Documentation

- Document server-side store filtering + the Control Center Stores view ([2405edc])
- **plugins:** Building-plugins guide + inspector migration note ([528cabf])
- **plugins:** Guide, Control Center migration, inspector-as-plugin ([c34c0a3])
- Add plugin system plan ([3cdf9b8])
- **guide:** Composition — embedding a super-line library ([6494695])
- Critique-driven fixes — reference front door, brand cohesion, unpublish ADRs ([ecbdc45])
- **theme:** Adopt Ioskeley Mono as the code face ([2acb777])
- **guide:** Add dedicated store-sync-pglite guide page ([ac4714c])
- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## 2026-06-29

### Features

- **store-sync-pglite:** CRDT store over Postgres + Electric op-log ([ef0c922])
- **store-pglite:** Self-clustering store over Postgres + Electric ([8600432])
- **store:** @super-line/store-sync-libsql — durable CRDT store on libsql/Turso ([5b185a0])
- **store:** Cluster-wide deletion fan-out (sdel) across relay stores ([2c8a46f])
- **example:** Libp2p-nat — STUN for cross-NAT WebRTC + wss relay build option ([dc59b02])
- **example:** Libp2p-nat — chat servers behind NAT, browsers over WebRTC via a relay ([7930574])

### Refactor

- **example:** Store-pglite peers via mDNS, no hardcoded cluster size ([d48ff63])

### Documentation

- **plan:** Store-sync-libsql durable CRDT store + deletion fan-out ([c145fcc])

## 2026-06-26

### Features

- **example:** Launch the Control Center against advanced-chat-app ([955304c])
- **inspector:** Live-feed filters + size/latency magnitude bars ([b4211db])
- **inspector:** Live-feed columns via InspectorEnvelope ([5113c4a])
- **docs:** Live cross-node pub/sub showcase on the landing page ([174b22d])
- **control-center:** Inspect Store values + ai-canvas docker stack ([ad60902])
- **examples:** Ai-canvas — server-side LLM agent as a Store co-writer ([b40dbc6])
- **store:** Server-side reactive co-writer (ServerStore.open) + client delete(path) ([bda00a5])
- **store-sqlite:** Durable SQLite Store + advanced-chat-app example ([df8757a])
- **store-sync:** Document-mode passthrough via resolveOptions ([bad8f97])
- **examples:** Store-sync-json — collaborative JSON editor via visual-json ([3035786])
- **store-sync:** CRDT Store pair backed by super-store (slice 8) ([3dc4741])
- **react:** UseResource hook (slice 7) ([d2f0f12])
- **inspector,control-center:** Store.* events + Store live-feed filter (slice 6) ([3667353])
- **server:** Cross-node store relay + self passthrough (slice 5) ([5007dcf])
- **client:** Store wiring — stores option, client.store(name), reactive handle, reconnect (slice 4) ([213a131])
- **server:** Store wiring — stores option, srv.store(name), ACL, fan-out (slice 3) ([af2e178])
- **store-memory:** In-memory LWW Store pair (slice 2) ([e1dd5b6])
- **core,server:** Store seam interfaces + principal fallback (slice 1) ([7cba426])
- **docs:** Per-page markdown + llms.txt for AI agents ([81e13ff])
- **examples:** Add CRDT synced-state playgrounds (yjs + automerge) ([16dbae2])
- **control-center:** Attribute live-feed rows to their wire (Phase 3) ([2f8cb07])
- **control-center:** Surface transport as a first-class dimension (Phase 2) ([d2d17d1])
- **server:** Thread the client↔server transport onto ConnDescriptor (Phase 1) ([eaf6071])
- **examples:** Add react-chat-transports — a live transport dial (WS/HTTP/libp2p) ([d4d63e1])
- **transport-libp2p:** Add libp2p protocol-stream transport ([8a5bb47])
- **transport-http:** Add SSE + long-poll HTTP transport ([7e4e8f6])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])
- **examples:** Add hono single-port HTTP + WebSocket demo ([be736d4])

### Bug Fixes

- **inspector:** Address review — stable feed keys, pause-gated sort ([8fd4cba])
- **docs:** Build workspace packages before the vitepress bundle ([df83db6])
- **server:** Make createSuperLineServer runnable in-browser ([ce2b3fc])
- **docs:** Serve from the super-line.dogar.biz custom domain ([130bd9a])
- **store-sync:** Server co-write MERGES top-level keys (not full replace) ([1d713e9])
- **examples:** Migrate the hono demo to the pluggable-transport API ([3f9581c])

### Chores

- Summer cleaning ([8b31ea7])
- Bump versions for store-value inspection ([01b2d6c])
- Release store-sync v0.5.1 ([0d2236e])
- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])
- Update impeccable skills ([0295e19])
- Ignore impeccable folders ([247e778])
- Add impeccable skill ([eca1822])

### CI

- **docs:** Trigger the deploy on root manifest changes ([8c25e15])

### Documentation

- **store:** Document the server-side reactive co-writer + client delete(path) ([80eb9bb])
- Teach store-sync as a first-class CRDT Store; improve the store section ([0e062c9])
- **store:** Record as-built deviations (store(name) method, store-sync package) ([af2b47b])
- **store:** Guide, permissioned-doc example, README + sidebar (slice 9) ([7c47ac1])
- **store:** Design — CONTEXT glossary, ADR-0002/0003, PLAN-store.md ([2744b20])
- **guide:** Make getting-started a complete, runnable quickstart ([e4a4ae8])
- **context:** Promote Store/Resource as the persisted-state primitive ([2bd04a7])
- Document the CRDT synced-state pattern + examples ([5d1f9f4])
- Split adapters into their own guide section, mirroring transports ([60626a7])
- Showcase pluggable transports on the landing page ([1330a06])
- Make transports a top-level pillar + add the 'any wire' showcase example ([9f00387])
- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## 2026-06-22

### Features

- **adapter-rabbitmq:** Gossip-replicated presence directory (slice 4) ([273afb2])
- **adapter-rabbitmq:** Broker-routed fan-out skeleton + reviewed plan (slice 1) ([5c5e8f0])
- **examples,docs:** Scaling-zeromq + react-chat-cluster-zeromq + docs (slice 6) ([f118277])
- **adapter-zeromq:** Gossip presence directory (slice 3) ([8c19407])
- **adapter-zeromq:** Proxy mode, forwarder + bin, BYO sockets (slice 2) ([47705d8])
- **adapter-zeromq:** Brokerless mesh adapter core (slice 1) ([dd22ce0])
- **adapter-libp2p:** Node ownership, identity & transport config (slice 5) ([1b8fc36])
- **adapter-libp2p:** Gossip-replicated presence directory (slice 3) ([a8d2ab1])
- **adapter-libp2p:** Core gossipsub fan-out on one shared topic (slice 1) ([1280d2a])
- **docs:** Redesign home — cyan brand theme + data-bus positioning ([9c58f20])
- **control-center:** Filter + pause controls on the live feed (T3.4) ([ea7751b])
- **control-center:** Render message traffic in the live feed (T3.3) ([09fc087])
- **inspector:** Tap message traffic to the inspector (T3.1, T3.2) ([2708bc6])
- **control-center:** Resources page linking docs/landing/repo (T5) ([4c8a42f])
- **control-center:** Move the connection into a Settings page (T4) ([6900cc2])
- **control-center:** Copy button on JSON blocks (T1.5) ([a234803])
- **control-center:** Humanize timestamps in the table + conn drawer (T1.4) ([75ea696])
- **control-center:** Resolve connection names in the live feed (T1.3) ([61fad70])
- **control-center:** Label nodes by friendly name (T1.2) ([e427125])
- **inspector:** Friendly nodeName option surfaced through topology (T1.1) ([d2a6805])
- **control-center:** Bin redirects bare root to the --url endpoint ([c337a80])
- **examples:** Add react-chat-cluster — chat across two servers ([e494585])
- **server:** Remove serverToServer — the cluster bus subsumes it ([c9772c7])
- **server:** Cluster event bus — server.publish/subscribe with local echo ([3eb6a0d])
- **control-center:** Npx bin + docs + publish prep (control-center slice 9) ([0e4115c])
- **control-center:** Connections table + ctx drawer, contract explorer, live feed (control-center slice 8) ([0c82317])
- **control-center:** Topology graph — React Flow hub-and-spoke (control-center slice 7) ([bc69172])
- **control-center:** SPA scaffold + typed inspector client (control-center slice 6) ([268df6b])
- **server:** Inspector live events topic — cross-node fan-out (control-center slice 5) ([b00c251])
- **server:** Inspector getConn — safe node-local ctx/data snapshot + redact (control-center slice 4) ([48c5f8a])
- **server:** Inspector getContract — structure + best-effort JSON Schema (control-center slice 3) ([9258e55])
- **server:** Inspector WS channel — auth short-circuit + read-only introspection (control-center slice 2) ([da6cf30])
- **core:** InspectorContract + contract classifier (control-center slice 1) ([ab9a787])

### Bug Fixes

- Reconcile the inspector with serverToServer removal ([f92b456])

### Refactor

- Apply SuperLine rename to the rabbitmq adapter ([f51b122])
- Apply SuperLine rename to the zeromq adapter ([1fa271e])
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

### Chores

- Remove plan.md ([9d12180])
- Drop throwaway cc-seed.mts that slipped into T3.1 ([d7b57ea])

### Documentation

- Add root CLAUDE.md with commands, layout, and gotchas ([d6c646c])
- **adapter-rabbitmq:** Examples + scaling guide + typedoc (slice 6) ([9d81e5c])
- **control-center:** Screenshot-driven guide walkthrough ([1c4a82e])
- **examples:** React-chat-cluster-libp2p — Redis-free React cluster over the libp2p adapter ([33a1aae])
- **adapter-libp2p:** Scaling-libp2p example, README, typedoc + guide (slice 6) ([df262ae])
- **examples:** Showcase the Control Center in react-chat-cluster ([866b63e])
- **examples:** Catalog react-chat-cluster ([3215231])
- Document the cluster event bus; remove serverToServer references ([78bf3bf])
- **examples:** Add event-bus (single process) + bus-cluster (Docker) demos ([d635d84])
- **examples:** Make scaling a real multi-node cluster (Docker Compose) ([017caa2])

## 2026-06-15

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

- **skill:** Codify best practices learned building the new features ([be24e05])
- **examples:** Presence + targeted send + server→client request demo ([d28d522])
- Introspection, presence & server→client req/res (slice 9) ([e64eb32])
- **guide:** Fix single-file install (degit can't fetch one file -> curl) ([88e6100])
- **readme:** Point "Use with your AI agent" at the install guide (slice 3) ([8f85c97])
- **guide:** "Use with your AI agent" install guide (slice 2) ([6d99d40])
- **skill:** Add generic AGENTS.md for non-Claude agents (slice 1) ([db1b4e1])
- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## 2026-06-15

### Features

- **examples:** Port examples to the role + direction model (slice 8) ([1c3c5e5])
- **react:** Thread role through hooks (slice 7) ([aeaebef])
- **server:** ServerToServer inter-node messaging (slice 6) ([92fdcf9])
- **server,client:** Role-scoped contracts end-to-end (slices 2-5) ([a971e9b])
- **core:** Role + direction contract model ([cf20b3a])
- **brand:** Pulse-line logo (SVG) + cyan retheme ([914f140])
- @super-line/react hooks + runnable chat example ([0381267])
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

### CI

- **docs:** GitHub Pages deploy workflow (slice 7) ([150b653])

### Documentation

- Cross-link the agent skill to the docs site (slice 8) ([ae4c82b])
- **readme:** Slim to a landing page that links into the site (slice 6) ([3da7890])
- **site:** Examples pages + home polish (slice 5) ([445de07])
- **guide:** Write the guide pages (slice 4) ([4607414])
- **tsdoc:** Document the public API for the generated reference (slice 3) ([36536a8])
- **site:** Generate API reference from source via TypeDoc (slice 2) ([f5683ee])
- **site:** Scaffold VitePress docs site (slice 1) ([2927a47])
- **readme:** Role + direction model (slice 10) ([f5bf889])
- **skill:** Rewrite agent skill for the role + direction model (slice 9) ([b7284c1])
- **skill:** Add super-line agent skill (usage + best practices + testing) ([f4a4cd9])
- README overhaul (hero, TOC, guides, comparison) + MIT LICENSE + package metadata ([d3bb349])
- **assets:** Chat/join/annotated screenshots (cyan mockups, headless-Chrome rendered) ([0ee243e])
- **examples:** Add scaling (multi-node + Redis) and auth (token) examples ([0f7aebb])
- React chat example app + README quickstart ([0d1a70d])


