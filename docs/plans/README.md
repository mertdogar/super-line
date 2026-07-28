# Design plans

Working documents from `/grilling` design sessions — the reasoning behind a
feature *before* it was built, kept because the decisions in them are still
load-bearing. They are **repo-internal**: excluded from the published site
(`srcExclude`), never cited from `docs/` prose, package READMEs, source
comments, or `skills/super-line/`. Cite an [ADR](../adr/) instead — those are
written to be read cold.

A plan is a snapshot of intent, not a description of the code. Where the two
disagree, **the code is right**. For what the system does today, read the
[docs](../), the [ADRs](../adr/README.md), or `CLAUDE.md`.

## The set

| Plan | Designed | Status |
|---|---|---|
| [`PLAN-plugins.md`](PLAN-plugins.md) | The plugin system — paired runtime bundles, taps, plugin-owned connections | Shipped ([ADR-0005](../adr/0005-plugins-as-paired-runtime-bundles.md)) |
| [`PLAN-collections.md`](PLAN-collections.md) | Typed row collections on the contract, the query IR, row-level security | Shipped ([ADR-0006](../adr/0006-collections-are-on-contract-typed-rows.md)) |
| [`PLAN-collections-crdt.md`](PLAN-collections-crdt.md) | Folding CRDT documents into collections; retiring the Store family | Shipped ([ADR-0007](../adr/0007-crdt-docs-are-typed-collections.md)) |
| [`PLAN-collections-typed-tables.md`](PLAN-collections-typed-tables.md) | Per-collection typed tables for the SQL backends, `planColumns` | Shipped ([ADR-0021](../adr/0021-column-layout-is-derived-from-standard-json-schema.md)) |
| [`PLAN-connection-context.md`](PLAN-connection-context.md) | Server-vended, client-visible per-connection `env` | Shipped ([ADR-0012](../adr/0012-connection-env-is-server-vended-client-visible-state.md)) |
| [`PLAN-plugin-auth.md`](PLAN-plugin-auth.md) | First-party authentication, and the contract-time half plugins grew for it | Shipped ([ADR-0019](../adr/0019-plugins-grow-a-contract-time-half.md)) |
| [`PLAN-auth-connection-sessions-presence.md`](PLAN-auth-connection-sessions-presence.md) | Durable sessions, data-driven roles, API keys, safe presence | Shipped |
| [`PLAN-plugin-auth-hooks.md`](PLAN-plugin-auth-hooks.md) | Before/after hooks over server-side auth operations | Shipped ([ADR-0017](../adr/0017-plugin-auth-hooks-cover-server-side-operations.md)) |
| [`PLAN-plugin-auth-server-minted-tokens.md`](PLAN-plugin-auth-server-minted-tokens.md) | Retiring client-side minting; `resolveToken`, `rejectUnauthenticated` | Shipped — **D5 superseded** by [ADR-0020](../adr/0020-auth-owns-the-client-so-it-owns-the-session-lifecycle-and-the-react-surface.md) |
| [`PLAN-plugin-auth-createauth-sealed-tokens.md`](PLAN-plugin-auth-createauth-sealed-tokens.md) | Signed vs. sealed bearer assertions, proposed by a downstream consumer | Partly shipped — sealed assertions landed ([ADR-0015](../adr/0015-bearer-assertions-are-signed-or-sealed.md)); its `createAuth` half was retired by [ADR-0020](../adr/0020-auth-owns-the-client-so-it-owns-the-session-lifecycle-and-the-react-surface.md) |
| [`PLAN-plugin-chat.md`](PLAN-plugin-chat.md) | The chat backbone — collections, requests-first mutations, domain hooks | Shipped ([ADR-0010](../adr/0010-plugin-domain-surfaces-are-requests-first-with-domain-hooks.md)) |
| [`PLAN-chat-streaming.md`](PLAN-chat-streaming.md) | Streamed messages as parts-rows plus ephemeral deltas | Shipped ([ADR-0011](../adr/0011-streamed-messages-are-parts-rows-plus-ephemeral-deltas.md)) |
| [`PLAN-chat-resources.md`](PLAN-chat-resources.md) | Channel-linked CRDT documents — the link registry, membership-gated access | Shipped |
| [`PLAN-chat-mastra.md`](PLAN-chat-mastra.md) | The Mastra bridge, per-channel turn serialization, bot provisioning | Shipped |
| [`PLAN-logtape.md`](PLAN-logtape.md) | Internal diagnostics through LogTape, configured by the app | Shipped ([ADR-0018](../adr/0018-logging-is-app-configured-not-per-instance.md)) |
| [`PLAN-live-feed.md`](PLAN-live-feed.md) | The Control Center live feed — filters, magnitude bars, export | Shipped |
| [`PLAN-transport-mux.md`](PLAN-transport-mux.md) | Two independent sessions multiplexed over one socket | **Deferred, never built** — composition answered the driving requirement ([ADR-0004](../adr/0004-composition-over-connection-namespaces.md)) |

## Deleted plans

Plans for the **Store family** (`PLAN-store-pglite`, `PLAN-store-sync-libsql`,
`PLAN-store-sync-pglite`) and its cross-repo handoff were removed when
[ADR-0007](../adr/0007-crdt-docs-are-typed-collections.md) retired the `store(n)`
API and deleted every `store-*` package. They are in git history if you need the
archaeology: `git log --diff-filter=D -- 'PLAN-store-*'`.
