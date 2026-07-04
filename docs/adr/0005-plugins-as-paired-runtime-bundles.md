# ADR-0005: Plugins as paired runtime bundles

- Status: Accepted
- Date: 2026-07-04

## Context

Two audiences want to extend super-line beyond the four pluggable seams
(transport, adapter, store, serializer). App operators need cross-cutting
observability — metrics, tracing, audit — and today their only path is forking
the inspector. Library authors embedding super-line features (first:
super-harness) have the ADR-0004 composition story, but it requires manually
weaving surface + handlers + stores + middleware + lifecycle across 4–5 config
sites, and the server's lifecycle options (`onConnection`/`onDisconnect`/
`onError`) are singular — two independent concerns cannot both register one
without hand-composition.

The inspector is the canonical evidence: a complete cross-cutting "plugin"
(connect/disconnect, room/topic, `msg.*`, `store.*` taxonomy, cluster fan-out,
redaction) hand-woven as ~25 inline call sites through the server core because
no extension mechanism exists. The client has no lifecycle hooks at all — a
reconnect is unobservable.

Alternatives walked:

1. **Observer taps only** — cheapest, but no packaging story for libraries.
2. **Middleware everywhere** (outbound interception, client `use`) — rejected:
   collides with the encode-once fan-out perf idiom and the echo-break/dedup
   invariants, and global middleware is necessarily unknown-typed.
3. **Imperative `setup(ctx)`-only plugins** (Fastify-style) — rejected:
   contributions become statically opaque, so compile-time handler
   exhaustiveness (a documented ADR-0004 consequence) would regress to a
   runtime check.
4. **Do nothing / targeted gap-fills** — leaves the inspector fork-only and
   library mounting manual.

A hard type constraint shaped everything: end-to-end types hang off the
contract object known at `defineContract` time, so a plugin passed to the
server factory can never retroactively add typed surface — contract
contribution must stay at the `mergeSurfaces` site.

## Decision

One unified **`SuperLinePlugin`**: a named, declarative bundle of runtime
contributions, registered as `plugins: [...]` on both factories, shipping as a
**pair** (server half, optional client half) exactly like transports and
stores.

- **Runtime-only by constraint.** A library ships a plugin paired with its
  Surface (ADR-0004); the host still merges the surface explicitly. The
  pairing is typed: `SuperLinePlugin<typeof surface>` — plugin handlers
  compile against the same fragment, and plugin-covered keys are **subtracted
  from `srv.implement()`'s obligation at compile time**. Forgetting the
  plugin, or double-implementing its keys, stays a compile error (the
  mergeSurfaces discipline extended).
- **Declarative fields, all optional**: tap `onEvent`, `use` middleware,
  lifecycle hooks (now multiplexed across host + plugins), `handlers` (a
  factory receiving `PluginContext`), `stores`, plus an imperative
  `setup(ctx)` escape hatch returning an optional dispose.
- **The tap is node-local**: fired synchronously at the emit site with live
  payload references (observer must not mutate), reusing the InspectorEvent
  taxonomy; zero cost when no plugin taps. Cluster-wide views are *built by
  plugins* from local taps + adapter access — the inspector's own pattern —
  not provided by the tap.
- **`PluginContext`** = the server's public capabilities minus footguns (no
  `implement`, no `close`), plus a privileged block sized to the inspector's
  audited needs: adapter channels under a plugin-reserved prefix, node
  identity, serializer, read-only conns/presence, contract reflection.
- **Interception is out of scope**: plugins observe and contribute new
  operations; they never transform or veto in-flight traffic.
- **Acceptance test: the inspector + Control Center must be expressible as a
  plugin.** Phase 1: taps + bundles + context, with the inspector rewired as
  the tap's first internal consumer (wire format and CC untouched). Phase 2:
  plugin-owned connections generalized (reserved role + subprotocol), the
  inspector extracted to `@super-line/plugin-inspector`, `inspector: true`
  remaining as sugar.

Collisions (plugin names, store names, handler keys) are compile errors where
the type system can reach and startup throws naming the key elsewhere — never
silent. Taps and lifecycle hooks are error-isolated per listener and routed to
`onError`; a throwing middleware keeps its existing meaning (reject the
operation). Roadmap: `PLAN-plugins.md` at the repo root.

## Consequences

- The singular-hook collision dissolves; any number of concerns can observe
  connections, disconnects, and errors.
- The client grows its first connection-lifecycle callbacks
  (`onConnect`/`onDisconnect`/`onReconnect`) via the client plugin half; the
  React package needs no changes (it rides the client's public surface).
- The InspectorEvent taxonomy becomes public API — its shapes gain a stability
  contract they didn't have as inspector internals.
- Compile-time subtraction is real generics machinery; inference fragility is
  the accepted implementation risk. Mitigation: the runtime completeness
  throw ships regardless, so a fallback weakens DX, never correctness.
- The zero-cost-when-silent posture must hold: no tap consumers → one boolean
  branch, no snapshotting, no envelope encode.
- Plugin-owned connections (the Control Center attach story) are deferred to
  phase 2 with the constraint recorded now; until then the inspector's
  connection handling stays hardcoded, and `@super-line/plugin-*` is the
  reserved package naming convention.
