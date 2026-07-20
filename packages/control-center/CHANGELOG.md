# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [control-center-v0.10.5] — 2026-07-20

### Bug Fixes

- **plugin-chat,control-center:** Reset history during render + keyboard-reachable rows ([4a02fae])
- **react,control-center,examples:** Render-purity + explicit button types ([a07e688])

### Documentation

- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [control-center-v0.10.4] — 2026-07-17

### Features

- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])

## [control-center-v0.10.2] — 2026-07-13

### Security

- Surface collection/CRDT live-feed events; de-stale ai-canvas & CC READMEs ([203ea74])

### Features

- **control-center:** Filter collections by created/updated timestamps ([03aeaa9])
- **control-center:** Filter and sort the Collections view ([708c066])
- **control-center:** Show per-row created/updated in Collections view ([a982431])

## [control-center-v0.10.1] — 2026-07-13

### Features

- **inspector:** Surface collection & CRDT frames in the Control Center live feed ([72a4767])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## [control-center-v0.10.0] — 2026-07-09

### Features

- **control-center:** Collections view — schema panel + row browser ([acd0203])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])

## [control-center-v0.9.0] — 2026-07-04

### Features

- **control-center:** Filter/sort/paginate the store view ([7687bda])
- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])
- **control-center:** Brand lockup with status-EKG pulse mark ([5a10426])
- **control-center:** Export the live feed as JSON / JSONL / CSV ([b6fc329])

### Chores

- **control-center:** Release 0.8.0 ([0604e8d])

### Documentation

- Document server-side store filtering + the Control Center Stores view ([2405edc])
- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## [control-center-v0.7.0] — 2026-06-26

### Features

- **inspector:** Live-feed filters + size/latency magnitude bars ([b4211db])
- **inspector:** Live-feed columns via InspectorEnvelope ([5113c4a])
- **control-center:** Inspect Store values + ai-canvas docker stack ([ad60902])
- **inspector,control-center:** Store.* events + Store live-feed filter (slice 6) ([3667353])
- **control-center:** Attribute live-feed rows to their wire (Phase 3) ([2f8cb07])
- **control-center:** Surface transport as a first-class dimension (Phase 2) ([d2d17d1])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])

### Bug Fixes

- **inspector:** Address review — stable feed keys, pause-gated sort ([8fd4cba])

### Chores

- Bump versions for store-value inspection ([01b2d6c])
- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [control-center-v0.3.0] — 2026-06-22

### Features

- **control-center:** Filter + pause controls on the live feed (T3.4) ([ea7751b])
- **control-center:** Render message traffic in the live feed (T3.3) ([09fc087])
- **control-center:** Resources page linking docs/landing/repo (T5) ([4c8a42f])
- **control-center:** Move the connection into a Settings page (T4) ([6900cc2])
- **control-center:** Copy button on JSON blocks (T1.5) ([a234803])
- **control-center:** Humanize timestamps in the table + conn drawer (T1.4) ([75ea696])
- **control-center:** Resolve connection names in the live feed (T1.3) ([61fad70])
- **control-center:** Label nodes by friendly name (T1.2) ([e427125])
- **control-center:** Bin redirects bare root to the --url endpoint ([c337a80])
- **control-center:** Npx bin + docs + publish prep (control-center slice 9) ([0e4115c])
- **control-center:** Connections table + ctx drawer, contract explorer, live feed (control-center slice 8) ([0c82317])
- **control-center:** Topology graph — React Flow hub-and-spoke (control-center slice 7) ([bc69172])
- **control-center:** SPA scaffold + typed inspector client (control-center slice 6) ([268df6b])

### Bug Fixes

- Reconcile the inspector with serverToServer removal ([f92b456])

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

### Testing

- **inspector:** Cross-node message events over Redis + docs (T3.5) ([e68a5b7])


