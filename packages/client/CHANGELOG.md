# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## Unreleased

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **docs:** Two broken links that failed the Deploy docs workflow ([d1fda1e])

## [client-v0.11.1] — 2026-07-17

### Features

- **core,server,client:** CRDT seams for channel resources — plugin CRDT policies + per-open origin ([b1a7445])

## [client-v0.11.0] — 2026-07-17

### Features

- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])
- **plugin-chat:** Streaming Phase 2 — client writer + one assembled feed ([8bf554f])

### Bug Fixes

- **collections:** Close two subscribe-time delivery holes (deaf-UI race) ([8ce298b])
- **client:** Surface a settled subscription's re-subscribe failure ([2f19702])

### CI

- **docs:** Check links in built site ([18f663f])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## [client-v0.9.0] — 2026-07-09

### Features

- **collections:** Reject→resync for CRDT documents (Phase 1.5) ([1695584])
- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])

## [client-v0.8.1] — 2026-07-06

### Features

- **collections:** Typed row collections — core IR, memory backend, server routing + policies, client primitive ([d6ac949])

## [client-v0.8.0] — 2026-07-04

### Features

- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])

### Documentation

- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## [client-v0.7.0] — 2026-06-29

### Features

- **store:** Cluster-wide deletion fan-out (sdel) across relay stores ([2c8a46f])
- **store:** Server-side reactive co-writer (ServerStore.open) + client delete(path) ([bda00a5])
- **client:** Store wiring — stores option, client.store(name), reactive handle, reconnect (slice 4) ([213a131])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])

### Chores

- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [client-v0.3.0] — 2026-06-22

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

## [client-v0.2.0] — 2026-06-15

### Features

- Server→client request/response, cross-node (slice 6) ([926e753])

### Documentation

- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## [client-v0.1.0] — 2026-06-15

### Features

- **server,client:** Role-scoped contracts end-to-end (slices 2-5) ([a971e9b])
- Client opt-in inbound validation (drift detection) ([ad69f2f])
- Client auto-reconnect, re-subscribe, in-flight reject, queue flush ([7eec1cf])
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


