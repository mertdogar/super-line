# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [collections-pglite-v0.3.0] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])
- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [collections-pglite-v0.2.1] — 2026-07-18

### Bug Fixes

- **collections-pglite:** Quote the Electric shape table param — camelCase collections 400'd at boot ([22a646f])

## [collections-pglite-v0.2.0] — 2026-07-17

### Features

- **collections-pglite:** Typed per-collection tables over N Electric shapes (Phase 2b) ([a2431d9])

### Testing

- **collections-pglite:** Real-Electric integration harness for LWW rows (Phase 2a) ([d209f62])

## [collections-pglite-v0.1.3] — 2026-07-16

### Refactor

- **core:** Discriminate CollectionStore on clustering (ADR-0009) ([bfda9f4])

### Testing

- **collections:** Specify the CollectionStore seam in tests, not prose ([c1cb594])

## [collections-pglite-v0.1.2] — 2026-07-13

### Features

- **control-center:** Show per-row created/updated in Collections view ([a982431])

## [collections-pglite-v0.1.1] — 2026-07-09

### Features

- **collections:** Self-clustering pglite backend + prev-less delete routing ([e252c3b])

### Refactor

- **core:** Retire the store(n) API + delete the store packages (ADR-0007 Phase 3b) ([1693697])


