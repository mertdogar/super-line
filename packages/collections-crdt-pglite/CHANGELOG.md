# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [collections-crdt-pglite-v0.2.0] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])
- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [collections-crdt-pglite-v0.1.3] — 2026-07-18

### Bug Fixes

- **collections-pglite:** Quote the Electric shape table param — camelCase collections 400'd at boot ([22a646f])

## [collections-crdt-pglite-v0.1.1] — 2026-07-16

### Features

- **collections:** CRDT self-clustering tier — collections-crdt-pglite (Phase 2) ([2f32b8c])

### Bug Fixes

- **collections:** Guard the pglite op-log feed against partial-column re-sync rows ([d0acf92])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])


