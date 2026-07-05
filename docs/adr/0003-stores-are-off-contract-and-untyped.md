# ADR-0003: Stores are off-contract and untyped, outside the typed-contract spine

- Status: Accepted — narrowed to CRDT doc stores by [ADR-0006](0006-collections-are-on-contract-typed-rows.md) (2026-07-05)
- Date: 2026-06-23

## Context

super-line's defining identity is *"one contract, end-to-end types, no codegen; the server validates every inbound message."* Requests, events, and topics are all declared in `defineContract`, typed end to end, and schema-validated on the wire.

The new [[Store]] primitive (see `CONTEXT.md`) could have followed the same path: declare named stores in the contract, give each a `data` schema, and generate typed, validated read/write methods. We chose **not** to. A future reader will reasonably ask why this one primitive breaks the house rule — hence this ADR.

Two forces pushed off-contract:

1. **The Store is configured like a transport/adapter, not declared like a message.** A [[Store pair (server half / client half)]] is a runtime capability (memory / Redis / CRDT), chosen at `createSuperLineServer` / `createSuperLineClient` time. Its data shapes are an application concern that varies per Resource id at runtime, not a fixed per-message schema.
2. **CRDT stores make contract validation impossible *in principle*, not just inconvenient.** The symmetric [[Change]] carries an opaque `update` — for a `CrdtStore` that is a **binary merge delta**. You cannot validate a binary CRDT op against a JSON schema: it isn't the value, it's an instruction to mutate the value, and it may not even be applicable until merged. So even if we declared a `data` schema, the inbound `update` path could never honor it for the CRDT case — the exact case the Store exists to serve.

## Decision

Stores are **off-contract and untyped at the wire**:

- Stores are configured as runtime options (the server/client pairs), **not declared in `defineContract`**.
- The generic store surface (`client.store.<name>.read/write/subscribe/open`) treats `data` as **caller-asserted** (`unknown` on the wire).
- **Core does not schema-validate store `data`** — there is no contract schema for it, and CRDT `update` deltas are unvalidatable by construction.

## Consequences

- **Store data loses super-line's two headline guarantees** — end-to-end types and "validate every inbound message." Callers assert `data` types themselves (`read<T>`); a buggy or malicious client can write malformed `data` and core won't reject it at the wire. Per-store integrity is the Store implementation's and the application's responsibility.
- **Hard gates must still route through typed requests.** Anything needing a real, preventive check (money, permissions, invariants) goes through a normal contract request — the same guidance `docs/guide/synced-state.md` already gives for CRDT state, and consistent with [[Access control (accessRules)]] being enforced server-side in request-handler code.
- **The typed-contract spine is unchanged for requests/events/topics.** This ADR scopes the exception to store *data*; everything else keeps full typing + validation. ACL enforcement, fan-out, and the `store.*` inspector events are still core-owned.
- **A typed-store option is not foreclosed for LWW stores.** A future contract-declared, schema-validated store could be added for last-writer-wins stores (where `update` *is* the value and so *is* validatable) — but it could never extend to CRDT deltas, so it would be an opt-in addition, not the default.
- **DX is that of a generic store client** (think a permissioned, real-time KV/document client) rather than a typed RPC surface — the deliberate trade chosen for maximum flexibility and CRDT compatibility.
