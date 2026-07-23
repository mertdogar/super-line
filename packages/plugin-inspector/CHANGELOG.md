# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [plugin-inspector-v0.3.2] — 2026-07-23

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

## [plugin-inspector-v0.3.1] — 2026-07-23

### Features

- **core:** Report plugin provenance on getContract (ADR-0016) ([fd6270e])
- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Documentation

- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [plugin-inspector-v0.3.0] — 2026-07-18

### Bug Fixes

- **deps:** Core (and client) become peerDependencies in plugin-inspector, plugin-auth, tanstack-db ([f2a5cd5])

## [plugin-inspector-v0.2.4] — 2026-07-17

### Features

- **env:** Server-vended, client-visible per-connection state (ADR-0012) ([1e43152])

## [plugin-inspector-v0.2.2] — 2026-07-13

### Features

- **control-center:** Filter collections by created/updated timestamps ([03aeaa9])
- **control-center:** Filter and sort the Collections view ([708c066])
- **control-center:** Show per-row created/updated in Collections view ([a982431])

## [plugin-inspector-v0.2.1] — 2026-07-13

### Features

- **inspector:** Surface collection & CRDT frames in the Control Center live feed ([72a4767])

## [plugin-inspector-v0.2.0] — 2026-07-09

### Features

- **collections:** CRDT documents as typed, validated collections (ADR-0007) ([a9c2eb6])
- **collections:** Inspector introspection surface (schema graph + row browsing) ([9651940])
- **plugin-inspector:** Serve filtered listResources + searchPrincipals ([498a229])
- **plugins:** Plugin system + inspector-as-plugin (ADR-0005) ([4d89b89])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])


