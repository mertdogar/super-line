# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [react-v0.10.0] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])

## [react-v0.9.1] — 2026-07-20

### Bug Fixes

- **react:** Read collections/docs through useSyncExternalStore, guard stale responses ([fb68c72])
- **react,control-center,examples:** Render-purity + explicit button types ([a07e688])

## [react-v0.9.0] — 2026-07-17

### Features

- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])

## [react-v0.8.1] — 2026-07-16

### Documentation

- **diataxis:** Restructure guide into quadrants + flagship Collections ([036b4f7])

## [react-v0.8.0] — 2026-07-09

### Features

- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])

## [react-v0.7.1] — 2026-07-06

### Features

- **collections:** TanStack DB adapter + react useCollection ([c43c1ee])

### Documentation

- Adopt realtime-data-bus positioning; document stores, transports & deletion fan-out ([9d8f5d0])

## [react-v0.7.0] — 2026-06-29

### Features

- **store:** Cluster-wide deletion fan-out (sdel) across relay stores ([2c8a46f])
- **store:** Server-side reactive co-writer (ServerStore.open) + client delete(path) ([bda00a5])
- **react:** UseResource hook (slice 7) ([d2f0f12])
- **transport:** Extract WebSocket behind a pluggable client↔server transport seam ([0111f06])

### Chores

- Bump all packages to 0.5.0 for release ([7b9d027])
- Release v0.4.0 ([e80b6d0])

### Documentation

- Migrate guides, READMEs, and skills to the pluggable-transport API ([1777e73])

## [react-v0.3.0] — 2026-06-22

### Refactor

- Rename Socket* API to SuperLine* brand language ([a2da0ad])

## [react-v0.2.0] — 2026-06-15

### Documentation

- **release:** Per-package READMEs + LICENSE files (slice 2) ([6db73c4])

## [react-v0.1.0] — 2026-06-15

### Features

- **react:** Thread role through hooks (slice 7) ([aeaebef])
- @super-line/react hooks + runnable chat example ([0381267])

### Chores

- Add repository/homepage/bugs metadata (origin known) ([fef6c22])
- Scaffold pnpm workspace + req/res vertical slice ([3513dc8])

### Documentation

- **tsdoc:** Document the public API for the generated reference (slice 3) ([36536a8])
- **site:** Generate API reference from source via TypeDoc (slice 2) ([f5683ee])
- README overhaul (hero, TOC, guides, comparison) + MIT LICENSE + package metadata ([d3bb349])


