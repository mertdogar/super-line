# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [tanstack-db-v0.2.1] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])
- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [tanstack-db-v0.2.0] — 2026-07-18

### Bug Fixes

- **deps:** Core (and client) become peerDependencies in plugin-inspector, plugin-auth, tanstack-db ([f2a5cd5])

## [tanstack-db-v0.1.1] — 2026-07-09

### Features

- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])
- **collections:** TanStack DB adapter + react useCollection ([c43c1ee])

### Bug Fixes

- **tanstack-db:** Guard the sync engine against cancellation before ready ([670c47b])


