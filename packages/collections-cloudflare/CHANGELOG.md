# Changelog

Generated from conventional commits by [git-cliff](https://git-cliff.org) —
run `pnpm changelog` rather than editing by hand.

## [collections-cloudflare-v0.3.2] — 2026-10-23

### Bug Fixes

- **collections-sqlite:** A new nullable JSON field backfills old rows with null ([9210f96])

## [collections-cloudflare-v0.3.1] — 2026-10-22

### Bug Fixes

- **collections-sqlite:** A dot path through an array no longer drops matching rows ([344e41b])

## [collections-cloudflare-v0.3.0] — 2026-10-22

### Features

- **collections-cloudflare:** CountBy runs as one GROUP BY in the object's SQLite ([ec7b2b9])
- **collections-sqlite:** CountBy runs as one GROUP BY ([4942b28])
- **collections-cloudflare:** Count, and text order, like and has run in the object's SQLite ([73dd870])
- **collections-sqlite:** Text order, text ranges, like, ilike and has run in SQL; count ([e96cbc7])
- **collections-cloudflare:** A remote rows snapshot may span every table of a store ([f26cc95])

## [collections-cloudflare-v0.2.0] — 2026-10-20

### Features

- **collections-cloudflare:** A foreign object's SQLite as a live collection ([a9579af])

### Bug Fixes

- **collections-cloudflare:** ReadOnly catches writes in every statement ([e391e8e])

## [collections-cloudflare-v0.1.0] — 2026-10-15

### Features

- **collections-cloudflare:** Row collections on Durable Object SQLite ([6b1f3eb])

### Refactor

- **collections-sqlite:** Extract the engine-free SQL layer to src/sql.ts ([e13ddbe])

### Documentation

- Teach hosting a node on Cloudflare Durable Objects ([a893f83])


