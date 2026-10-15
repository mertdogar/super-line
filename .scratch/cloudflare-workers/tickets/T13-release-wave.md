---
id: T13
title: Release wave
labels: [wayfinder:task]
status: open
assignee:
blocked-by: [T12, T16]
---

## Question

Stage the release: versions for every touched package (core/server for the seam and timer option; the plugins ported; the three new packages at 0.1.0), peer ranges, `chore(release)` + tags + root aggregate after tagging, `check-manifest` + `check-changelog` settle, full suite green across all three lanes. Publish/push is the user's call — ASK.

> From T07: raise `@super-line/transport-cloudflare`'s core peer floor from `>=0.20.0` to the core minor that ships `adoptConnection`/`onSnapshotChanged` (and do the same for any other package that starts depending on them).

> From T09: `@super-line/collections-sqlite` changed source (SQL layer extracted to `src/sql.ts`, behavior unchanged) → patch release. `@super-line/collections-cloudflare` 0.1.0 peers core `>=0.17.0`.

> From T11: `plugin-inspector` changed source (watcher keepalive runs only while watched) → patch release. `examples/cloudflare` is private (no release).

> From T16: `server` gains `PluginContext.ready` (feature → in the server minor already owed). `plugin-auth` changed source (boot sweep awaits `ctx.ready` and spares live connections; close stamps `lastSeenAt`) → release, and its `@super-line/server` peer floor must rise to the server minor that ships `PluginContext.ready` (it reads it unconditionally). `plugin-chat` changed source (`presenceTimeoutMs: Infinity` allowed) → patch. `transport-cloudflare`'s public `resume()` is gone (never published) — nothing to deprecate.
