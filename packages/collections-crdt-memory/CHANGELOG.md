# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [collections-crdt-memory-v0.2.0] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])
- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [collections-crdt-memory-v0.1.3] — 2026-07-17

### Features

- **core,server,client:** CRDT seams for channel resources — plugin CRDT policies + per-open origin ([b1a7445])

## [collections-crdt-memory-v0.1.1] — 2026-07-16

### Features

- **collections:** Reject→resync for CRDT documents (Phase 1.5) ([1695584])
- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])

### Bug Fixes

- **collections:** Reject→resync rebuilds the CRDT replica from authoritative state ([630ca22])

### Testing

- **crdt:** Pin removeAtPath's merge behaviour — and retract a false finding ([43770ea])
- **collections:** Specify the CollectionStore seam in tests, not prose ([c1cb594])


