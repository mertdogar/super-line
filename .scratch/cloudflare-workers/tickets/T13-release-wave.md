---
id: T13
title: Release wave
labels: [wayfinder:task]
status: closed
assignee: session_01CAGnLSs3WJLSaww41tSX5T (2026-10-15)
blocked-by: [T12, T16]
---

## Question

Stage the release: versions for every touched package (core/server for the seam and timer option; the plugins ported; the three new packages at 0.1.0), peer ranges, `chore(release)` + tags + root aggregate after tagging, `check-manifest` + `check-changelog` settle, full suite green across all three lanes. Publish/push is the user's call — ASK.

> From T07: raise `@super-line/transport-cloudflare`'s core peer floor from `>=0.20.0` to the core minor that ships `adoptConnection`/`onSnapshotChanged` (and do the same for any other package that starts depending on them).

> From T09: `@super-line/collections-sqlite` changed source (SQL layer extracted to `src/sql.ts`, behavior unchanged) → patch release. `@super-line/collections-cloudflare` 0.1.0 peers core `>=0.17.0`.

> From T11: `plugin-inspector` changed source (watcher keepalive runs only while watched) → patch release. `examples/cloudflare` is private (no release).

> From T16: `server` gains `PluginContext.ready` (feature → in the server minor already owed). `plugin-auth` changed source (boot sweep awaits `ctx.ready` and spares live connections; close stamps `lastSeenAt`) → release, (its server peer floor can stay: `await ctx.ready` is `await undefined` on an older server, which behaves exactly as before). `plugin-chat` changed source (`presenceTimeoutMs: Infinity` allowed) → patch. `transport-cloudflare`'s public `resume()` is gone (never published) — nothing to deprecate.

## Resolution

**STAGED** (2026-10-15), local main only — push and publish are the user's call.

- Released: core 0.21.0 · server 0.22.0 · client 0.17.0 · plugin-chat 0.12.0 · plugin-auth 0.10.1 · plugin-inspector 0.5.1 · collections-sqlite 0.4.1 · transport-cloudflare 0.1.0 · collections-cloudflare 0.1.0 · collections-crdt-cloudflare 0.1.0. One `chore(release)` commit, ten lightweight `<pkg>-v<ver>` tags on it, then `docs(changelog)` for the root aggregate.
- Peer floors raised only where a package now needs a newer sibling: plugin-chat → server ≥0.22.0 (calls `hold()` unconditionally); transport-cloudflare → core ≥0.21.0 + server ≥0.22.0 (new `server` devDependency mirror; against an older server it would close every socket on each wake and never hibernate). plugin-auth's floor stays (`await ctx.ready` on an older server is `await undefined`).
- Left out on purpose: packages whose only changes since their last tag are tests or READMEs (tarball unchanged) — they pick those entries up at their next real release. `devtools-extension` (private, GitHub-zip distribution) has a small `end`-frame label change pending → its own release, by hand.
- Green: `check-changelog` for all ten, `check-manifest` across 28 published manifests, `pnpm build`, typecheck, lint, fast 857/857, workers 71/71; integration 158 (6 skipped) on the same source.
- **Pushed and published** by the user, 2026-10-15: main + the ten tags, then all ten packages (each verified on npm with `npm view`).
