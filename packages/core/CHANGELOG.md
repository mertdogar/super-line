# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [core-v0.14.0] — 2026-07-22

### Features

- **auth:** Add connection sessions and member presence ([1dcad5f])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## [core-v0.13.1] — 2026-07-17

### Features

- **core,server,client:** CRDT seams for channel resources — plugin CRDT policies + per-open origin ([b1a7445])

## [core-v0.13.0] — 2026-07-17

### Features

- **collections-sqlite:** Typed per-collection tables (col_<name>) replace the generic row table ([eea2111])
- **core:** PlanColumns — Zod→column introspection for typed per-collection tables ([c042278])
- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])

## [core-v0.12.0] — 2026-07-16

### Refactor

- **core:** Discriminate CollectionStore on clustering (ADR-0009) ([bfda9f4])
- **server:** Lift the Collection runtime behind an interface ([729c2b6])
- **server:** Give node identity on the wire one home (Cluster) ([335cccc])

### Testing

- **crdt:** Pin removeAtPath's merge behaviour — and retract a false finding ([43770ea])
- **collections:** Specify the CollectionStore seam in tests, not prose ([c1cb594])

## [core-v0.11.2] — 2026-07-13

### Features

- **control-center:** Filter and sort the Collections view ([708c066])
- **control-center:** Show per-row created/updated in Collections view ([a982431])

## [core-v0.11.1] — 2026-07-13

### Features

- **inspector:** Surface collection & CRDT frames in the Control Center live feed ([72a4767])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## [core-v0.11.0] — 2026-07-09

### Features

- **collections:** Reject→resync for CRDT documents (Phase 1.5) ([1695584])
- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])

## [core-v0.10.1] — 2026-07-06

### Features

- **core,server:** Contract-fragment plugins + plugin-contributed policies ([df7e72d])
- **collections:** Inspector introspection surface (schema graph + row browsing) ([9651940])
- **collections:** Typed row collections — core IR, memory backend, server routing + policies, client primitive ([d6ac949])

### Testing

- **core:** Add searchPrincipals to the InspectorContract surface assertion ([5fa7cbf])

## [core-v0.10.0] — 2026-07-04

### Features

- **core:** Reshape InspectorContract for filtered listResources + searchPrincipals ([517fe16])
- **core:** Reshape ServerStore.list(opts) + required searchPrincipals ([f87e55a])
- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])
- **core:** DefineSurface + mergeSurfaces — contract composition over namespaces (ADR-0004) ([0af6f5d])

### Chores

- **core:** Release 0.9.0 ([94a5af2])

### Documentation

- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## [core-v0.8.0] — 2026-06-29

### Features

- **store-pglite:** Self-clustering store over Postgres + Electric ([8600432])
- **store:** Cluster-wide deletion fan-out (sdel) across relay stores ([2c8a46f])

## [core-v0.7.1] — 2026-06-26

### Features

- **inspector:** Live-feed columns via InspectorEnvelope ([5113c4a])
- **control-center:** Inspect Store values + ai-canvas docker stack ([ad60902])
- **store:** Server-side reactive co-writer (ServerStore.open) + client delete(path) ([bda00a5])
- **inspector,control-center:** Store.* events + Store live-feed filter (slice 6) ([3667353])
- **server:** Cross-node store relay + self passthrough (slice 5) ([5007dcf])
- **core,server:** Store seam interfaces + principal fallback (slice 1) ([7cba426])
- **server:** Thread the client↔server transport onto ConnDescriptor (Phase 1) ([eaf6071])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])

### Chores

- Bump versions for store-value inspection ([01b2d6c])
- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

## [core-v0.3.0] — 2026-06-22

### Features

- **inspector:** Tap message traffic to the inspector (T3.1, T3.2) ([2708bc6])
- **control-center:** Resolve connection names in the live feed (T1.3) ([61fad70])
- **inspector:** Friendly nodeName option surfaced through topology (T1.1) ([d2a6805])
- **server:** Remove serverToServer — the cluster bus subsumes it ([c9772c7])
- **server:** Cluster event bus — server.publish/subscribe with local echo ([3eb6a0d])
- **server:** Inspector getContract — structure + best-effort JSON Schema (control-center slice 3) ([9258e55])
- **core:** InspectorContract + contract classifier (control-center slice 1) ([ab9a787])

### Bug Fixes

- Reconcile the inspector with serverToServer removal ([f92b456])

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

## [core-v0.2.0] — 2026-06-15

### Features

- Typed conn.data per-connection state (slice 8) ([f424b4e])
- Server→client request/response, cross-node (slice 6) ([926e753])
- **adapter-redis:** Redis presence store with alive-TTL + graceful cleanup (slice 4) ([1041c1c])
- Presence registry + cluster introspection surface (slice 3) ([fa74a7d])

### Documentation

- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## [core-v0.1.0] — 2026-06-15

### Features

- **server:** ServerToServer inter-node messaging (slice 6) ([92fdcf9])
- **server,client:** Role-scoped contracts end-to-end (slices 2-5) ([a971e9b])
- **core:** Role + direction contract model ([cf20b3a])
- Client opt-in inbound validation (drift detection) ([ad69f2f])
- Adapter seam + cross-node fan-out; unify rooms/topics on channels ([c35829b])

### Chores

- Add repository/homepage/bugs metadata (origin known) ([fef6c22])
- Scaffold pnpm workspace + req/res vertical slice ([3513dc8])

### Documentation

- **tsdoc:** Document the public API for the generated reference (slice 3) ([36536a8])
- **site:** Generate API reference from source via TypeDoc (slice 2) ([f5683ee])
- README overhaul (hero, TOC, guides, comparison) + MIT LICENSE + package metadata ([d3bb349])


