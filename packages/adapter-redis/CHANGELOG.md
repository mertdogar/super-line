# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [adapter-redis-v0.5.1] — 2026-07-16

### Chores

- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])
- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])
- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [adapter-redis-v0.3.0] — 2026-06-22

### Features

- **inspector:** Friendly nodeName option surfaced through topology (T1.1) ([d2a6805])
- **server:** Remove serverToServer — the cluster bus subsumes it ([c9772c7])

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

### Documentation

- Document the cluster event bus; remove serverToServer references ([78bf3bf])

## [adapter-redis-v0.2.0] — 2026-06-15

### Features

- **adapter-redis:** Redis presence store with alive-TTL + graceful cleanup (slice 4) ([1041c1c])

### Documentation

- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## [adapter-redis-v0.1.0] — 2026-06-15

### Features

- Redis pub/sub adapter + cross-process testcontainers tests ([8e281d4])

### Chores

- Add repository/homepage/bugs metadata (origin known) ([fef6c22])
- Scaffold pnpm workspace + req/res vertical slice ([3513dc8])

### Documentation

- **tsdoc:** Document the public API for the generated reference (slice 3) ([36536a8])
- **site:** Generate API reference from source via TypeDoc (slice 2) ([f5683ee])
- README overhaul (hero, TOC, guides, comparison) + MIT LICENSE + package metadata ([d3bb349])


