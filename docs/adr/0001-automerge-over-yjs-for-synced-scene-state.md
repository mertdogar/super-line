# ADR-0001: Use Automerge (not Yjs) as the CRDT for synced state

- Status: **Superseded by [ADR-0002](./0002-yjs-via-super-store-over-automerge.md)** (2026-06-23)
- Date: 2026-06-23

> **Superseded.** The CRDT engine was subsequently built as `super-store` on **Yjs**, which provides the plain-object ergonomics that tipped this decision toward Automerge — and avoids the WASM cost this ADR accepted. See ADR-0002. The z-order / fractional-index modelling below still stands (library-agnostic).

## Context

super-line is gaining a synced-JSON-state primitive (a **Shared Document** — see CONTEXT.md). The driving use case is the OMMA designer: **N humans + N AI agents** co-editing a **Scene** (a plain-JSON design document), with the **server as a co-writer** and server-side persistence required. Authority is **reactive** (post-merge compensation), not preventive — acceptable because a design canvas tolerates minor conflict loss.

Candidates evaluated against current docs: **Yjs** (the initial preference), **Automerge** (3.x), and **Loro** (mentioned as a fallback).

Relevant facts about the state and writers:
- The Scene is plain JSON: a collection of elements (each with a stable `id`), nested containers, structured props (numbers/enums/colors), and **plain-string** labels — essentially **no collaborative rich text**.
- The AI agents *generate* structured granular mutations (`create`/`update`/`delete`/`reorder`).
- The client scene is owned by an imperative renderer (`SkiaScene`), driven by a change-stream.
- A prior, production-shaped Automerge `SceneDocStore` (server-authoritative hub, per-peer sync state, base64-over-JSON-WS, schema re-validation, an explicit "agent runs server-side / phase 5" TODO) already existed in `tomorrow-kits` and was **removed for priorities — not a technical blocker**.

## Decision

Use **Automerge (3.x)** as the CRDT for the OMMA Scene sync, and as the **first CRDT binding super-line ships**.

Rationale:
1. **Plain-JSON fit.** `change(doc, fn)` mutates plain objects/arrays with per-field merge for free — the lowest-friction model for agents emitting structured ops, and a 1:1 match for `SceneSource`. Yjs requires explicitly constructed shared types (or a third-party plain-object layer like `syncedStore`).
2. **Server-as-co-writer is first-class.** The server mutates with the same `change()` API, and `receiveSyncMessage` returns **path-addressed patches** (`{action, path, value}`) that drive reactive validation/compensation cleanly. `actorId` gives AI-vs-human attribution at the writer level. Yjs can do this via `observeDeep` + transaction origins, but with more wiring (echo-loop management).
3. **Yjs's strengths go unused here.** `Y.Text` (no rich text) and the provider ecosystem (own transport) don't pay off; meanwhile its costs (shared-type ceremony) are paid in full.
4. **Prior art.** A serious Automerge architecture already existed and was dropped only for priorities.

The **move/reorder weakness is a wash** and did not influence the choice: neither library ships a usable native list-move (Yjs removed its experimental one; Automerge never shipped one). Both require the same fix.

## Consequences

- **Accept the WASM cost.** Automerge ships a Rust→WASM core (hundreds of KB + async init + cold-start), vs Yjs's ~18 kB pure JS. This is the main downside. Mitigate: lazy-load on the client; watch serverless/edge cold-start on the server. *If* WASM weight ever becomes a hard constraint, the fallback is **Loro** (faster, smaller docs, native movable list — but younger).
- **Pin the version.** Automerge 3.x is churny (`getHistory` removed; change-introspection helpers shifted). Pin and budget for migrations.
- **Model z-order as keyed-map + fractional order**, not array index: elements as `{id → element}` with a per-element fractional `order` string, sorted at read time, so a reorder is a single LWW field write and concurrent moves can't duplicate. (Library-agnostic; the officially-blessed Automerge list pattern.)
- **Persist via Automerge binary** (`save`/`saveIncremental`), NOT a JSON round-trip — the old prototype's `serialiseToInfer`-to-JSON persistence discarded history/attribution. JSON snapshots remain useful as a read-model/export, not as the store of record.
- **Per-property attribution is not O(1)** in Automerge; store a `lastEditedBy` field per element if "who changed X" is a product feature.
- **Keep super-line CRDT-agnostic at the plumbing layer.** super-line should relay opaque update bytes + persist + fan out over the adapter without hard-coding Automerge, so a **Yjs binding can follow later** (broader ecosystem mindshare serves more super-line users). Automerge is the first binding, not the only one.
