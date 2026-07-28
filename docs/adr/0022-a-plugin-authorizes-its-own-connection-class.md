# ADR-0022: A plugin authorizes admission to its own connection class

- Status: Accepted
- Date: 2026-07-28
- Amends: [ADR-0005](0005-plugins-as-paired-runtime-bundles.md) (phase 2, which introduced plugin-owned connection classes as unconditionally admitted)

## Context

ADR-0005 phase 2 gave a plugin its own **connection class**: a reserved role the transport
negotiates, dispatched against the plugin's own fixed contract rather than the host's. The
Control Center's channel is the only instance today. To make that work, the transport
**short-circuits `authenticate`** for a matching connection — it has to, because the host's
`authenticate` resolves *contract* roles and the reserved role is deliberately not one of them.

The consequence was never authorization, only admission: anyone able to open a socket to the
application port and offer the `superline.inspector.v1` subprotocol was accepted with an empty
ctx and served the full `InspectorContract`. That is the whole system — the contract, cluster
topology, every connection's `ctx`/`data`/`env`, the live `msg.*` feed with payloads, and every
collection's rows with row policies **deliberately bypassed** ("the inspector is a trusted
observer"). The documented mitigation was a sentence: *"The inspector channel is unauthenticated
in v1. Never mount `inspector()` on an internet-facing production node."* A total-read backdoor
guarded by a doc comment is not a boundary.

The natural-looking fixes do not work. `onConnection` never fires for a reserved connection
(`acceptConn` returns early — reserved connections are observer-invisible by design); even if it
did, the handshake is discarded at accept, so there is nothing to check; and a lifecycle hook is
error-isolated, so it could not reject. Middleware is never consulted either — reserved frames
dispatch straight to the plugin's handlers. An in-band `login` request would need a change to
`InspectorContract` in core *and* a new gate on the subscribe path, which bypasses plugin
handlers entirely — more surface than the handshake route, for a weaker property.

## Decision

**A plugin connection class authorizes its own admission, at the handshake.**

`ReservedConnection` / `PluginConnection` gain an optional
`authenticate(handshake) => Awaitable<unknown>`. A transport that supports reserved classes calls
it before accepting; the resolved value becomes the connection's `ctx` (replacing the hardcoded
`{}`), and a **throw rejects**. Absent the hook, admission is unconditional exactly as before, so
nothing existing changes behaviour.

Three things this deliberately does *not* do:

- **It does not return a role.** Full `AuthOutcome` parity was the obvious symmetry and is
  rejected: `acceptConn` derives `isReserved` from the role, so a hook that could restate it could
  name a *host* role — producing a connection that joins `conns`, gains presence and lifecycle
  hooks, and dispatches against the host's contract, with the host's `authenticate` never having
  run. A plugin could mint an `admin` connection from nothing. The role is fixed at declaration
  and validated against contract roles at construction; the hook has no reason to restate it.
  (`env` is inert for reserved connections and `transport` is server-injected, so the remaining
  parity is `ctx` — which the hook returns — and `connectionId`, which nothing needs yet.)
- **It does not reject the upgrade.** A WebSocket refused at the handshake reaches a browser as a
  bare code 1006, indistinguishable from an unreachable host — and the Control Center reconnects
  every second, so a typo becomes a silent infinite retry. The transport therefore **completes the
  upgrade and immediately closes with 4401** and the thrown message as the reason, without ever
  calling `onConnection`. Core never sees the socket; the client gets a signal it can act on.
- **It does not put an identity system in the inspector.** `inspector({ auth })` takes a literal
  `{ username, password }` (timing-safe compare, `SUPER_LINE_INSPECTOR_USER` /
  `SUPER_LINE_INSPECTOR_PASSWORD` as the fallback, user defaulting to `admin`) **or** a predicate
  over the handshake. Requiring `@super-line/plugin-auth` was considered and rejected: it would
  bring real users, hashed storage and revocation, but it hard-requires a collections backend and
  a stable `nodeKey`, and nine of the eleven examples that mount `inspector()` are bare servers
  with neither. The predicate is the seam for hosts that *do* run plugin-auth, at no dependency
  cost. Unconfigured, the inspector stays open and warns via LogTape — a breaking secure-by-default
  would need an explicit opt-out added to every existing call site.

## Consequences

The credential rides `handshake.query`, which is the house idiom (`role`, `token`, `apiKey`, `jwt`
all do) — but unlike plugin-auth, what rides it is the **password itself**, not a token exchanged
for one. plugin-auth splits login into a `signIn` *request* precisely so a password never touches
a handshake. The inspector accepts that divergence knowingly: a single fixed admin secret makes a
token an equally-powerful replayable credential rather than a safer one, and the two-phase shape
costs the in-band mechanism rejected above. The residual risk is real and belongs in the docs — a
fronting reverse proxy logs query strings, and the Control Center re-dials every second.

`clustering` aside, the hook is per-node: every node mounting `inspector()` needs the credential
configured, since the Control Center attaches to one node at a time.
