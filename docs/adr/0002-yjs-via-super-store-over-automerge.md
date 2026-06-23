# ADR-0002: Use Yjs (via super-store) as the CRDT binding, superseding Automerge

- Status: Accepted
- Date: 2026-06-23
- Supersedes: [ADR-0001](./0001-automerge-over-yjs-for-synced-scene-state.md)

## Context

ADR-0001 chose **Automerge (3.x)** as super-line's first CRDT binding for the OMMA Scene, primarily for its plain-JSON `change(doc, fn)` ergonomics, and accepted Automerge's Rust→WASM weight (hundreds of KB + async init + cold-start) as the main downside.

Since then the CRDT engine was actually built — as a **separate library, `super-store`** (`@super-store/store`, at `/Users/mertdogar/Workspace/personal/super-store`) — and it is built on **Yjs**, not Automerge. `super-store` exposes a single reactive primitive, `StoreValue<T>`, that presents a **plain-object API over Yjs shared types**: plain objects → `Y.Map`, arrays → `Y.Array`, `Set`/`Map` → tagged `Y.Map`, with diff-and-patch writes inside one transaction, `observeDeep`-driven reactivity, and opt-in undo. It is the [[Store]]'s eventual `CrdtStore` engine: super-line `Store` → `CrdtStore` impl → `super-store StoreValue`.

This contradicts ADR-0001, and the contradiction resolves *against* Automerge once `super-store` exists.

## Decision

Use **Yjs, via `super-store`**, as the CRDT engine behind super-line's first `CrdtStore` implementation. Mark ADR-0001 **Superseded**.

Rationale:
1. **The plain-JSON argument that favored Automerge is neutralized.** ADR-0001's decisive point was that Automerge merges plain objects for free while "Yjs requires explicitly constructed shared types (or a third-party plain-object layer like `syncedStore`)." `super-store` *is* that plain-object layer — already written, tested, and production-shaped — so Yjs now offers the same plain-object ergonomics that tipped the original decision.
2. **Yjs avoids ADR-0001's main accepted downside.** Yjs is ~18 kB of pure JS with no WASM core, async init, or cold-start penalty — directly removing the cost ADR-0001 flagged as its primary consequence (relevant for browser bundle size and serverless/edge cold-start).
3. **It reflects reality.** The engine is built. Keeping ADR-0001 Accepted would document a decision the codebase has already moved past.
4. **The Store layer stays CRDT-agnostic regardless.** super-line relays opaque [[Change]] bytes (see ADR-0003 / `docs/guide/synced-state.md`); the binding choice lives entirely inside the `CrdtStore` implementation, so an Automerge-backed `CrdtStore` remains possible later without touching core. This decision is about the *first* binding, not an exclusive one.

## Consequences

- **The z-order / movable-list problem is unchanged.** ADR-0001 noted neither library ships a usable native list-move; that remains true for Yjs. Keep modelling order as a **keyed map + per-element fractional `order` string** (library-agnostic), exactly as ADR-0001's consequences prescribed.
- **Per-actor attribution** comes from Yjs transaction origins / `clientID` rather than Automerge `actorId`; this is the CRDT-internal actor, distinct from super-line's [[Origin (writer id)]] and [[Principal (the ACL identity)]].
- **Persist via Yjs binary** (`Y.encodeStateAsUpdate` / incremental updates), not a JSON round-trip — same principle as ADR-0001 (preserve history/attribution; JSON snapshots are a read-model, not the store of record).
- **super-store is a pre-1.0, private dependency** (`@super-store/store@0.1.0`). Its surface (and its documented "minor tweaks" vs the in-memory store — async fill-in, no-op on structurally-equal `set`, in-place mutation desyncs) becomes part of the `CrdtStore`'s contract. Pin and track it.
- **A future Automerge `CrdtStore` is not foreclosed** — it would be an additional Store implementation, decided on its own merits if a use case (e.g. very large docs, native movable list via Loro/Automerge) demands it.
