# Context — super-line persisted-state (Store) + synced-state / CRDT

A glossary of the domain language for super-line's persisted-state feature. Terms only — no implementation details. Updated inline as decisions crystallise during design.

## Glossary

### Store
Resolved 2026-06-23. The **foundational persisted-state primitive** of super-line, and a pluggable seam (like a Transport or an Adapter): an interface anyone can implement, with an in-memory implementation shipped first. A Store persists **Resources** and defines a single **consistency model** (how a write mutates a Resource's `data`). The CRDT **Shared Document** is *one* Store implementation (`data` = opaque CRDT bytes, merged) — not a separate feature. *"One plumbing, two consistency models":* a last-writer-wins `MemoryStore` and a merging `CrdtStore` are siblings behind the same interface. Distinct from a **Topic** (fire-and-forget broadcast, no state) and from per-connection **data** (scratch state lost on disconnect). (NB: "store" was previously used informally to mean the persistence `Map` in the synced-canvas examples, and `PresenceStore` in core — this promotes it to a first-class term; those usages must be disambiguated.)

### Resource
The unit a Store persists: `{ id: string, accessRules, data: JSON }`. `id` is a unique record id. `accessRules` gate which participants may read/write. `data` is the JSON payload (for a `CrdtStore`, opaque merge bytes). (Shape and identity of the accessRules key — see Open question on identity — still to resolve.)

### Change
Resolved 2026-06-23. What a Store emits when a Resource mutates, and the symmetric shape a write carries IN: `{ id, update, origin }`. `update` is a **store-defined opaque payload** — a CRDT delta for a `CrdtStore`, the full JSON value for a last-writer-wins store. super-line **never parses `update`** (relays it like transport/adapter bytes; base64 under the JSON serializer). `origin` is the writer id used for **echo-break** (don't bounce a writer's own change back into its replica). Mirrors the opaque-relay pattern already in `docs/guide/synced-state.md`. NB: super-store's in-process callback is payload-less (`subscribe(() => void)` + re-read); the networked Store needs the payload + origin that callback lacks.

### super-store (the CRDT engine, two layers down)
A separate WIP library at `/Users/mertdogar/Workspace/personal/super-store` (`@super-store/store`): a single Yjs-backed reactive primitive `StoreValue<T>` (one value, `set`/`update`, payload-less `subscribe`+`getSnapshot`, opt-in undo, Yjs convergence). **Not** a super-line Store — no `id`/`accessRules`/collection/list/ACL/cross-node. It is the **engine a future `CrdtStore` implementation of super-line's Store interface will wrap** to hold one Resource's `data`. Layering: super-line `Store` → `CrdtStore` impl → `super-store StoreValue`.

### Shared Document
A named, server-persisted, JSON-projectable state object that the server and one or more clients all read and write **concurrently**, merged via a CRDT. **Now framed as a CRDT Store implementation** (the merging consistency model), not a standalone primitive. The unit of synchronisation. Distinct from a **Topic** (fire-and-forget broadcast, no state) and from per-connection **data** (scratch state lost on disconnect).

### Co-writer
A participant — the server *or* a client — permitted to mutate a Shared Document. In this design **both the server and clients are co-writers with equal write reach**: there is no partition, either party may mutate any field. (Resolved 2026-06-23: user confirmed both parties mutate anywhere in the state, no server-owned vs client-owned regions.)

### Reactive authority (the chosen meaning of "server-authoritative" for a Shared Document)
Resolved 2026-06-23. The server, as the hub all clients sync through, observes the *merged* state and may emit a *compensating* mutation to correct invalid/unauthorised state, always getting the last word. Eventually-consistent: there is a brief window where a "bad" value is visible before correction. Chosen over **Preventive** authority (per-mutation veto), which a CRDT cannot provide — an update is an atomic op-set that cannot be partially rejected. Acceptable here because the state is a design canvas, not money/permissions ("we can tolerate minor issues").

### Scene
The concrete first Shared Document: an OMMA **`Scene`** (`@omma/schema/scene`) — a design canvas (viewport + design elements + media + datasources), persisted today as a `_snapshot.json` content-version blob (GCS/Omma REST), keyed by `sceneUUID`. The unit of co-editing.

### AI agent (the "server" co-writer)
In this project the server-side Co-writers are the **AI agents** (Mastra `chatWorkflow` runs) that edit the Scene as they work. The client Co-writers are the **humans** editing the same Scene on the canvas. Topology (resolved 2026-06-23): **N humans + N AI agents** co-edit one Scene (true multiplayer). Each writer — human connection or agent run — is a distinct CRDT peer with its own actor/client id; ids are never shared (sharing corrupts merge). The agent's edit API is **already granular** (`create`/`updateElement`/`deleteElements`/`reorderElements`, wrapped in `scene.transaction()`), which maps 1:1 onto CRDT mutations.

### Element
A node in a Scene with a **stable string `id`** (e.g. `T_abc123`). Elements live in a **positional array** (`SceneSource.elements[]`); Containers hold child Elements in their own array (`container.value.data.children[]`). Identity is the `id`; *position* in the array is separate state (see Z-order).

### Z-order
The front-to-back stacking of Elements, encoded today as **array index** (last = front-most). This makes z-order a *positional/move* concern, which is the single CRDT operation that needs deliberate modeling — concurrent reordering is the classic CRDT weakness. (Open: model as list-with-move vs keyed-map + fractional-index order field.)

### Reactive validation (compensating change)
The mechanism by which a server Co-writer enforces a rule on a Shared Document: observe the merged state, and if it violates an invariant, emit a *new* (compensating) change that corrects it. The expression of [[Reactive authority]] in practice. The agent's edits and these compensations are the same kind of operation — both are just changes by the server peer.

### Order key (fractional index)
A per-Element string that encodes [[Z-order]] independently of array position, sorted lexicographically at read time. A reorder is a single last-writer-wins write to one Element's order key, so concurrent moves can't duplicate/lose an element. Replaces "z-order = array index" because no CRDT has a safe native list-move.

## Open questions (in dependency order)
1. ~~**CRDT choice**~~ → **RESOLVED: Automerge (3.x)**. See `docs/adr/0001-automerge-over-yjs-for-synced-scene-state.md`. (The removed `SceneDocStore` in `tomorrow-kits` was production-shaped and dropped for priorities, not a technical blocker.)
2. **Agent residency**: do AI agents run in-process with the canonical doc (mutate it directly via `change()`) or in separate workers/nodes (remote peers syncing over the adapter)? *Now active.*
3. ~~**Z-order modeling**~~ → **RESOLVED on paper**: keyed map `{id → Element}` + per-Element [[Order key (fractional index)]]. Library-agnostic.
4. **Persistence reconciliation**: the live CRDT doc vs the existing whole-JSON `scene.json` / content-version store — which is canonical, when does the doc hydrate/persist, versioning.
5. **Persistence medium abstraction**: pluggable server-side store ("a db or in memory").
6. **Surface in super-line**: new wire pattern vs built on topics + requests; how a client opens/syncs a doc keyed by `sceneUUID`.
7. **Awareness/presence**: cursors/selection/who's-editing — CRDT awareness vs super-line's existing presence directory.
8. **Multiplayer undo**: today's full-snapshot serial undo (`history.ts`) breaks under multiplayer; needs per-actor undo.
9. **Playground scope**: what the example repo demonstrates first.
