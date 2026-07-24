# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [adapter-libp2p-v0.9.0] — 2026-07-24

### Features

- **adapter-libp2p:** LogTape diagnostics for the gossipsub mesh ([38f7f14])

## [adapter-libp2p-v0.8.0] — 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

## [adapter-libp2p-v0.7.0] — 2026-07-20

### Features

- **adapter-libp2p:** Add Kubernetes DNS discovery ([4ea1b83])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

## [adapter-libp2p-v0.6.1] — 2026-07-16

### Features

- **adapter-libp2p:** One `discovery` knob + createRelayNode ([70ebdae])

### Chores

- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])
- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [adapter-libp2p-v0.3.0] — 2026-06-22

### Features

- **adapter-libp2p:** Node ownership, identity & transport config (slice 5) ([1b8fc36])
- **adapter-libp2p:** Gossip-replicated presence directory (slice 3) ([a8d2ab1])
- **adapter-libp2p:** Core gossipsub fan-out on one shared topic (slice 1) ([1280d2a])

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

### Testing

- **adapter-libp2p:** Presence liveness, queries + clearNode through the server (slice 4) ([d02285d])

### Documentation

- **adapter-libp2p:** Scaling-libp2p example, README, typedoc + guide (slice 6) ([df262ae])


