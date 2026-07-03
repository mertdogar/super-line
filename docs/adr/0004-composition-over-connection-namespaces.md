# ADR-0004: Composition over connection namespaces (mux transport deferred)

- Status: Accepted
- Date: 2026-07-03

## Context

super-harness — a super-line-powered library — gets embedded into host apps (first: the designer project) that already run their own super-line server and client. The requirement: **one WebSocket in the browser**, driven by **shared identity** (the user authenticates once; both surfaces must agree on who's connected). The obvious ask, by Socket.IO precedent, was "add namespaces to super-line" — a `ns` field in every frame, core-routed.

Three candidates were walked:

1. **Core wire namespaces** (the Socket.IO way): an `ns` discriminator in every frame, routed in core.
2. **Mux transport** (`@super-line/transport-mux`): two fully independent SuperLine sessions multiplexed over one physical socket as logical "lines" — a new leaf transport package, zero core change.
3. **Composition**: one server, one client, one session — the embedded library exports its contract *pieces* and the host weaves them into its own contract.

The codebase itself argued against 1: the transport seam already declares it carries a *logical* connection and hides physical churn (`core/src/transport.ts`), so wire-level sharing belongs in a transport, not in core; contracts are plain object literals with `const`-preserved types, so composition is *native* — no codegen, no new type machinery beyond collision safety; and the term "namespace" is already taken by store names. Option 1 would touch every package to duplicate what the seam abstracts.

Option 2 was fully sketched and is genuinely viable — but it satisfies shared identity only **by convention** (two `authenticate` implementations reading the same token, forever), and its true cost surfaced under scrutiny: a channel open/close protocol, accept-all physical auth (a new unauthenticated-socket surface), doubled frame-level heartbeats, redial dedup under two independent client reconnect loops, head-of-line blocking between the stacks, and an unresolved Control Center routing story. ~350 lines plus permanent "which one do I want?" docs burden — for an isolation property the driving use case doesn't want.

## Decision

**Composition.** An embedded super-line library exports its surface; the host mounts it:

- Core ships two helpers (the *only* super-line change): **`defineSurface`** — authors an exportable `Directional` fragment with the same `const` literal preservation `defineContract` has (without it, a separately-declared fragment widens `subscribe: true` to `boolean` and topics silently degrade to events) — and **`mergeSurfaces`** — merges two fragments per direction, where a duplicate key is a **compile error naming the key** plus a runtime throw, never a silent spread-clobber.
- **Namespacing is a key-prefix convention, not a wire feature**: the embedded library hard-prefixes its request/event keys (`harness.join`), store names (`harness.thread`), and room names in its own source. The host owns roles, `authenticate`, `identify`, and middleware; the library's handlers/stores are spread into the host's `implement`/`stores` config; the library declares `@super-line/*` as peer dependencies.
- **The mux is deferred, not rejected** — its design is captured in `PLAN-transport-mux.md`, to be revived if a consumer ever needs two stacks that must *not* share identity/lifecycle (true third-party isolation). Composition forecloses nothing: the mux is purely additive later, and libraries accept injected transports anyway for standalone mode.

## Consequences

- **Shared identity holds by construction** — one handshake, one principal for ACLs/presence — which was the driving requirement. The trade: the host's middleware chain runs on the library's requests too (usually desired — it *is* the shared auth — but it is coupling), and the library shares the host's Control Center identity.
- **No wire change, no protocol bump.** Requests/events/topics/stores keep exactly their current frames; the "namespace" is invisible on the wire beyond key spelling.
- **Handler exhaustiveness protects the weave**: `Handlers` requires every merged key, so a host that forgets to spread the library's handlers gets a compile error, not a runtime 404.
- **Room names remain unenforceable** — runtime strings no helper can collision-check; prefixing them is convention and belongs in the embedding checklist of any library that composes.
- **Two truly independent stacks over one socket stay unserved** until someone needs it; that is the mux's revival criterion, and this ADR is where they'll find the pointer.
