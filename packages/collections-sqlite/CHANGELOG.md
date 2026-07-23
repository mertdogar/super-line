# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [collections-sqlite-v0.3.0] — 2026-07-23

### Features

- **release:** Generate per-package changelogs from the commit history ([82a2232])

### Bug Fixes

- **deps:** Internal packages peer on their siblings instead of depending on them ([00375f6])

### Documentation

- **changelog:** Refresh the root aggregate and the per-package backlog ([1b17da1])
- Repo-wide refresh — counts, ctx policies, env propagation, front door, positioning ([13dd524])

## [collections-sqlite-v0.2.0] — 2026-07-17

### Features

- **collections-sqlite:** Typed per-collection tables (col_<name>) replace the generic row table ([eea2111])

## [collections-sqlite-v0.1.2] — 2026-07-16

### Refactor

- **core:** Discriminate CollectionStore on clustering (ADR-0009) ([bfda9f4])

### Testing

- **collections:** Specify the CollectionStore seam in tests, not prose ([c1cb594])

## [collections-sqlite-v0.1.1] — 2026-07-13

### Features

- **control-center:** Show per-row created/updated in Collections view ([a982431])
- **collections:** Durable SQLite backend with IR→SQL snapshot pushdown ([1c29230])


